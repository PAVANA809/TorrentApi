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
            allTorrents = allTorrents.filter(torrent => torrent.imdb);
            if (allTorrents.length > 0) {
                console.log(`[SUCCESS] Found ${allTorrents.length} torrents with IMDB info from ${provider}`);
                allTorrents[0]["imgurl"] = await scrapeImdb.getImdbImg(allTorrents[0].imdb);
                return allTorrents;
            } else {
                console.log(`[WARN] No torrents with IMDB info found from ${provider}`);
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