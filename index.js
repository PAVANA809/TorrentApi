const express = require("express");
const bodyParser = require('body-parser');
const cors = require('cors');
const scrapeImdb = require('./ScrapeImdb.js')

require("dotenv").config();

const app = express();
app.use(bodyParser.json());
app.use(cors());

const TorrentSearchApi = require('torrent-search-api');

TorrentSearchApi.enableProvider('ThePirateBay');

const categories = ['All'];

async function Search(searchQuery) {
    try {
        let allTorrents = [];

        for (const category of categories) {
            const torrents = await TorrentSearchApi.search(searchQuery, category, 20);
            allTorrents = [...allTorrents, ...torrents];
        }

        allTorrents.sort((a, b) => b.seeds - a.seeds)
        allTorrents = allTorrents.filter(torrent => torrent.imdb);
        await Promise.all(
        allTorrents.map(async (torrent) => {
            torrent["imgurl"] = await scrapeImdb.getImdbImg(torrent.imdb);
        }))
        return allTorrents;
    } catch (error) {
        console.error('Error fetching torrents:', error);
    }
};


app.get('/search/:query', async (req, res) => {
    data = await Search(req.params.query)
    res.json({data: data});
  });

const port = process.env.PORT || 3000
app.listen(port, () => {
    console.log(`Server is running on port:${port}`);
});