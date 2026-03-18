import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import express from "express";

const app = express();

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || "0.0.0.0";

// Optional local capture -> UDP (so the app can do "capture + restream" itself)
// Enable with CAPTURE=1
const CAPTURE_ENABLED = process.env.CAPTURE === "1";
const CAPTURE_MODE = process.env.CAPTURE_MODE || "x11"; // "x11" | "pipewire"
const CAPTURE_UDP_URL =
  process.env.CAPTURE_UDP_URL || "udp://127.0.0.1:5555?pkt_size=1316";
const CAPTURE_FPS = process.env.CAPTURE_FPS || "30";
const CAPTURE_SIZE = process.env.CAPTURE_SIZE || "1920x1080";
const CAPTURE_X11_DISPLAY =
  process.env.CAPTURE_X11_DISPLAY || process.env.DISPLAY || ":0.0";
const CAPTURE_PIPEWIRE_NODE = process.env.CAPTURE_PIPEWIRE_NODE || "0";

// UDP input carrying MPEG-TS (from your capture machine)
// Example: udp://0.0.0.0:5000?fifo_size=1000000&overrun_nonfatal=1
const UDP_URL =
  process.env.UDP_URL ||
  "udp://0.0.0.0:5555?fifo_size=1000000&overrun_nonfatal=1";

// HLS output folder served over HTTP
const HLS_DIR =
  process.env.HLS_DIR || path.join(process.cwd(), "public", "hls");
const PLAYLIST = process.env.PLAYLIST || "index.m3u8";

// HLS tuning
const HLS_TIME = process.env.HLS_TIME || "1";
const HLS_LIST_SIZE = process.env.HLS_LIST_SIZE || "6";

// Extra TS cleanup (Node side), in case ffmpeg leaves old segments around.
// Keep only the newest N TS files and delete older ones.
const HLS_MAX_SEGMENTS =
  Number(process.env.HLS_MAX_SEGMENTS || "60"); // ~1 minute if HLS_TIME=1
const HLS_CLEAN_INTERVAL_MS =
  Number(process.env.HLS_CLEAN_INTERVAL_MS || "15000");

// If copy fails (timestamps/format), flip to "encode"
const VIDEO_MODE = process.env.VIDEO_MODE || "copy"; // "copy" | "encode"

