const express = require("express");
const bodyParser = require('body-parser');
const cors = require('cors');
const scrapeImdb = require('./ScrapeImdb.js');
const fs = require('fs');
const { exec } = require('child_process');

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

    // Store active torrents info
    const activeTorrents = new Map();

    const VIDEO_EXTS = ['.mp4', '.mkv', '.avi', '.mov', '.webm', '.flv', '.wmv', '.m4v', '.mpeg', '.mpg'];
    const IMAGE_EXTS = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];

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
                    type: isVideo(f.name) ? 'video' : isImage(f.name) ? 'image' : 'other'
                }));
                // Make sure it is tracked in activeTorrents map
                if (!activeTorrents.has(existing.infoHash)) {
                    activeTorrents.set(existing.infoHash, {
                        addedAt: Date.now(),
                        magnet: magnet
                    });
                }
                return res.json({
                    infoHash: existing.infoHash,
                    name: existing.name,
                    files: files,
                    progress: existing.progress,
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
                type: isVideo(f.name) ? 'video' : isImage(f.name) ? 'image' : 'other'
            }));

            activeTorrents.set(torrent.infoHash, {
                addedAt: Date.now(),
                magnet: magnet
            });

            res.json({
                infoHash: torrent.infoHash,
                name: torrent.name,
                files: files,
                progress: torrent.progress,
                status: 'added'
            });
        } catch (error) {
            console.error('[ERROR] Adding torrent:', error.message);
            try {
                // If it timed out or failed, make sure we clean it up so we don't leave dead torrents in client
                const pendingTorrent = await client.get(magnet);
                if (pendingTorrent) {
                    await client.remove(pendingTorrent);
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
            type: isVideo(f.name) ? 'video' : isImage(f.name) ? 'image' : 'other'
        }));

        res.json({
            infoHash: torrent.infoHash,
            name: torrent.name,
            files: files,
            progress: torrent.progress,
            downloadSpeed: torrent.downloadSpeed,
            uploadSpeed: torrent.uploadSpeed,
            numPeers: torrent.numPeers
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
            await client.remove(req.params.infoHash);
            activeTorrents.delete(req.params.infoHash);
            res.json({ message: 'Torrent removed' });
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
            downloaded: torrent.downloaded
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
    app.listen(port, () => {
        console.log(`Server is running on port:${port}`);
    });
})();
