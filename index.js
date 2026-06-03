const express = require("express");
const bodyParser = require('body-parser');
const cors = require('cors');
const scrapeImdb = require('./ScrapeImdb.js');
const fs = require('fs');
const { exec } = require('child_process');
const path = require('path');

require("dotenv").config();

const app = express();
app.use(bodyParser.json());
app.use(cors());
app.use(express.static('public'));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/public/index.html');
});

const TorrentSearchApi = require('torrent-search-api');

const providers = ['ThePirateBay', '1337x', 'Torrentz2', 'Eztv', 'Yts']; // Add more if needed

const categories = ['All'];

async function Search(searchQuery) {
    for (const provider of providers) {
        try {
            console.log(`[INFO] Trying provider: ${provider}`);
            TorrentSearchApi.enableProvider(provider);
            let allTorrents = [];
            for (const category of categories) {
                console.log(`[INFO] Searching for "${searchQuery}" in category "${category}" on ${provider}`);
                const torrents = await TorrentSearchApi.search(searchQuery, category, 20);
                console.log(`[INFO] Found ${torrents.length} torrents from ${provider} (${category})`);
                allTorrents = [...allTorrents, ...torrents];
            }
            allTorrents.sort((a, b) => b.seeds - a.seeds);
            // Separate torrents with and without imdb
            const torrentsWithImdb = allTorrents.filter(torrent => torrent.imdb);
            const torrentsWithoutImdb = allTorrents.filter(torrent => !torrent.imdb);
            let prioritizedTorrents = [];
            if (torrentsWithImdb.length > 0) {
                console.log(`[SUCCESS] Found ${torrentsWithImdb.length} torrents with IMDB info from ${provider}`);
                torrentsWithImdb[0]["imgurl"] = await scrapeImdb.getImdbImg(torrentsWithImdb[0].imdb);
            }
            prioritizedTorrents = [...torrentsWithImdb, ...torrentsWithoutImdb];
            if (prioritizedTorrents.length > 0) {
                return prioritizedTorrents;
            } else {
                console.log(`[WARN] No torrents found from ${provider}`);
            }
        } catch (error) {
            console.error(`[ERROR] Error fetching torrents from ${provider}:`, error.message || error);
            // Try next provider
        }
    }
    // If all providers fail
    console.error('[ERROR] All providers failed or returned no results.');
    return [];
}

// Set a realistic User-Agent for all outgoing HTTP requests
const REALISTIC_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36';

// Patch global fetch if available (node-fetch v3+)
if (typeof fetch !== 'undefined') {
    const originalFetch = fetch;
    global.fetch = (url, options = {}) => {
        options.headers = options.headers || {};
        if (!options.headers['User-Agent'] && !options.headers['user-agent']) {
            options.headers['User-Agent'] = REALISTIC_USER_AGENT;
        }
        return originalFetch(url, options);
    };
}

// Patch global http(s) request for libraries using http/https
const http = require('http');
const https = require('https');

function patchAgentRequest(agent) {
    const originalRequest = agent.request;
    agent.request = function patchedRequest(options, callback) {
        if (typeof options === 'object') {
            options.headers = options.headers || {};
            if (!options.headers['User-Agent'] && !options.headers['user-agent']) {
                options.headers['User-Agent'] = REALISTIC_USER_AGENT;
            }
        }
        return originalRequest.call(this, options, callback);
    };
}
patchAgentRequest(http.Agent.prototype);
patchAgentRequest(https.Agent.prototype);

app.get('/search/:query', async (req, res) => {
    try {
        console.log(`[REQUEST] /search/${req.params.query}`);
        const data = await Search(req.params.query);
        if (!data || data.length === 0) {
            console.warn(`[WARN] No torrents found for query: ${req.params.query}`);
            res.status(404).json({ error: "No torrents found or all providers failed (may be blocked on this host)." });
        } else {
            console.log(`[RESPONSE] Returning ${data.length} torrents for query: ${req.params.query}`);
            res.json({ data: data });
        }
    } catch (error) {
        console.error(`[ERROR] Internal server error for query: ${req.params.query}`, error);
        res.status(500).json({ error: "Internal server error." });
    }
});

