# 🧲 Torrent Search & Streamer

A full-stack web application to **search torrents across multiple providers** and **stream video files directly in your browser** — with real-time provider logs, a live cancel button, built-in video player, subtitle support, and optional VLC integration.

---

## ✨ Features

### 🔍 Torrent Search
- Search across **5 providers** simultaneously: ThePirateBay, 1337x, Torrentz2, Eztv, Yts
- **Real-time terminal log panel** — watch provider attempts stream live in the browser as they happen
- **Cancel search** at any time with the ✕ Cancel button; server stops mid-search instantly
- Results sorted by seeds by default; re-sortable by Seeds, Peers, Size, or Name
- IMDB poster image fetched automatically for matched results
- One-click **Copy Magnet** or **▶️ Stream** directly from results

### ▶️ Stream Dashboard
- Add magnet links to start streaming immediately via **WebTorrent**
- Built-in **HTML5 video player** with range-request support for smooth seeking
- **Subtitle support**: embedded tracks (via FFmpeg), `.srt`/`.ass`/`.vtt` file upload, or URL
- Real-time torrent stats: download speed, peers, progress bar
- **Pause / Resume / Stop & Remove** active torrents
- Streams persist across server restarts (saved to `active_streams.json`)
- Optional **VLC launch** for local playback

---

## 🚀 Getting Started

### Prerequisites
- [Node.js](https://nodejs.org/) v18+
- npm

### Installation

```bash
git clone <your-repo-url>
cd TorrentApi
npm install
```

### Running

```bash
npm start
# or
node index.js
```

Open your browser at **http://localhost:3000**

---

## 🐳 Docker

```bash
# Build
docker build -t torrent-streamer .

# Run
docker run -p 3000:3000 torrent-streamer
```

The container exposes port `3000` by default. Override with the `PORT` environment variable:

```bash
docker run -e PORT=8080 -p 8080:8080 torrent-streamer
```

---

## 📡 API Reference

### Search

| Method | Endpoint | Description |
|--------|----------|-------------|
| `GET` | `/search/stream/:query` | **SSE stream** — real-time logs + final results as Server-Sent Events |

**SSE Events emitted:**

| Event | Payload | Description |
|-------|---------|-------------|
| `log` | `{ level, message, timestamp }` | Live provider log line (`INFO`, `WARN`, `SUCCESS`, `ERROR`) |
| `results` | `{ data: Torrent[] }` | Final list of torrents on success |
| `error` | `{ error: string }` | All providers failed or no results |
| `cancelled` | `{ message }` | Client disconnected / search cancelled |

---

### Streaming

| Method | Endpoint | Description |
|--------|----------|-------------|
| `POST` | `/api/stream/add` | Add a magnet link and fetch metadata |
| `GET` | `/api/stream` | List all active torrents |
| `GET` | `/api/stream/:infoHash/files` | Get file list for a torrent |
| `GET` | `/api/stream/:infoHash/stream/:fileIndex` | Stream a file (range-request supported) |
| `GET` | `/api/stream/:infoHash/subtitle/:fileIndex` | Serve subtitle file converted to WebVTT |
| `GET` | `/api/stream/:infoHash/embedded-sub/:fileIndex/:trackIndex` | Extract embedded subtitle via FFmpeg |
| `GET` | `/api/stream/:infoHash/probe-subs/:fileIndex` | Probe embedded subtitle tracks with ffprobe |
| `GET` | `/api/stream/:infoHash/stats` | Get live stats for a torrent |
| `POST` | `/api/stream/:infoHash/pause` | Pause a torrent |
| `POST` | `/api/stream/:infoHash/resume` | Resume a paused torrent |
| `DELETE` | `/api/stream/:infoHash` | Stop and remove a torrent |
| `POST` | `/api/stream/:infoHash/play-vlc/:fileIndex` | Launch VLC locally for a stream |

---

## 🗂️ Project Structure

```
TorrentApi/
├── index.js              # Express server — search (SSE), streaming, subtitle, VLC APIs
├── ScrapeImdb.js         # Scrapes poster images from IMDB for matched results
├── public/
│   └── index.html        # Single-page frontend (HTML + CSS + JS, no framework)
├── active_streams.json   # Persisted active torrents (auto-managed, git-ignored)
├── Dockerfile            # Docker image (node:lts-alpine3.19)
├── package.json
└── .gitignore
```

---

## 📦 Dependencies

| Package | Purpose |
|---------|---------|
| `express` | HTTP server & routing |
| `torrent-search-api` | Multi-provider torrent search |
| `webtorrent` | BitTorrent client for streaming |
| `ffmpeg-static` | Bundled FFmpeg binary (subtitle extraction) |
| `@ffprobe-installer/ffprobe` | Bundled FFprobe binary (subtitle probing) |
| `cheerio` | HTML scraping for IMDB poster images |
| `axios` | HTTP client |
| `cors` | CORS middleware |
| `dotenv` | Environment variable support |

---

## ⚙️ Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3000` | Port the server listens on |

Create a `.env` file in the root to override:

```env
PORT=3000
```

---

## 🖥️ UI Overview

### Search Tab
- Type a query and press **Enter** or click **🔍 Search**
- A **live terminal panel** slides in below the search box, streaming provider logs in real time
- Click **✕ Cancel** to abort the search at any point
- Results display with poster, seeds, peers, size, and provider info
- Sort results by **Seeds**, **Peers**, **Size**, or **Name**

### Stream Dashboard
- Paste a magnet link and click **⚡ Load Stream**
- Active torrents appear in the left sidebar with live progress bars
- Select a torrent to view its files, stats, and controls
- Play video files directly in the browser or launch in **VLC**
- Manage subtitles (embedded tracks, file upload, or remote URL)

---

## 📝 Notes

- Torrent provider availability depends on your network/host. Some providers may be geo-blocked.
- `active_streams.json` is automatically created and excluded from git.
- The app patches global `http`/`https` agents to send a realistic browser `User-Agent` for all outgoing requests.
- Subtitle formats supported: `.srt`, `.vtt`, `.ass`, `.ssa`, `.sub` — all converted to WebVTT on-the-fly.
