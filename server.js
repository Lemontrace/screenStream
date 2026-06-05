import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import express from "express";
import "dotenv/config";

const app = express();

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC = path.join(process.cwd(), "public");
const HLS_PORT = Number(process.env.HLS_PORT || 7778); // plain HTTP

// Admin auth — always override ADMIN_PASSWORD via env in production
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) {
  console.error("[error] ADMIN_PASSWORD is not set");
  process.exit(1);
}

// TLS — paths to self-signed cert and key (generate with openssl, see README)
const TLS_CERT = process.env.TLS_CERT || "cert.pem";
const TLS_KEY = process.env.TLS_KEY || "key.pem";

// SRT input from OBS
// Set SRT_PASSPHRASE in .env — without it the stream is unauthenticated
const SRT_PASSPHRASE = process.env.SRT_PASSPHRASE || "";
if (!SRT_PASSPHRASE) {
  console.warn("[warn] SRT_PASSPHRASE is not set — stream is unauthenticated");
}
const SRT_LATENCY = Number(process.env.SRT_LATENCY || "120"); // ms receiver buffer
const SRT_URL =
  process.env.SRT_URL ||
  `srt://0.0.0.0:5555?mode=listener&pbkeylen=32&latency=${SRT_LATENCY}${SRT_PASSPHRASE ? `&passphrase=${SRT_PASSPHRASE}` : ""}`;

// HLS output
const HLS_DIR = process.env.HLS_DIR || path.join(PUBLIC, "hls");
const PLAYLIST = process.env.PLAYLIST || "index.m3u8";

// HLS tuning — 1s segments target low glass-to-glass latency in the browser
const HLS_TIME = process.env.HLS_TIME || "1";
const HLS_LIST_SIZE = process.env.HLS_LIST_SIZE || "5";
// Extra segments kept on disk beyond the playlist before FFmpeg deletes them
const HLS_DELETE_THRESHOLD = process.env.HLS_DELETE_THRESHOLD || "4";

// Orphan cleanup — only when idle; FFmpeg delete_segments handles live cleanup
const HLS_MAX_SEGMENTS = Number(process.env.HLS_MAX_SEGMENTS || "60");
const HLS_CLEAN_INTERVAL_MS = Number(process.env.HLS_CLEAN_INTERVAL_MS || "0");

// Video mode (ignored when filler frames are on — filler requires re-encode)
const VIDEO_MODE = process.env.VIDEO_MODE || "copy"; // "copy" | "encode"

// Filler — black video + silence while SRT is down or between frames
const FILLER_FRAMES = process.env.FILLER_FRAMES !== "0";
const FILLER_WIDTH = Number(process.env.FILLER_WIDTH || "1920");
const FILLER_HEIGHT = Number(process.env.FILLER_HEIGHT || "1080");
const FILLER_FPS = Number(process.env.FILLER_FPS || "30");
// Set to 1 if the SRT source has no audio track (OBS audio disabled)
const FILLER_SILENCE_AUDIO = process.env.FILLER_SILENCE_AUDIO === "1";

// Input probe — must be large enough to read H.264 SPS/PPS from the first keyframe
const FFPROBE_SIZE = process.env.FFPROBE_SIZE || "1048576"; // 1 MB
const FFANALYZE_DURATION = process.env.FFANALYZE_DURATION || "1000000"; // 1s (µs)

// ---------------------------------------------------------------------------
// Stream state
// ---------------------------------------------------------------------------
let streamToken = null; // null = stopped; hex string = live
let ffmpegChild = null;

