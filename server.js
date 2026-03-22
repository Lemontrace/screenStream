import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import express from "express";

const app = express();

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC = path.join(process.cwd(), "public");

// Admin auth — always override ADMIN_PASSWORD via env in production
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "changeme";

// UDP input carrying MPEG-TS
const UDP_URL =
  process.env.UDP_URL ||
  "udp://0.0.0.0:5555?fifo_size=1000000&overrun_nonfatal=1";

// HLS output
const HLS_DIR = process.env.HLS_DIR || path.join(PUBLIC, "hls");
const PLAYLIST = process.env.PLAYLIST || "index.m3u8";

// HLS tuning
const HLS_TIME = process.env.HLS_TIME || "2";
const HLS_LIST_SIZE = process.env.HLS_LIST_SIZE || "3";

// Segment cleanup
const HLS_MAX_SEGMENTS = Number(process.env.HLS_MAX_SEGMENTS || "60");
const HLS_CLEAN_INTERVAL_MS = Number(
  process.env.HLS_CLEAN_INTERVAL_MS || "15000",
);

// Video mode
const VIDEO_MODE = process.env.VIDEO_MODE || "copy"; // "copy" | "encode"

// ---------------------------------------------------------------------------
// Stream state
// ---------------------------------------------------------------------------
let streamToken = null; // null = stopped; hex string = live
let ffmpegChild = null;

function generateToken() {
  return crypto.randomBytes(16).toString("hex");
}

function playerPath(token) {
  return `/${token}/player`;
}
function hlsBasePath(token) {
  return `/${token}/hls`;
}

// ---------------------------------------------------------------------------
// Session store (in-memory, single-user)
// ---------------------------------------------------------------------------
const sessions = new Map();

function createSession() {
  const id = crypto.randomBytes(32).toString("hex");
  sessions.set(id, { createdAt: Date.now() });
  return id;
}

function isValidSession(id) {
  const session = sessions.get(id);
  if (!session) return false;
  // expire after 8 hours
  if (Date.now() - session.createdAt > 8 * 60 * 60 * 1000) {
    sessions.delete(id);
    return false;
  }
  return true;
}

function requireAuth(req, res, next) {
  const sid = req.cookies?.session;
  if (sid && isValidSession(sid)) return next();
  res.redirect("/admin/login");
}

// ---------------------------------------------------------------------------
// Cookie parser (no extra dependency)
// ---------------------------------------------------------------------------
function parseCookies(req, res, next) {
  req.cookies = {};
  const header = req.headers.cookie;
  if (header) {
    for (const part of header.split(";")) {
      const [k, ...v] = part.trim().split("=");
      req.cookies[k.trim()] = decodeURIComponent(v.join("="));
    }
  }
  next();
}

