const axios = require("axios");
const cheerio = require("cheerio");


async function getImdbImg(imdbId) {
  try {
    const url = "https://www.imdb.com/title/" + imdbId + "/";

    const response = await axios.get(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/113.0.0.0 Safari/537.36",
      },
    });

    const $ = cheerio.load(response.data);

    const imgSelector = "#__next > main > div > section.ipc-page-background.ipc-page-background--base.sc-abcc9be3-0.bldfgO > section > div:nth-child(5) > section > section > div.sc-42c2285c-4.hBMxVJ > div.sc-42c2285c-5.ePSDbO > div.sc-42c2285c-7.hwVTly > div > div.ipc-media.ipc-media--poster-27x40.ipc-image-media-ratio--poster-27x40.ipc-media--media-radius.ipc-media--baseAlt.ipc-media--poster-l.ipc-poster__poster-image.ipc-media__img > img"
    const imgSrc = $(imgSelector).attr("src");

    if (imgSrc) {
      return imgSrc
    } else {
        return "";
    }
  } catch (error) {
    console.error("Error:", error.message);
  }
}

module.exports = { getImdbImg };
