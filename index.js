const express = require("express");
const bodyParser = require('body-parser');
const cors = require('cors');
const scrapeImdb = require('./ScrapeImdb.js')

require("dotenv").config();

const app = express();
app.use(bodyParser.json());
app.use(cors());

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

const port = process.env.PORT || 3000
app.listen(port, () => {
    console.log(`Server is running on port:${port}`);
});