// ==================== TORRENT STREAMING ====================
(async () => {
    const { default: WebTorrent } = await import('webtorrent');
    const client = new WebTorrent();

    // Resolve bundled FFmpeg/FFprobe binary paths (ffmpeg-static + @ffprobe-installer)
    let FFMPEG_PATH = 'ffmpeg';
    let FFPROBE_PATH = 'ffprobe';
    try {
        FFMPEG_PATH = require('ffmpeg-static');
        console.log(`[INFO] Using bundled ffmpeg: ${FFMPEG_PATH}`);
    } catch { console.warn('[WARN] ffmpeg-static not found, falling back to system ffmpeg'); }
    try {
        FFPROBE_PATH = require('@ffprobe-installer/ffprobe').path;
        console.log(`[INFO] Using bundled ffprobe: ${FFPROBE_PATH}`);
    } catch { console.warn('[WARN] @ffprobe-installer not found, falling back to system ffprobe'); }

    // Store active torrents info
    const activeTorrents = new Map();
    const streamsFilePath = path.join(__dirname, 'active_streams.json');

    function saveActiveStreamsToDisk() {
        try {
            const data = [];
            for (const [infoHash, meta] of activeTorrents.entries()) {
                const torrent = client.get(infoHash);
                data.push({
                    infoHash: infoHash,
                    magnet: meta.magnet,
                    addedAt: meta.addedAt,
                    paused: torrent ? torrent.paused : false
                });
            }
            fs.writeFileSync(streamsFilePath, JSON.stringify(data, null, 2), 'utf-8');
            console.log(`[INFO] Saved ${data.length} active streams to disk.`);
        } catch (err) {
            console.error('[ERROR] Failed to save active streams:', err.message);
        }
    }

    // Load persisted torrents from disk
    async function loadActiveStreamsFromDisk() {
        try {
            if (fs.existsSync(streamsFilePath)) {
                const raw = fs.readFileSync(streamsFilePath, 'utf-8');
                const data = JSON.parse(raw);
                console.log(`[INFO] Found ${data.length} persisted streams. Restoring...`);
                for (const item of data) {
                    try {
                        console.log(`[INFO] Restoring torrent: ${item.infoHash}`);
                        const torrent = client.add(item.magnet);
                        
                        activeTorrents.set(item.infoHash, {
                            addedAt: item.addedAt || Date.now(),
                            magnet: item.magnet
                        });
                        
                        if (item.paused) {
                            torrent.pause();
                        }
                    } catch (addErr) {
                        console.error(`[ERROR] Failed to restore torrent ${item.infoHash}:`, addErr.message);
                    }
                }
            }
        } catch (err) {
            console.error('[ERROR] Failed to load active streams:', err.message);
        }
    }

    // Restore persisted streams immediately
    await loadActiveStreamsFromDisk();

    const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m4v', '.mpeg', '.mpg'];
    const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
    const SUBTITLE_EXTS = ['.srt', '.vtt', '.ass', '.ssa', '.sub'];

    function getExt(filename) {
        const idx = filename.lastIndexOf('.');
        return idx === -1 ? '' : filename.slice(idx).toLowerCase();
    }

    function isVideo(filename) {
        return VIDEO_EXTS.includes(getExt(filename));
    }

    function isImage(filename) {
        return IMAGE_EXTS.includes(getExt(filename));
    }

    function isSubtitle(filename) {
        return SUBTITLE_EXTS.includes(getExt(filename));
    }

    // Convert SRT/ASS/SSA subtitle text to WebVTT format for browser compatibility
    function convertToVTT(text, ext) {
        if (ext === '.vtt') return text; // already VTT

        if (ext === '.srt') {
            // SRT -> VTT conversion
            let vtt = 'WEBVTT\n\n';
            // Replace SRT timestamp format (00:00:00,000) with VTT (00:00:00.000)
            const converted = text
                .replace(/\r\n/g, '\n')
                .replace(/\r/g, '\n')
                .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2');
            // Remove sequence numbers at start of cues
            const cues = converted.split(/\n\n+/);
            for (const cue of cues) {
                const lines = cue.trim().split('\n');
                if (lines.length === 0 || !lines[0]) continue;
                // Skip pure numeric sequence number lines
                const startIdx = /^\d+$/.test(lines[0]) ? 1 : 0;
                const cuePart = lines.slice(startIdx).join('\n').trim();
                if (cuePart) vtt += cuePart + '\n\n';
            }
            return vtt;
        }

        if (ext === '.ass' || ext === '.ssa') {
            // Basic ASS/SSA -> VTT: extract dialogue lines only
            let vtt = 'WEBVTT\n\n';
            const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
            // Parse format header to find field indices
            let formatFields = [];
            for (const line of lines) {
                if (line.startsWith('Format:')) {
                    formatFields = line.replace('Format:', '').split(',').map(f => f.trim());
                }
                if (line.startsWith('Dialogue:')) {
                    const values = line.replace('Dialogue:', '').split(',');
                    const startIdx = formatFields.indexOf('Start');
                    const endIdx = formatFields.indexOf('End');
                    const textIdx = formatFields.indexOf('Text');
                    if (startIdx < 0 || endIdx < 0 || textIdx < 0) continue;

                    const start = values[startIdx]?.trim();
                    const end = values[endIdx]?.trim();
                    // Text may contain commas, rejoin from textIdx onward
                    const rawText = values.slice(textIdx).join(',').trim()
                        .replace(/\{[^}]*\}/g, '') // remove ASS tags
                        .replace(/\\N/g, '\n')     // line breaks
                        .replace(/\\n/g, '\n');

                    if (!start || !end || !rawText) continue;

                    // Convert ASS time 0:00:00.00 to VTT 00:00:00.000
                    function assToVttTime(t) {
                        const parts = t.split(':');
                        if (parts.length !== 3) return t;
                        const [h, m, s] = parts;
                        const [sec, cs] = s.split('.');
                        return `${h.padStart(2,'0')}:${m.padStart(2,'0')}:${sec.padStart(2,'0')}.${(cs||'00').padEnd(3,'0')}`;
                    }

                    vtt += `${assToVttTime(start)} --> ${assToVttTime(end)}\n${rawText}\n\n`;
                }
            }
            return vtt;
        }

        // .sub (MicroDVD or plain text) — serve as-is with VTT header as best effort
        return 'WEBVTT\n\n' + text;
    }

    function getMimeType(filename) {
        const ext = getExt(filename);
        const mimeTypes = {
            '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
            '.mov': 'video/quicktime', '.webm': 'video/webm', '.flv': 'video/x-flv',
            '.wmv': 'video/x-ms-wmv', '.m4v': 'video/mp4', '.mpeg': 'video/mpeg', '.mpg': 'video/mpeg',
            '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
            '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp', '.svg': 'image/svg+xml'
        };
        return mimeTypes[ext] || 'application/octet-stream';
    }

    // Add torrent from magnet link
    app.post('/api/stream/add', async (req, res) => {
        const { magnet } = req.body;
        if (!magnet) {
            return res.status(400).json({ error: 'Magnet link is required' });
        }

        try {
            // Check if already added by magnet URI
            let existing = await client.get(magnet);
            if (existing && existing.files) {
                const files = existing.files.map((f, i) => ({
                    index: i,
                    name: f.name,
                    size: f.length,
                    type: isVideo(f.name) ? 'video' : isImage(f.name) ? 'image' : isSubtitle(f.name) ? 'subtitle' : 'other'
                }));
                // Make sure it is tracked in activeTorrents map
                if (!activeTorrents.has(existing.infoHash)) {
                    activeTorrents.set(existing.infoHash, {
                        addedAt: Date.now(),
                        magnet: magnet
                    });
                    saveActiveStreamsToDisk();
                }
                return res.json({
                    infoHash: existing.infoHash,
                    name: existing.name,
                    files: files,
                    progress: existing.progress,
                    paused: existing.paused,
                    status: 'existing'
                });
            }

            // Remove { announce: [] } to let WebTorrent discover peers via default trackers + magnet trackers
            const torrent = client.add(magnet);
            
            // Wait for ready event (metadata + store ready)
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('Timeout fetching metadata (no peers or bad link)')), 60000);
                
                const onReady = () => {
                    clearTimeout(timeout);
                    cleanup();
                    resolve();
                };
                const onError = (err) => {
                    clearTimeout(timeout);
                    cleanup();
                    reject(err);
                };
                const cleanup = () => {
                    torrent.off('ready', onReady);
                    torrent.off('error', onError);
                };
                
                torrent.on('ready', onReady);
                torrent.on('error', onError);
            });

            if (!torrent.files || !Array.isArray(torrent.files)) {
                return res.status(500).json({ error: 'Torrent has no files' });
            }

            const files = torrent.files.map((f, i) => ({
                index: i,
                name: f.name,
                size: f.length,
                type: isVideo(f.name) ? 'video' : isImage(f.name) ? 'image' : isSubtitle(f.name) ? 'subtitle' : 'other'
            }));

            activeTorrents.set(torrent.infoHash, {
                addedAt: Date.now(),
                magnet: magnet
            });
            saveActiveStreamsToDisk();

            res.json({
                infoHash: torrent.infoHash,
                name: torrent.name,
                files: files,
                progress: torrent.progress,
                paused: torrent.paused,
                status: 'added'
            });
        } catch (error) {
            console.error('[ERROR] Adding torrent:', error.message);
            try {
                // If it timed out or failed, make sure we clean it up so we don't leave dead torrents in client
                const pendingTorrent = await client.get(magnet);
                if (pendingTorrent) {
                    await client.remove(pendingTorrent, { destroyStore: true });
                }
            } catch (cleanupErr) {
                console.error('[ERROR] Cleanup torrent failed:', cleanupErr.message);
            }
            res.status(500).json({ error: error.message || 'Failed to add torrent' });
        }
    });

    // Get all active torrents running on the server
    app.get('/api/stream', async (req, res) => {
        const torrentsList = [];
        for (const [infoHash, meta] of activeTorrents.entries()) {
            const torrent = await client.get(infoHash);
            if (torrent) {
                torrentsList.push({
                    infoHash: torrent.infoHash,
                    name: torrent.name,
                    progress: torrent.progress,
                    downloadSpeed: torrent.downloadSpeed,
                    uploadSpeed: torrent.uploadSpeed,
                    numPeers: torrent.numPeers,
                    length: torrent.length,
                    downloaded: torrent.downloaded,
                    paused: torrent.paused,
                    addedAt: meta.addedAt
                });
            } else {
                // Remove inactive from server state if it disappeared
                activeTorrents.delete(infoHash);
            }
        }
        res.json({ torrents: torrentsList });
    });

    // Get torrent files
    app.get('/api/stream/:infoHash/files', async (req, res) => {
        const torrent = await client.get(req.params.infoHash);
        if (!torrent) {
            return res.status(404).json({ error: 'Torrent not found' });
        }

        const files = torrent.files.map((f, i) => ({
            index: i,
            name: f.name,
            size: f.length,
            type: isVideo(f.name) ? 'video' : isImage(f.name) ? 'image' : isSubtitle(f.name) ? 'subtitle' : 'other'
        }));

        res.json({
            infoHash: torrent.infoHash,
            name: torrent.name,
            files: files,
            progress: torrent.progress,
            downloadSpeed: torrent.downloadSpeed,
            uploadSpeed: torrent.uploadSpeed,
            numPeers: torrent.numPeers,
            paused: torrent.paused
        });
    });

    // Stream video file with range support
    app.get('/api/stream/:infoHash/stream/:fileIndex', async (req, res) => {
        const torrent = await client.get(req.params.infoHash);
        if (!torrent) {
            return res.status(404).json({ error: 'Torrent not found' });
        }

        const fileIndex = parseInt(req.params.fileIndex);
        const file = torrent.files[fileIndex];
        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }

        const range = req.headers.range;
        const mimeType = getMimeType(file.name);

        if (!range) {
            res.setHeader('Content-Type', mimeType);
            res.setHeader('Content-Length', file.length);
            res.setHeader('Accept-Ranges', 'bytes');
            const stream = file.createReadStream();
            stream.pipe(res);
            stream.on('error', (err) => {
                console.error('[STREAM ERROR]', err.message);
            });
            res.on('close', () => {
                stream.destroy();
            });
            return;
        }

        const parts = range.replace(/bytes=/, '').split('-');
        const start = parseInt(parts[0], 10);
        const end = parts[1] ? parseInt(parts[1], 10) : file.length - 1;
        const chunksize = (end - start) + 1;

        res.setHeader('Content-Range', `bytes ${start}-${end}/${file.length}`);
        res.setHeader('Accept-Ranges', 'bytes');
        res.setHeader('Content-Length', chunksize);
        res.setHeader('Content-Type', mimeType);
        res.status(206);

        const stream = file.createReadStream({ start, end });
        stream.pipe(res);
        stream.on('error', (err) => {
            console.error('[STREAM ERROR (range)]', err.message);
        });
        res.on('close', () => {
            stream.destroy();
        });
    });

    // Serve subtitle file as WebVTT (converts SRT/ASS on-the-fly)
    app.get('/api/stream/:infoHash/subtitle/:fileIndex', async (req, res) => {
        const torrent = await client.get(req.params.infoHash);
        if (!torrent) {
            return res.status(404).json({ error: 'Torrent not found' });
        }

        const fileIndex = parseInt(req.params.fileIndex);
        const file = torrent.files[fileIndex];
        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }

        try {
            const ext = getExt(file.name);
            const chunks = [];
            const stream = file.createReadStream();

            stream.on('data', chunk => chunks.push(chunk));
            stream.on('end', () => {
                try {
                    const rawText = Buffer.concat(chunks).toString('utf-8');
                    const vttContent = convertToVTT(rawText, ext);
                    res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.send(vttContent);
                } catch (convErr) {
                    console.error('[SUBTITLE CONV ERROR]', convErr.message);
                    res.status(500).json({ error: 'Failed to convert subtitle' });
                }
            });
            stream.on('error', err => {
                console.error('[SUBTITLE STREAM ERROR]', err.message);
                res.status(500).json({ error: 'Subtitle stream error' });
            });
        } catch (err) {
            console.error('[SUBTITLE ERROR]', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // ---- FFmpeg helpers ----
    const { spawn } = require('child_process');

    // Probe embedded subtitle tracks in a video file using ffprobe
    // GET /api/stream/:infoHash/probe-subs/:fileIndex
    app.get('/api/stream/:infoHash/probe-subs/:fileIndex', async (req, res) => {
        const torrent = await client.get(req.params.infoHash);
        if (!torrent) return res.status(404).json({ error: 'Torrent not found' });

        const fileIndex = parseInt(req.params.fileIndex);
        const file = torrent.files[fileIndex];
        if (!file) return res.status(404).json({ error: 'File not found' });

        const port = process.env.PORT || 3000;
        const streamUrl = `http://127.0.0.1:${port}/api/stream/${torrent.infoHash}/stream/${fileIndex}`;

        try {
            const result = await new Promise((resolve, reject) => {
                const args = [
                    '-v', 'quiet',
                    '-print_format', 'json',
                    '-show_streams',
                    '-select_streams', 's',   // only subtitle streams
                    '-i', streamUrl
                ];
                const proc = spawn(FFPROBE_PATH, args);
                let stdout = '';
                let stderr = '';
                proc.stdout.on('data', d => stdout += d);
                proc.stderr.on('data', d => stderr += d);
                proc.on('close', code => {
                    if (stdout) {
                        try { resolve(JSON.parse(stdout)); }
                        catch (e) { reject(new Error('ffprobe JSON parse error')); }
                    } else {
                        reject(new Error(`ffprobe exited (${code}): ${stderr.slice(0, 200)}`));
                    }
                });
                proc.on('error', err => reject(new Error('ffprobe not found: ' + err.message)));
                // Timeout safety
                setTimeout(() => { proc.kill(); reject(new Error('ffprobe timeout')); }, 30000);
            });

            // Build a clean list of subtitle tracks
            const tracks = (result.streams || []).map((s, i) => {
                const lang = s.tags?.language || s.tags?.LANGUAGE || null;
                const title = s.tags?.title || s.tags?.TITLE || null;
                const codec = s.codec_name || 'unknown';
                const label = [title, lang ? `[${lang}]` : null].filter(Boolean).join(' ') || `Track ${s.index}`;
                return {
                    trackIndex: i,          // subtitle-stream index (0-based among subtitle streams)
                    streamIndex: s.index,   // absolute stream index in file
                    label,
                    lang,
                    title,
                    codec
                };
            });

            res.json({ tracks });
        } catch (err) {
            console.error('[PROBE-SUBS ERROR]', err.message);
            res.status(500).json({ error: err.message });
        }
    });

    // Extract an embedded subtitle track as WebVTT via ffmpeg
    // GET /api/stream/:infoHash/embedded-sub/:fileIndex/:trackIndex
    app.get('/api/stream/:infoHash/embedded-sub/:fileIndex/:trackIndex', async (req, res) => {
        const torrent = await client.get(req.params.infoHash);
        if (!torrent) return res.status(404).json({ error: 'Torrent not found' });

        const fileIndex = parseInt(req.params.fileIndex);
        const trackIndex = parseInt(req.params.trackIndex); // subtitle-stream index (0-based)
        const file = torrent.files[fileIndex];
        if (!file) return res.status(404).json({ error: 'File not found' });

        const port = process.env.PORT || 3000;
        const streamUrl = `http://127.0.0.1:${port}/api/stream/${torrent.infoHash}/stream/${fileIndex}`;

        res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
        res.setHeader('Cache-Control', 'no-cache');

        // ffmpeg: read the stream URL, pick subtitle stream s:trackIndex, output as webvtt to stdout
        const args = [
            '-v', 'error',
            '-i', streamUrl,
            '-map', `0:s:${trackIndex}`,
            '-f', 'webvtt',
            'pipe:1'
        ];

        console.log(`[EMBEDDED-SUB] ffmpeg -map 0:s:${trackIndex} (track ${trackIndex})`);
        const proc = spawn(FFMPEG_PATH, args);

        proc.stdout.pipe(res);

        proc.stderr.on('data', d => {
            console.error('[FFMPEG SUBTITLE STDERR]', d.toString().slice(0, 200));
        });

        proc.on('error', err => {
            console.error('[FFMPEG ERROR]', err.message);
            if (!res.headersSent) {
                res.status(500).json({ error: 'ffmpeg not found or failed: ' + err.message });
            }
        });

        res.on('close', () => {
            proc.kill('SIGKILL');
        });
    });

    // Serve image or other file

    app.get('/api/stream/:infoHash/file/:fileIndex', async (req, res) => {
        const torrent = await client.get(req.params.infoHash);
        if (!torrent) {
            return res.status(404).json({ error: 'Torrent not found' });
        }

        const fileIndex = parseInt(req.params.fileIndex);
        const file = torrent.files[fileIndex];
        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }

        res.setHeader('Content-Type', getMimeType(file.name));
        res.setHeader('Content-Length', file.length);
        const stream = file.createReadStream();
        stream.pipe(res);
        stream.on('error', (err) => {
            console.error('[FILE STREAM ERROR]', err.message);
        });
        res.on('close', () => {
            stream.destroy();
        });
    });

    // Remove torrent
    app.delete('/api/stream/:infoHash', async (req, res) => {
        const torrent = await client.get(req.params.infoHash);
        if (!torrent) {
            return res.status(404).json({ error: 'Torrent not found' });
        }
        
        try {
            await client.remove(req.params.infoHash, { destroyStore: true });
            activeTorrents.delete(req.params.infoHash);
            saveActiveStreamsToDisk();
            res.json({ message: 'Torrent removed' });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Pause torrent
    app.post('/api/stream/:infoHash/pause', async (req, res) => {
        const torrent = await client.get(req.params.infoHash);
        if (!torrent) {
            return res.status(404).json({ error: 'Torrent not found' });
        }
        try {
            torrent.pause();
            saveActiveStreamsToDisk();
            res.json({ message: 'Torrent paused', paused: true });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Resume torrent
    app.post('/api/stream/:infoHash/resume', async (req, res) => {
        const torrent = await client.get(req.params.infoHash);
        if (!torrent) {
            return res.status(404).json({ error: 'Torrent not found' });
        }
        try {
            torrent.resume();
            saveActiveStreamsToDisk();
            res.json({ message: 'Torrent resumed', paused: false });
        } catch (err) {
            res.status(500).json({ error: err.message });
        }
    });

    // Get stats for a torrent
    app.get('/api/stream/:infoHash/stats', async (req, res) => {
        console.log(`[STATS] Querying stats for: ${req.params.infoHash}`);
        const torrent = await client.get(req.params.infoHash);
        if (!torrent) {
            console.log(`[STATS] Torrent not found for: ${req.params.infoHash}`);
            return res.status(404).json({ error: 'Torrent not found' });
        }

        console.log(`[STATS] Torrent found! Name: ${torrent.name}, progress: ${torrent.progress}`);

        res.json({
            infoHash: torrent.infoHash,
            name: torrent.name,
            progress: torrent.progress,
            downloadSpeed: torrent.downloadSpeed,
            uploadSpeed: torrent.uploadSpeed,
            numPeers: torrent.numPeers,
            length: torrent.length,
            downloaded: torrent.downloaded,
            paused: torrent.paused
        });
    });

    // Helper function to find VLC path on Windows
    function getVlcPath() {
        return new Promise((resolve) => {
            const commonPaths = [
                'C:\\Program Files\\VideoLAN\\VLC\\vlc.exe',
                'C:\\Program Files (x86)\\VideoLAN\\VLC\\vlc.exe'
            ];
            
            for (const p of commonPaths) {
                if (fs.existsSync(p)) {
                    return resolve(p);
                }
            }
            
            // Try querying Windows registry
            exec('reg query "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\vlc.exe" /ve', (err, stdout) => {
                if (!err && stdout) {
                    const match = stdout.match(/REG_SZ\s+(.+)/);
                    if (match && match[1]) {
                        const registryPath = match[1].trim();
                        if (fs.existsSync(registryPath)) {
                            return resolve(registryPath);
                        }
                    }
                }
                
                // Fallback to default in path or standard location
                resolve('vlc');
            });
        });
    }

    // Launch VLC for a video stream locally
    app.post('/api/stream/:infoHash/play-vlc/:fileIndex', async (req, res) => {
        const torrent = await client.get(req.params.infoHash);
        if (!torrent) {
            return res.status(404).json({ error: 'Torrent not found' });
        }

        const fileIndex = parseInt(req.params.fileIndex);
        const file = torrent.files[fileIndex];
        if (!file) {
            return res.status(404).json({ error: 'File not found' });
        }

        const port = process.env.PORT || 3000;
        const host = req.hostname === 'localhost' || req.hostname === '127.0.0.1' ? req.hostname : 'localhost';
        const streamUrl = `http://${host}:${port}/api/stream/${torrent.infoHash}/stream/${fileIndex}`;

        try {
            const vlcPath = await getVlcPath();
            console.log(`[VLC Launcher] Spawning VLC from path: ${vlcPath} with URL: ${streamUrl}`);
            
            // Spawn VLC in the background (detached so it doesn't block node)
            const command = `"${vlcPath}" "${streamUrl}"`;
            exec(command, (err) => {
                if (err) {
                    console.error('[VLC Launcher Error]', err.message);
                }
            });

            res.json({ message: 'VLC launcher triggered successfully', streamUrl });
        } catch (err) {
            console.error('[VLC Launcher Error]', err.message);
            res.status(500).json({ error: 'Failed to launch VLC player: ' + err.message });
        }
    });

    const port = process.env.PORT || 3000;
    app.listen(port, '0.0.0.0', () => {
        console.log(`Server is running on port:${port}`);
    });
})();
