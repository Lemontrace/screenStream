# screenStream (UDP -> HLS -> HTTP)

This Node.js + Express app ingests an MPEG-TS stream over UDP (from `ffmpeg` screen capture),
converts it to HLS segments with `ffmpeg`, and serves the HLS playlist over HTTP.

## Prereqs

- Node.js 18+ (Node 20+ recommended)
- `ffmpeg` installed and in `PATH`

## Install

```bash
npm install
```

## 1) Start the HTTP server (and UDP->HLS restream)

Default settings:

- UDP ingest: `udp://0.0.0.0:5555`
- HTTP port: `7777`
- Fixed token: `6f3a9c2d4e8b1a7d9f0c5b3e2a1d4f6b`

```bash
npm start
```

### One-process mode (capture screen + UDP + HLS)

If you want this app to also do the local screen capture (so you don't run a separate `ffmpeg`),
enable capture with `CAPTURE=1`. By default it captures via X11 and sends to a local UDP port that
the server ingests.

```bash
CAPTURE=1 npm start
```

Common options:

```bash
# X11 (default)
CAPTURE=1 CAPTURE_MODE=x11 CAPTURE_X11_DISPLAY=":0.0" CAPTURE_SIZE=1920x1080 CAPTURE_FPS=30 npm start

# Wayland (PipeWire)
CAPTURE=1 CAPTURE_MODE=pipewire CAPTURE_PIPEWIRE_NODE=0 CAPTURE_SIZE=1920x1080 CAPTURE_FPS=30 npm start
```

Check status:

```bash
curl http://localhost:7777/health
```

Open (fixed token paths):

- Player page: `http://localhost:7777/6f3a9c2d4e8b1a7d9f0c5b3e2a1d4f6b/player`
- HLS playlist: `http://localhost:7777/6f3a9c2d4e8b1a7d9f0c5b3e2a1d4f6b/hls/index.m3u8`

To change token:

```bash
STREAM_TOKEN=my-fixed-token npm start
```

## 2) Capture screen and send MPEG-TS over UDP (on capture machine)

### X11

```bash
ffmpeg -f x11grab -video_size 1920x1080 -framerate 30 -i :0.0 \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -f mpegts "udp://SERVER_IP:5000?pkt_size=1316"
```

### Wayland

Wayland capture varies by desktop; PipeWire often works:

```bash
ffmpeg -f pipewire -i 0 \
  -c:v libx264 -preset veryfast -tune zerolatency -pix_fmt yuv420p \
  -g 60 -keyint_min 60 -sc_threshold 0 \
  -f mpegts "udp://SERVER_IP:5000?pkt_size=1316"
```

## 3) Listen to the UDP stream (optional)

```bash
ffplay -fflags nobuffer -flags low_delay -framedrop "udp://SERVER_IP:5000?fifo_size=1000000&overrun_nonfatal=1"
```

## Notes / Troubleshooting

- If HLS generation fails with `-c:v copy`, switch to re-encode:

```bash
VIDEO_MODE=encode npm start
```

- Change UDP input URL:

```bash
UDP_URL="udp://0.0.0.0:5000?fifo_size=1000000&overrun_nonfatal=1" npm start
```

- Change HTTP port:

```bash
PORT=8090 npm start
```