function generateToken() {
  return crypto.randomBytes(16).toString("hex");
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
  // Prune expired sessions so the map doesn't grow indefinitely
  const cutoff = Date.now() - 8 * 60 * 60 * 1000;
  for (const [sid, s] of sessions) {
    if (s.createdAt < cutoff) sessions.delete(sid);
  }
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

function isHlsSegment(name) {
  return name.endsWith(".ts") || name === PLAYLIST;
}

function clearSegmentsOnStart() {
  try {
    for (const name of fs.readdirSync(HLS_DIR)) {
      if (!isHlsSegment(name)) continue;
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
  // Never delete segments while FFmpeg is writing — races cause 404s and playback hiccups.
  if (ffmpegChild) return;
  if (!Number.isFinite(HLS_MAX_SEGMENTS) || HLS_MAX_SEGMENTS <= 0) return;
  fs.readdir(HLS_DIR, (err, files) => {
    if (err) return;
    const segFiles = files.filter((f) => f.endsWith(".ts"));
    if (segFiles.length <= HLS_MAX_SEGMENTS) return;
    const withStats = segFiles
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

function hlsOutputArgs() {
  return [
    "-muxdelay",
    "0",
    "-muxpreload",
    "0",
    "-f",
    "hls",
    "-hls_time",
    String(HLS_TIME),
    "-hls_list_size",
    String(HLS_LIST_SIZE),
    "-hls_delete_threshold",
    String(HLS_DELETE_THRESHOLD),
    "-hls_flags",
    "delete_segments+append_list+independent_segments",
    "-hls_segment_filename",
    path.join(HLS_DIR, "seg_%06d.ts"),
    path.join(HLS_DIR, PLAYLIST),
  ];
}

function encodeVideoArgs() {
  return [
    "-c:v",
    "libx264",
    "-preset",
    "veryfast",
    "-tune",
    "zerolatency",
    "-pix_fmt",
    "yuv420p",
    "-g",
    String(FILLER_FPS),
    "-keyint_min",
    String(FILLER_FPS),
    "-sc_threshold",
    "0",
  ];
}

function buildFfmpegArgs() {
  const commonInput = [
    "-hide_banner",
    "-loglevel",
    "warning",
    "-fflags",
    "nobuffer+flush_packets",
    "-flags",
    "low_delay",
    "-probesize",
    FFPROBE_SIZE,
    "-analyzeduration",
    FFANALYZE_DURATION,
  ];

  if (!FILLER_FRAMES) {
    const videoArgs =
      VIDEO_MODE === "encode" ? encodeVideoArgs() : ["-c:v", "copy"];
    const audioArgs =
      VIDEO_MODE === "encode"
        ? ["-c:a", "aac", "-b:a", "128k"]
        : ["-c:a", "copy"];

    return [
      ...commonInput,
      "-i",
      SRT_URL,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0",
      ...videoArgs,
      ...audioArgs,
      ...hlsOutputArgs(),
    ];
  }

  const w = FILLER_WIDTH;
  const h = FILLER_HEIGHT;
  const fps = FILLER_FPS;

  // Lavfi base runs continuously; SRT is composited when available.
  // fps+repeatlast keeps the last live frame during short stalls; eof_action=pass
  // falls back to black when SRT disconnects.
  const liveVideo = [
    `[2:v]fps=${fps},format=yuv420p,`,
    `scale=${w}:${h}:force_original_aspect_ratio=decrease,`,
    `pad=${w}:${h}:(ow-iw)/2:(oh-ih)/2:color=black,`,
    `setpts=PTS-STARTPTS[livev]`,
  ].join("");

  const overlay =
    `[0:v][livev]overlay=shortest=0:eof_action=pass:repeatlast=1[v]`;

  const audioChains = FILLER_SILENCE_AUDIO
    ? ["[1:a]asetpts=PTS-STARTPTS[a]"]
    : [
        "[2:a]asetpts=PTS-STARTPTS,aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo[livea]",
        "[1:a][livea]amix=inputs=2:duration=longest:dropout_transition=0[a]",
      ];

  const filter = [liveVideo, overlay, ...audioChains].join(";");

  return [
    ...commonInput,
    "-f",
    "lavfi",
    "-i",
    `color=c=black:s=${w}x${h}:r=${fps}`,
    "-f",
    "lavfi",
    "-i",
    "anullsrc=r=48000:cl=stereo",
    "-thread_queue_size",
    "1024",
    "-i",
    SRT_URL,
    "-filter_complex",
    filter,
    "-map",
    "[v]",
    "-map",
    "[a]",
    ...encodeVideoArgs(),
    "-c:a",
    "aac",
    "-b:a",
    "128k",
    ...hlsOutputArgs(),
  ];
}

function startFfmpeg() {
  ensureDir(HLS_DIR);
  clearSegmentsOnStart();

  ffmpegChild = spawn("ffmpeg", buildFfmpegArgs(), {
    stdio: ["ignore", "inherit", "inherit"],
  });

  ffmpegChild.on("exit", (code, signal) => {
    ffmpegChild = null;
    if (shuttingDown || streamToken === null) return;
    const reason =
      code === 0
        ? "input disconnected (OBS stopped or SRT dropped)"
        : `code=${code}, signal=${signal}`;
    console.warn(`[ffmpeg] exited (${reason}), restarting in 1s`);
    setTimeout(startFfmpeg, 1000);
  });
}

function stopFfmpeg() {
  if (!ffmpegChild) return;
  const child = ffmpegChild;
  ffmpegChild = null;
  child.kill("SIGTERM");
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      /* already exited */
    }
    clearSegmentsOnStart();
  }, 1500);
}

// ---------------------------------------------------------------------------
// Login rate limiter (in-memory, no dependency)
// Max 10 attempts per IP per 15 minutes
// ---------------------------------------------------------------------------
const loginAttempts = new Map();
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 10;

function rateLimitLogin(req, res, next) {
  const ip =
    req.headers["x-forwarded-for"]?.split(",")[0].trim() ??
    req.socket.remoteAddress;
  const now = Date.now();
  const entry = loginAttempts.get(ip) ?? { count: 0, windowStart: now };

  if (now - entry.windowStart > RATE_LIMIT_WINDOW_MS) {
    entry.count = 0;
    entry.windowStart = now;
  }

  entry.count++;
  loginAttempts.set(ip, entry);

  // Prune stale IPs every 100 entries
  if (loginAttempts.size % 100 === 0) {
    for (const [k, v] of loginAttempts) {
      if (now - v.windowStart > RATE_LIMIT_WINDOW_MS) loginAttempts.delete(k);
    }
  }

  if (entry.count > RATE_LIMIT_MAX) {
    const retryAfter = Math.ceil(
      (RATE_LIMIT_WINDOW_MS - (now - entry.windowStart)) / 1000,
    );
    res.setHeader("Retry-After", retryAfter);
    return res.status(429).send("Too many login attempts. Try again later.");
  }

  next();
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------
app.use(parseCookies);
app.use(express.urlencoded({ extended: false, limit: "1kb" }));
app.use(express.json({ limit: "1kb" }));

// ---------------------------------------------------------------------------
// Admin routes
// ---------------------------------------------------------------------------
app.get("/admin/login", (req, res) => {
  if (req.cookies?.session && isValidSession(req.cookies.session))
    return res.redirect("/admin");
  res.sendFile(path.join(PUBLIC, "login.html"));
});

app.post("/admin/login", rateLimitLogin, (req, res) => {
  if (req.body.password !== ADMIN_PASSWORD) {
    return res.redirect(
      "/admin/login?error=" + encodeURIComponent("Incorrect password."),
    );
  }
  const sid = createSession();
  res.setHeader(
    "Set-Cookie",
    `session=${sid}; HttpOnly; Secure; SameSite=Strict; Path=/`,
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
  const hlsPath = streamToken
    ? `${hlsBasePath(streamToken)}/${PLAYLIST}`
    : null;
  res.json({
    running: Boolean(ffmpegChild),
    token: streamToken,
    hlsHttpUrl: hlsPath ? `http://${req.hostname}:${HLS_PORT}${hlsPath}` : null,
    hlsHttpsUrl: hlsPath ? `https://${req.hostname}:${PORT}${hlsPath}` : null,
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
// HLS file serving
// ---------------------------------------------------------------------------

function safeHlsFilename(name) {
  const base = path.basename(name);
  if (base === PLAYLIST) return base;
  if (/^seg_\d+\.ts$/.test(base)) return base;
  return null;
}

function sendHlsFile(filename, res) {
  const safe = safeHlsFilename(filename);
  if (!safe) return res.status(404).end();
  const full = path.join(HLS_DIR, safe);
  if (!fs.existsSync(full)) return res.status(404).end();
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate");
  if (safe.endsWith(".m3u8")) {
    res.setHeader("Content-Type", "application/vnd.apple.mpegurl");
  } else {
    res.setHeader("Content-Type", "video/mp2t");
  }
  res.sendFile(full);
}

app.get("/:token/hls/:file", (req, res) => {
  if (!streamToken || req.params.token !== streamToken)
    return res.status(404).end();
  sendHlsFile(req.params.file, res);
});

// ---------------------------------------------------------------------------
// Health
// ---------------------------------------------------------------------------
app.get("/health", (req, res) => {
  res.json({
    ok: true,
    ffmpegRunning: Boolean(ffmpegChild),
    streamActive: streamToken !== null,
    videoMode: FILLER_FRAMES ? "encode" : VIDEO_MODE,
    fillerFrames: FILLER_FRAMES,
  });
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------
let tlsOptions;
try {
  tlsOptions = {
    cert: fs.readFileSync(TLS_CERT),
    key: fs.readFileSync(TLS_KEY),
  };
} catch (err) {
  console.error(`[tls] Failed to load cert/key: ${err.message}`);
  console.error(
    `[tls] Generate with: openssl req -x509 -newkey rsa:4096 -keyout key.pem -out cert.pem -days 365 -nodes -subj "/CN=localhost"`,
  );
  process.exit(1);
}

const adminServer = https.createServer(tlsOptions, app).listen(PORT, HOST);

// Minimal HTTP app — public HLS only (no admin routes)
const hlsApp = express();
hlsApp.get("/:token/hls/:file", (req, res) => {
  if (!streamToken || req.params.token !== streamToken)
    return res.status(404).end();
  sendHlsFile(req.params.file, res);
});

const hlsServer = http.createServer(hlsApp).listen(HLS_PORT, HOST, () => {
  console.log(
    `[hls] mpegts · ${HLS_TIME}s segments · playlist ${HLS_LIST_SIZE}` +
      (FILLER_FRAMES ? ` · filler ${FILLER_WIDTH}x${FILLER_HEIGHT}@${FILLER_FPS}fps` : ""),
  );
  if (HLS_CLEAN_INTERVAL_MS > 0)
    setInterval(cleanupOldSegments, HLS_CLEAN_INTERVAL_MS);
});

let shuttingDown = false;
function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("Shutting down…");
  adminServer.close();
  hlsServer.close(() => process.exit(0));
  stopFfmpeg();
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
