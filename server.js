import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import express from "express";
import "dotenv/config";

const app = express(); // HTTPS — admin only
const hlsApp = express(); // HTTP  — public HLS segments

const PORT = Number(process.env.PORT || 7777);
const HOST = process.env.HOST || "0.0.0.0";
const PUBLIC = path.join(process.cwd(), "public");
const HLS_PORT = Number(process.env.HLS_PORT || 7778); // plain HTTP, public

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
const SRT_URL =
  process.env.SRT_URL ||
  `srt://0.0.0.0:5555?mode=listener&pbkeylen=32${SRT_PASSPHRASE ? `&passphrase=${SRT_PASSPHRASE}` : ""}`;

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
    SRT_URL,
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
  res.json({
    running: Boolean(ffmpegChild),
    token: streamToken,
    hlsUrl: streamToken ? `${hlsBasePath(streamToken)}/${PLAYLIST}` : null,
    hlsPort: HLS_PORT,
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
// Public stream routes — served on plain HTTP (hlsApp)
// ---------------------------------------------------------------------------

// HLS segments — only served when token matches
hlsApp.use((req, res, next) => {
  if (!streamToken) return next();
  const base = hlsBasePath(streamToken);
  if (!req.path.startsWith(base + "/")) return next();
  req.url = req.path.slice(base.length);
  express.static(HLS_DIR, { etag: false })(req, res, next);
});

// ---------------------------------------------------------------------------
// Health (on HTTP server — no auth needed)
// ---------------------------------------------------------------------------
hlsApp.get("/health", (req, res) => {
  res.json({
    ok: true,
    ffmpegRunning: Boolean(ffmpegChild),
    streamActive: streamToken !== null,
    videoMode: VIDEO_MODE,
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

const adminServer = https
  .createServer(tlsOptions, app)
  .listen(PORT, HOST, () => {
    console.log(`Admin (HTTPS): https://${HOST}:${PORT}/admin`);
  });

const hlsServer = http.createServer(hlsApp).listen(HLS_PORT, HOST, () => {
  console.log(`HLS   (HTTP):  http://${HOST}:${HLS_PORT}`);
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