let ffmpegChild = null;
let captureChild = null;

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function clearSegmentsOnStart() {
  try {
    const files = fs.readdirSync(HLS_DIR);
    for (const name of files) {
      if (!name.endsWith(".ts") && name !== PLAYLIST) continue;
      try {
        fs.unlinkSync(path.join(HLS_DIR, name));
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
}

function cleanupOldSegments() {
  if (!Number.isFinite(HLS_MAX_SEGMENTS) || HLS_MAX_SEGMENTS <= 0) return;
  fs.readdir(HLS_DIR, (err, files) => {
    if (err) return;
    const tsFiles = files.filter((f) => f.endsWith(".ts"));
    if (tsFiles.length <= HLS_MAX_SEGMENTS) return;
    const withStats = tsFiles.map((name) => {
      const full = path.join(HLS_DIR, name);
      try {
        const stat = fs.statSync(full);
        return { name, full, mtimeMs: stat.mtimeMs };
      } catch {
        return null;
      }
    }).filter(Boolean);

    withStats.sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first
    const excess = withStats.length - HLS_MAX_SEGMENTS;
    if (excess <= 0) return;
    const toDelete = withStats.slice(0, excess);
    for (const f of toDelete) {
      try {
        fs.unlinkSync(f.full);
      } catch {
        // ignore
      }
    }
  });
}

function startCapture() {
  if (!CAPTURE_ENABLED) return;
  if (captureChild) return;

  const captureInputArgs =
    CAPTURE_MODE === "pipewire"
      ? ["-f", "pipewire", "-i", String(CAPTURE_PIPEWIRE_NODE)]
      : [
          "-f",
          "x11grab",
          "-video_size",
          String(CAPTURE_SIZE),
          "-framerate",
          String(CAPTURE_FPS),
          "-i",
          String(CAPTURE_X11_DISPLAY),
        ];

  const args = [
    "-hide_banner",
    "-loglevel",
    "warning",
    ...captureInputArgs,
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-g",
    "60",
    "-keyint_min",
    "60",
    "-sc_threshold",
    "0",
    "-f",
    "mpegts",
    CAPTURE_UDP_URL,
  ];

  captureChild = spawn("ffmpeg", args, {
    stdio: ["ignore", "inherit", "inherit"],
  });

  captureChild.on("exit", (code, signal) => {
    captureChild = null;
    if (shuttingDown) return;
    console.error(
      `[capture] exited (code=${code}, signal=${signal}), restarting in 1s`,
    );
    setTimeout(startCapture, 1000);
  });
}

function startFfmpeg() {
  ensureDir(HLS_DIR);

  // Clean stale playlist and TS segments on boot
  clearSegmentsOnStart();

  const baseArgs = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-i",
    UDP_URL,
    // Avoid audio complications by default (stream is usually video-only)
    "-an",
    "-f",
    "hls",
    "-hls_time",
    String(HLS_TIME),
    "-hls_list_size",
    String(HLS_LIST_SIZE),
    "-hls_flags",
    "delete_segments+append_list+independent_segments",
    "-hls_segment_filename",
    path.join(HLS_DIR, "seg_%06d.ts"),
    path.join(HLS_DIR, PLAYLIST),
  ];

  const videoArgs =
    VIDEO_MODE === "encode"
      ? [
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-tune",
          "zerolatency",
          "-pix_fmt",
          "yuv420p",
          "-g",
          "60",
          "-keyint_min",
          "60",
          "-sc_threshold",
          "0",
        ]
      : ["-c:v", "copy"];

  const args = [...baseArgs];
  // Insert video args right after input
  args.splice(10, 0, ...videoArgs);

  ffmpegChild = spawn("ffmpeg", args, {
    stdio: ["ignore", "inherit", "inherit"],
  });

  ffmpegChild.on("exit", (code, signal) => {
    ffmpegChild = null;
    // If ffmpeg dies unexpectedly, restart (unless we’re shutting down)
    if (shuttingDown) return;
    console.error(
      `[ffmpeg] exited (code=${code}, signal=${signal}), restarting in 1s`,
    );
    setTimeout(startFfmpeg, 1000);
  });
}

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    ffmpegRunning: Boolean(ffmpegChild),
    captureRunning: Boolean(captureChild),
    captureEnabled: CAPTURE_ENABLED,
    captureMode: CAPTURE_MODE,
    captureUdpUrl: CAPTURE_UDP_URL,
    udpUrl: UDP_URL,
    videoMode: VIDEO_MODE,
    hlsDir: HLS_DIR,
    playlist: `/hls/${PLAYLIST}`,
  });
});

app.use(express.static(path.join(process.cwd(), "public"), { etag: false }));

app.get("/player", (req, res) => {
  res.sendFile(path.join(process.cwd(), "public", "player.html"));
});

const server = app.listen(PORT, HOST, () => {
  console.log(`HTTP server listening on http://${HOST}:${PORT}`);
  console.log(`HLS playlist at http://${HOST}:${PORT}/hls/${PLAYLIST}`);
  if (CAPTURE_ENABLED) {
    console.log(
      `Capture enabled (${CAPTURE_MODE}) -> ${CAPTURE_UDP_URL} (size=${CAPTURE_SIZE} fps=${CAPTURE_FPS})`,
    );
  }
  startCapture();
  startFfmpeg();
  if (HLS_CLEAN_INTERVAL_MS > 0) {
    setInterval(cleanupOldSegments, HLS_CLEAN_INTERVAL_MS);
  }
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down…");
  server.close(() => process.exit(0));
  if (ffmpegChild) {
    ffmpegChild.kill("SIGTERM");
    setTimeout(() => ffmpegChild?.kill("SIGKILL"), 1500);
  }
  if (captureChild) {
    captureChild.kill("SIGTERM");
    setTimeout(() => captureChild?.kill("SIGKILL"), 1500);
  }
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