// ---------------------------------------------------------------------------
// FFmpeg helpers
// ---------------------------------------------------------------------------
function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function clearSegmentsOnStart() {
  try {
    for (const name of fs.readdirSync(HLS_DIR)) {
      if (!name.endsWith(".ts") && name !== PLAYLIST) continue;
      try {
        fs.unlinkSync(path.join(HLS_DIR, name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* ignore */
  }
}

function cleanupOldSegments() {
  if (!Number.isFinite(HLS_MAX_SEGMENTS) || HLS_MAX_SEGMENTS <= 0) return;
  fs.readdir(HLS_DIR, (err, files) => {
    if (err) return;
    const tsFiles = files.filter((f) => f.endsWith(".ts"));
    if (tsFiles.length <= HLS_MAX_SEGMENTS) return;
    const withStats = tsFiles
      .map((name) => {
        const full = path.join(HLS_DIR, name);
        try {
          return { full, mtimeMs: fs.statSync(full).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const f of withStats.slice(0, withStats.length - HLS_MAX_SEGMENTS)) {
      try {
        fs.unlinkSync(f.full);
      } catch {
        /* ignore */
      }
    }
  });
}

function startFfmpeg() {
  ensureDir(HLS_DIR);
  clearSegmentsOnStart();

  const inputArgs = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "nobuffer",
    "-flags",
    "low_delay",
    "-i",
    UDP_URL,
    "-map",
    "0:v:0",
    "-map",
    "0:a:0",
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

  const audioArgs = ["-c:a", "aac", "-b:a", "256k"];

  const outputArgs = [
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

  ffmpegChild = spawn(
    "ffmpeg",
    [...inputArgs, ...videoArgs, ...audioArgs, ...outputArgs],
    {
      stdio: ["ignore", "inherit", "inherit"],
    },
  );

  ffmpegChild.on("exit", (code, signal) => {
    ffmpegChild = null;
    if (shuttingDown || streamToken === null) return;
    console.error(
      `[ffmpeg] exited (code=${code}, signal=${signal}), restarting in 1s`,
    );
    setTimeout(startFfmpeg, 1000);
  });
}

function stopFfmpeg() {
  if (!ffmpegChild) return;
  ffmpegChild.kill("SIGTERM");
  setTimeout(() => ffmpegChild?.kill("SIGKILL"), 1500);
  ffmpegChild = null;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(parseCookies);
app.use(express.urlencoded({ extended: false }));
app.use(express.json());

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------
app.get("/admin/login", (req, res) => {
  if (req.cookies?.session && isValidSession(req.cookies.session))
    return res.redirect("/admin");
  res.sendFile(path.join(PUBLIC, "login.html"));
});

app.post("/admin/login", (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.redirect(
      "/admin/login?error=" + encodeURIComponent("Incorrect password."),
    );
  }
  const sid = createSession();
  res.setHeader(
    "Set-Cookie",
    `session=${sid}; HttpOnly; SameSite=Strict; Path=/`,
  );
  res.redirect("/admin");
});

app.post("/admin/logout", (req, res) => {
  sessions.delete(req.cookies?.session);
  res.setHeader(
    "Set-Cookie",
    "session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0",
  );
  res.redirect("/admin/login");
});

app.get("/admin", requireAuth, (req, res) => {
  res.sendFile(path.join(PUBLIC, "admin.html"));
});

app.get("/admin/status", requireAuth, (req, res) => {
  res.json({
    running: Boolean(ffmpegChild),
    token: streamToken,
    playerUrl: streamToken ? playerPath(streamToken) : null,
    hlsUrl: streamToken ? `${hlsBasePath(streamToken)}/${PLAYLIST}` : null,
  });
});

app.post("/admin/start", requireAuth, (req, res) => {
  if (ffmpegChild) return res.json({ ok: false, error: "Already running." });
  streamToken = generateToken();
  startFfmpeg();
  console.log(`[stream] started — token: ${streamToken}`);
  res.json({ ok: true, token: streamToken });
});

app.post("/admin/stop", requireAuth, (req, res) => {
  if (!ffmpegChild) return res.json({ ok: false, error: "Not running." });
  stopFfmpeg();
  streamToken = null;
  console.log("[stream] stopped.");
  res.json({ ok: true });
});

// ---------------------------------------------------------------------------
// Public stream routes (token-gated, dynamic)
// ---------------------------------------------------------------------------

// HLS segments — only served when token matches
app.use((req, res, next) => {
  if (!streamToken) return next();
  const base = hlsBasePath(streamToken);
  if (!req.path.startsWith(base + "/")) return next();
  req.url = req.path.slice(base.length);
  express.static(HLS_DIR, { etag: false })(req, res, next);
});

// Player page — only served when token matches
app.get("/:token/player", (req, res, next) => {
  if (!streamToken || req.params.token !== streamToken) return next();
  res.sendFile(path.join(PUBLIC, "player.html"));
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    ffmpegRunning: Boolean(ffmpegChild),
    streamActive: streamToken !== null,
    udpUrl: UDP_URL,
    videoMode: VIDEO_MODE,
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
const server = app.listen(PORT, HOST, () => {
  console.log(`Listening on http://${HOST}:${PORT}`);
  console.log(`Admin panel:  http://${HOST}:${PORT}/admin`);
  if (HLS_CLEAN_INTERVAL_MS > 0)
    setInterval(cleanupOldSegments, HLS_CLEAN_INTERVAL_MS);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down…");
  server.close(() => process.exit(0));
  stopFfmpeg();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
