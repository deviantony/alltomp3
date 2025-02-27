const ytdl = require('ytdl-core');
const ffmpeg = require('fluent-ffmpeg');
const path = require('path');
const fs = require('fs-extra');
const EventEmitter = require('events');
const request = require('request-promise');
const requestNoPromise = require('request');
const _ = require('lodash');
const acoustid = require('acoustid');
const EyeD3 = require('eyed3');
let eyed3 = new EyeD3({ eyed3_path: 'eyeD3' });
eyed3.metaHook = (m) => m;
const levenshtein = require('fast-levenshtein');
const randomstring = require('randomstring');
const cheerio = require('cheerio');
const Promise = require('bluebird');
const sharp = require('sharp');
const smartcrop = require('smartcrop-sharp');
const ytsr = require('ytsr');
const ytpl = require('ytpl');
const lcs = require('longest-common-substring');

// API keys
const API_ACOUSTID = 'lm59lNN597';
const API_SOUNDCLOUD = 'dba290d84e6ca924414c91ac12fc3c8f';
const API_SPOTIFY = 'ODNiZjMzMmQ4MDI1NGNlNzhkNjNkOWM2ZWM2N2M5ZTU6Mzg4OTIxY2M0ZjEyNGEwYWFjM2NiMzIzYTNiZGVlYmU=';

const at3 = {};

// ISO 3166-1 alpha-2 country code of the user (ex: US, FR)
at3.regionCode;

// ISO 639-1 two-letter language code of the user (ex: en, fr)
at3.relevanceLanguage;

// Folder for temporary files
at3.tempFolder = null;

// Fix for renameSync failing on Windows when cropping cover images
// See https://github.com/lovell/sharp/issues/415
sharp.cache(false);

at3.configEyeD3 = (eyeD3Path, eyeD3PathPythonPath, metaHook) => {
  process.env.PYTHONPATH = eyeD3PathPythonPath;
  eyed3 = new EyeD3({ eyed3_path: eyeD3Path });
  if (!metaHook) {
    metaHook = (m) => m;
  }
  eyed3.metaHook = metaHook;
};

at3.FPCALC_PATH = 'fpcalc';
at3.setFpcalcPath = (fpcalcPath) => {
  at3.FPCALC_PATH = fpcalcPath;
};

at3.setFfmpegPaths = (ffmpegPath, ffprobePath) => {
  if (ffmpegPath) {
    at3.FFMPEG_PATH = ffmpegPath;
  }
  if (ffprobePath) {
    at3.FFPROBE_PATH = ffprobePath;
  }
};

/**
 * Find lyrics for a song
 * @param title string
 * @param artistName string
 * @return Promise
 */
at3.findLyrics = (title, artistName) => {
  let promises = [];

  const textln = (html) => {
    html.find('br').replaceWith('\n');
    html.find('script').replaceWith('');
    html.find('#video-musictory').replaceWith('');
    html.find('strong').replaceWith('');
    html = _.trim(html.text());
    html = html.replace(/\r\n\n/g, '\n');
    html = html.replace(/\t/g, '');
    html = html.replace(/\n\r\n/g, '\n');
    html = html.replace(/ +/g, ' ');
    html = html.replace(/\n /g, '\n');
    return html;
  };

  const lyricsUrl = (title) => {
    return _.kebabCase(_.trim(_.toLower(_.deburr(title))));
  };
  const lyricsManiaUrl = (title) => {
    return _.snakeCase(_.trim(_.toLower(_.deburr(title))));
  };
  const lyricsManiaUrlAlt = (title) => {
    title = _.trim(_.toLower(title));
    title = title.replace("'", '');
    title = title.replace(' ', '_');
    title = title.replace(/_+/g, '_');
    return title;
  };

  const reqWikia = request({
    uri: 'http://lyrics.wikia.com/wiki/' + encodeURIComponent(artistName) + ':' + encodeURIComponent(title),
    transform: (body) => {
      return cheerio.load(body);
    },
  }).then(($) => {
    return textln($('.lyricbox'));
  });

  const reqParolesNet = request({
    uri: 'http://www.paroles.net/' + lyricsUrl(artistName) + '/paroles-' + lyricsUrl(title),
    transform: (body) => {
      return cheerio.load(body);
    },
  }).then(($) => {
    if ($('.song-text').length === 0) {
      return Promise.reject();
    }
    return textln($('.song-text'));
  });

  const reqLyricsMania1 = request({
    uri: 'http://www.lyricsmania.com/' + lyricsManiaUrl(title) + '_lyrics_' + lyricsManiaUrl(artistName) + '.html',
    transform: (body) => {
      return cheerio.load(body);
    },
  }).then(($) => {
    if ($('.lyrics-body').length === 0) {
      return Promise.reject();
    }
    return textln($('.lyrics-body'));
  });

  const reqLyricsMania2 = request({
    uri: 'http://www.lyricsmania.com/' + lyricsManiaUrl(title) + '_' + lyricsManiaUrl(artistName) + '.html',
    transform: (body) => {
      return cheerio.load(body);
    },
  }).then(($) => {
    if ($('.lyrics-body').length === 0) {
      return Promise.reject();
    }
    return textln($('.lyrics-body'));
  });

  const reqLyricsMania3 = request({
    uri:
      'http://www.lyricsmania.com/' +
      lyricsManiaUrlAlt(title) +
      '_lyrics_' +
      encodeURIComponent(lyricsManiaUrlAlt(artistName)) +
      '.html',
    transform: (body) => {
      return cheerio.load(body);
    },
  }).then(($) => {
    if ($('.lyrics-body').length === 0) {
      return Promise.reject();
    }
    return textln($('.lyrics-body'));
  });

  const reqSweetLyrics = request({
    method: 'POST',
    uri: 'http://www.sweetslyrics.com/search.php',
    form: {
      search: 'title',
      searchtext: title,
    },
    transform: (body) => {
      return cheerio.load(body);
    },
  })
    .then(($) => {
      let closestLink,
        closestScore = -1;
      _.forEach($('.search_results_row_color'), (e) => {
        let artist = $(e)
          .text()
          .replace(/ - .+$/, '');
        let currentScore = levenshtein.get(artistName, artist);
        if (closestScore === -1 || currentScore < closestScore) {
          closestScore = currentScore;
          closestLink = $(e).find('a').last().attr('href');
        }
      });
      if (!closestLink) {
        return Promise.reject();
      }
      return request({
        uri: 'http://www.sweetslyrics.com/' + closestLink,
        transform: (body) => {
          return cheerio.load(body);
        },
      });
    })
    .then(($) => {
      return textln($('.lyric_full_text'));
    });

  if (/\(.*\)/.test(title) || /\[.*\]/.test(title)) {
    promises.push(at3.findLyrics(title.replace(/\(.*\)/g, '').replace(/\[.*\]/g, ''), artistName));
  }

  promises.push(reqWikia);
  promises.push(reqParolesNet);
  promises.push(reqLyricsMania1);
  promises.push(reqLyricsMania2);
  promises.push(reqLyricsMania3);
  promises.push(reqSweetLyrics);

  return Promise.any(promises).then((lyrics) => {
    return lyrics;
  });
};

/**
 * Returns true if the query corresponds
 * to an URL, else false
 * @param query string
 * @return boolean
 */
at3.isURL = (query) => {
  return /^http(s?):\/\//.test(query);
};

/**
 * Get a fresh access token from Spotify API
 * @return {Promise}
 */
at3.spotifyToken = () => {
  return request
    .post({
      uri: 'https://accounts.spotify.com/api/token',
      headers: {
        Authorization: 'Basic ' + API_SPOTIFY,
      },
      form: {
        grant_type: 'client_credentials',
      },
      json: true,
    })
    .then((r) => {
      return r.access_token;
    });
};

/**
 * Perform a GET request to the Spotify API `url` endpoint
 * @param {String} url URL of Spotify API endpoint to get
 * @return {Promise} The request
 */
at3.requestSpotify = (url) => {
  return at3.spotifyToken().then((token) => {
    return request({
      uri: url,
      json: true,
      headers: {
        Authorization: 'Bearer ' + token,
      },
    });
  });
};

/**
 * Download a single video
 * @param url
 * @param outputFile
 * @return Event
 */
at3.downloadWithYoutubeDl = (url, outputFile) => {
  const download = ytdl(url, { quality: 'highestaudio' });
  download.pipe(fs.createWriteStream(outputFile));
  const downloadEmitter = new EventEmitter();
  let aborted = false;

  const onProgress = (_chunk, nbDownloaded, nbTotal) => {
    const percent = ((nbDownloaded / nbTotal) * 100).toFixed(2);
    downloadEmitter.emit('download-progress', {
      progress: percent,
    });
  };

  download.on('progress', onProgress);

  download.once('end', () => {
    if (aborted) {
      return;
    }
    download.removeListener('progress', onProgress);
    downloadEmitter.emit('download-end');
  });

  download.once('error', (error) => {
    download.removeListener('progress', onProgress);
    downloadEmitter.emit('error', new Error(error));
  });

  const abort = () => {
    aborted = true;
    download.abort();
    if (fs.existsSync(outputFile)) {
      fs.unlinkSync(outputFile);
    }
  };

  downloadEmitter.once('abort', abort);

  return downloadEmitter;
};

/**
 * Convert a outputFile in MP3
 * @param inputFile
 * @param outputFile
 * @param bitrate string
 * @return Event
 */
at3.convertInMP3 = (inputFile, outputFile, bitrate) => {
  const convertEmitter = new EventEmitter();
  let aborted = false;
  let started = false;

  let convert = ffmpeg(inputFile);
  if (at3.FFMPEG_PATH) {
    convert.setFfmpegPath(at3.FFMPEG_PATH);
  }
  if (at3.FFPROBE_PATH) {
    convert.setFfprobePath(at3.FFPROBE_PATH);
  }

  const onProgress = (progress) => {
    convertEmitter.emit('convert-progress', {
      progress: progress.percent,
    });
  };

  convert
    .audioBitrate(bitrate)
    .audioCodec('libmp3lame')
    .once('codecData', (_data) => {
      convertEmitter.emit('convert-start');
    })
    .on('progress', onProgress)
    .once('end', () => {
      convert.removeListener('progress', onProgress);
      fs.unlinkSync(inputFile);
      convertEmitter.emit('convert-end');
    })
    .once('error', (e) => {
      convert.removeListener('progress', onProgress);
      if (!aborted) {
        convertEmitter.emit('error', e);
      } else {
        if (fs.existsSync(inputFile)) {
          fs.unlink(inputFile, () => {});
        }
        if (fs.existsSync(outputFile)) {
          fs.unlink(outputFile, () => {});
        }
      }
    })
    .once('start', () => {
      started = true;
      if (aborted) {
        abort();
      }
    })
    .save(outputFile);

  const abort = () => {
    aborted = true;
    if (started) {
      convert.kill();
    }
  };

  convertEmitter.once('abort', abort);

  return convertEmitter;
};

/**
 * Get infos about an online video
 * @param url
 * @return Promise
 */
at3.getInfosWithYoutubeDl = (url) => {
  return ytdl.getBasicInfo(url).then((infos) => {
    const thumbnails = infos.player_response.videoDetails.thumbnail.thumbnails;

    return {
      title: infos.videoDetails.title,
      author: infos.videoDetails.author.name,
      picture: thumbnails[thumbnails.length - 1].url,
    };
  });

  //   youtubedl.getInfo(url, ['--no-check-certificate'], (err, infos) => {
  //     if (err || infos === undefined) {
  //       reject();
  //     } else {
  //       resolve({
  //         title: infos.title,
  //         author: infos.uploader,
  //         picture: infos.thumbnail,
  //       });
  //     }
  //   });
  // });
};

/**
 * Download a single URL in MP3
 * @param url
 * @param outputFile
 * @param bitrate
 * @return Event
 */
at3.downloadSingleURL = (url, outputFile, bitrate) => {
  const progressEmitter = new EventEmitter();
  let tempFile = outputFile + '.video';
  let downloadEnded = false;
  let convert;

  const dl = at3.downloadWithYoutubeDl(url, tempFile);
  const onDlProgress = (infos) => {
    progressEmitter.emit('download', {
      progress: infos.progress,
    });
  };

  dl.once('download-start', () => {
    progressEmitter.emit('start');
  });
  dl.on('download-progress', onDlProgress);

  dl.once('download-end', () => {
    downloadEnded = true;
    dl.removeListener('download-progress', onDlProgress);
    progressEmitter.emit('download-end');

    convert = at3.convertInMP3(tempFile, outputFile, bitrate);
    const onConvertProgress = (infos) => {
      progressEmitter.emit('convert', {
        progress: infos.progress,
      });
    };
    convert.on('convert-progress', onConvertProgress);
    convert.once('convert-end', () => {
      convert.removeListener('convert-progress', onConvertProgress);
      progressEmitter.emit('end');
    });
    convert.once('error', (error) => {
      progressEmitter.emit('error', error);
    });
  });

  dl.once('error', (error) => {
    dl.removeListener('download-progress', onDlProgress);
    progressEmitter.emit('error', new Error(error));
  });

  progressEmitter.once('abort', () => {
    if (!downloadEnded) {
      dl.emit('abort');
    } else {
      convert.emit('abort');
    }
  });

  return progressEmitter;
};

/**
 * Try to find to title and artist from a string
 * (example: a YouTube video title)
 * @param query string
 * @param exact boolean Can the query be modified or not
 * @param last boolean Last call
 * @param v boolean Verbose
 * @return Promise
 */
at3.guessTrackFromString = (query, exact, last, v) => {
  // [TODO] Replace exact by a level of strictness
  // 0: no change at all
  // 4: remove every thing useless
  if (exact === undefined) {
    exact = false;
  }
  if (last === undefined) {
    last = false;
  }
  if (v === undefined) {
    v = false;
  }

  if (v) {
    console.log('Query: ', query);
  }

  let searchq = query;
  if (!exact) {
    searchq = searchq.replace(/\(.*\)/g, '');
    searchq = searchq.replace(/\[.*\]/g, '');
    searchq = searchq.replace(/lyric(s?)|parole(s?)/gi, '');
    searchq = searchq.replace(/^'/, '');
    searchq = searchq.replace(/ '/g, ' ');
    searchq = searchq.replace(/' /g, ' ');
    searchq = searchq.replace(/Original Motion Picture Soundtrack/i, '');
    searchq = searchq.replace(/bande originale/i, '');
  }

  const requests = [];
  const infos = {
    title: null,
    artistName: null,
  };

  // We search on Deezer and iTunes
  // [TODO] Adding Spotify

  // Deezer
  const requestDeezer = request({
    url: 'https://api.deezer.com/2.0/search?q=' + encodeURIComponent(searchq),
    json: true,
  }).then((body) => {
    let title, artistName, tempTitle;
    _.forEach(body.data, (s) => {
      if (!title) {
        if (vsimpleName(searchq, exact).replace(new RegExp(vsimpleName(s.artist.name), 'ig'))) {
          if (
            delArtist(s.artist.name, searchq, exact).match(new RegExp(vsimpleName(s.title_short), 'ig')) ||
            vsimpleName(s.title_short).match(new RegExp(delArtist(s.artist.name, searchq, exact), 'ig'))
          ) {
            artistName = s.artist.name;
            title = s.title;
          } else if (!artistName) {
            artistName = s.artist.name;
            tempTitle = s.title;
          }
        }
      }
    });
    if (title && artistName) {
      infos.title = title;
      infos.artistName = artistName;
    }
    if (v) {
      console.log('Deezer answer: ', title, '-', artistName);
    }
  });

  // iTunes
  const requestiTunes = request({
    url: 'https://itunes.apple.com/search?media=music&term=' + encodeURIComponent(searchq),
    json: true,
  }).then((body) => {
    let title, artistName, tempTitle;
    _.forEach(body.results, (s) => {
      if (!title) {
        if (vsimpleName(searchq, exact).match(new RegExp(vsimpleName(s.artistName), 'gi'))) {
          if (delArtist(s.artistName, searchq, exact).match(new RegExp(vsimpleName(s.trackCensoredName), 'gi'))) {
            artistName = s.artistName;
            title = s.trackCensoredName;
          } else if (delArtist(s.artistName, searchq, exact).match(new RegExp(vsimpleName(s.trackName), 'gi'))) {
            artistName = s.artistName;
            title = s.trackName;
          } else if (!artistName) {
            artistName = s.artistName;
            temp_title = s.trackName;
          }
        }
      }
    });
    if (title && artistName) {
      infos.title = title;
      infos.artistName = artistName;
    }
    if (v) {
      console.log('iTunes answer: ', title, '-', artistName);
    }
  });

  requests.push(requestDeezer);
  requests.push(requestiTunes);

  return Promise.all(requests).then(() => {
    if (!last && (!infos.title || !infos.artistName)) {
      searchq = searchq.replace(/f(ea)?t(\.)? [^-]+/gi, ' ');
      return at3.guessTrackFromString(searchq, false, true, v);
    }
    return infos;
  });
};

/**
 * Try to guess title and artist from mp3 file
 * @param file
 * @return Promise
 */
at3.guessTrackFromFile = (file) => {
  return new Promise((resolve, _reject) => {
    acoustid(file, { key: API_ACOUSTID, fpcalc: { command: at3.FPCALC_PATH } }, (err, results) => {
      if (
        err ||
        results.length === 0 ||
        !results[0].recordings ||
        results[0].recordings.length === 0 ||
        !results[0].recordings[0].artists ||
        results[0].recordings[0].artists.length === 0
      ) {
        resolve({});
        return;
      }
      resolve({
        title: results[0].recordings[0].title,
        artistName: results[0].recordings[0].artists[0].name,
      });
    });
  });
};

/**
 * Retrieve informations about a track from artist and title
 * @param title
 * @param artistName
 * @param exact boolean Exact search or not
 * @param v boolean Verbose
 * @return Promise
 */
at3.retrieveTrackInformations = (title, artistName, exact, v) => {
  if (exact === undefined) {
    exact = false;
  }
  if (v === undefined) {
    v = false;
  }

  if (!exact) {
    title = title.replace(/((\[)|(\())?radio edit((\])|(\)))?/gi, '');
  }

  const infos = {
    title: title,
    artistName: artistName,
  };

  const requests = [];

  const requestDeezer = request({
    url: 'https://api.deezer.com/2.0/search?q=' + encodeURIComponent(artistName + ' ' + title),
    json: true,
  }).then((body) => {
    let deezerInfos;
    _.forEach(body.data, (s) => {
      if (
        !infos.deezerId &&
        imatch(vsimpleName(title), vsimpleName(s.title)) &&
        imatch(vsimpleName(artistName), vsimpleName(s.artist.name))
      ) {
        infos.deezerId = s.id;
        deezerInfos = _.clone(s);
      }
    });
    if (infos.deezerId) {
      infos.artistName = deezerInfos.artist.name;
      infos.title = deezerInfos.title;

      return at3
        .getDeezerTrackInfos(infos.deezerId, v)
        .then((deezerInfos) => {
          infos = deezerInfos;
        })
        .catch(() => {});
    }
  });

  const requestiTunes = request({
    url: 'https://itunes.apple.com/search?media=music&term=' + encodeURIComponent(artistName + ' ' + title),
    json: true,
  }).then((body) => {
    let itunesInfos;
    _.forEach(body.results, (s) => {
      if (
        !infos.itunesId &&
        (imatch(vsimpleName(title), vsimpleName(s.trackName)) ||
          imatch(vsimpleName(title), vsimpleName(s.trackCensoredName))) &&
        imatch(vsimpleName(artistName), vsimpleName(s.artistName))
      ) {
        infos.itunesId = s.trackId;
        itunesInfos = _.clone(s);
      }
    });
    if (!infos.deezerId && itunesInfos) {
      infos.artistName = itunesInfos.artistName;
      if (imatch(vsimpleName(infos.title), vsimpleName(itunesInfos.trackName))) {
        infos.title = itunesInfos.trackName;
      } else {
        infos.title = itunesInfos.trackCensoredName;
      }
      infos.itunesAlbum = itunesInfos.collectionId;
      infos.position = itunesInfos.trackNumber;
      infos.nbTracks = itunesInfos.trackCount;
      infos.album = itunesInfos.collectionName;
      infos.releaseDate = itunesInfos.releaseDate.replace(/T.+/, '');
      infos.cover = itunesInfos.artworkUrl100.replace('100x100', '200x200');
      infos.genre = itunesInfos.primaryGenreName;
      infos.discNumber = itunesInfos.discNumber;
      infos.duration = itunesInfos.trackTimeMillis / 1000;
    }

    if (v) {
      console.log('iTunes infos: ', itunesInfos);
    }
  });

  requests.push(requestDeezer);
  requests.push(requestiTunes);

  return Promise.all(requests).then(() => infos);
};

/**
 * Retrieve detailed infos about a Deezer Track
 * @param trackId
 * @param v boolean Verbosity
 * @return Promise(trackInfos)
 */
at3.getDeezerTrackInfos = (trackId, v) => {
  const infos = {
    deezerId: trackId,
  };

  return request({
    url: 'https://api.deezer.com/2.0/track/' + infos.deezerId,
    json: true,
  })
    .then((trackInfos) => {
      if (trackInfos.error) {
        return Promise.reject();
      }

      infos.title = trackInfos.title;
      infos.artistName = trackInfos.artist.name;
      infos.position = trackInfos.track_position;
      infos.duration = trackInfos.duration;
      infos.deezerAlbum = trackInfos.album.id;
      infos.discNumber = trackInfos.disk_number;

      return request({
        url: 'https://api.deezer.com/2.0/album/' + infos.deezerAlbum,
        json: true,
      });
    })
    .then((albumInfos) => {
      infos.album = albumInfos.title;
      infos.releaseDate = albumInfos.release_date;
      infos.nbTracks = albumInfos.tracks.data.length;
      infos.genreId = albumInfos.genre_id;
      infos.cover = albumInfos.cover_big;

      return request({
        url: 'https://api.deezer.com/2.0/genre/' + infos.genreId,
        json: true,
      });
    })
    .then((genreInfos) => {
      infos.genre = genreInfos.name;

      if (v) {
        console.log('Deezer infos: ', infos);
      }

      return infos;
    });
};

/**
 * Get complete information (title, artist, release date, genre, album name...)
 * for a Spotify track
 * @param {trackId} string The Spotify track id
 * @param {v} boolean The verbosity
 * @return Promise
 */
at3.getSpotifyTrackInfos = (trackId, v) => {
  const infos = {
    spotifyId: trackId,
  };

  return at3
    .requestSpotify('https://api.spotify.com/v1/tracks/' + trackId)
    .then((trackInfos) => {
      infos.title = trackInfos.name;
      infos.artistName = trackInfos.artists[0].name;
      infos.duration = Math.ceil(trackInfos.duration_ms / 1000);
      infos.position = trackInfos.track_number;
      infos.discNumber = trackInfos.disc_number;
      infos.spotifyAlbum = trackInfos.album.id;

      return at3.requestSpotify('https://api.spotify.com/v1/albums/' + trackInfos.album.id);
    })
    .then((albumInfos) => {
      infos.album = albumInfos.name;
      infos.cover = albumInfos.images[0].url;
      infos.genre = albumInfos.genres[0] || '';
      infos.nbTracks = albumInfos.tracks.total;
      infos.releaseDate = albumInfos.release_date;

      return infos;
    });
};

/**
 * Add tags to MP3 file
 * @param file
 * @param infos
 * @return Promise
 */
at3.tagFile = (file, infos) => {
  const meta = {
    title: infos.title,
    artist: infos.artistName,
  };

  if (infos.album) {
    meta.album = infos.album;
  }
  if (infos.position) {
    meta.track = infos.position;
  }
  if (infos.nbTracks) {
    meta.trackTotal = infos.nbTracks;
  }
  if (infos.discNumber) {
    meta.disc = infos.discNumber;
  }
  if (infos.lyrics) {
    meta.lyrics = infos.lyrics;
  }
  if (infos.releaseDate) {
    meta.year = /[0-9]{4}/.exec(infos.releaseDate)[0];
  }
  if (infos.genre) {
    meta.genre = infos.genre.replace(/\/.+/g, '');
  }

  return new Promise((resolve, reject) => {
    eyed3.updateMeta(file, eyed3.metaHook(meta), (err) => {
      if (err) {
        return reject(err);
      }
      if (infos.cover) {
        let coverPath = file + '.cover.jpg';

        requestNoPromise(infos.cover, () => {
          // Check that the cover is a square
          const coverFile = sharp(coverPath);
          coverFile
            .metadata()
            .then((metadata) => {
              if (metadata.width != metadata.height) {
                // In that case we will crop the cover to get a square
                const tempCoverPath = file + '.cover.resized.jpg';
                return smartcrop
                  .crop(coverPath, { width: 100, height: 100 })
                  .then((result) => {
                    let crop = result.topCrop;
                    return coverFile
                      .extract({
                        width: crop.width,
                        height: crop.height,
                        left: crop.x,
                        top: crop.y,
                      })
                      .toFile(tempCoverPath);
                  })
                  .then(() => {
                    fs.renameSync(tempCoverPath, coverPath);
                  });
              }
            })
            .then(() => {
              eyed3.updateMeta(file, eyed3.metaHook({ image: coverPath }), (err) => {
                fs.unlinkSync(coverPath);

                if (err) {
                  return reject(err);
                }

                resolve();
              });
            });
        }).pipe(fs.createWriteStream(coverPath));
      } else {
        resolve();
      }
    });
  });
};

/**
 * Search and return complete information about a single video url
 * @param url
 * @param v boolean Verbosity
 * @return Promise(object)
 */
at3.getCompleteInfosFromURL = (url, v) => {
  let infosFromString;
  // Try to find information based on video title
  return at3
    .getInfosWithYoutubeDl(url)
    .then((videoInfos) => {
      infosFromString = {
        title: videoInfos.title,
        artistName: videoInfos.author,
        cover: videoInfos.picture.replace('hqdefault', 'mqdefault'), // [TODO]: getting a better resolution and removing the black borders
        originalTitle: videoInfos.title,
      };

      if (v) {
        console.log('Video infos: ', infosFromString);
      }

      // progressEmitter.emit('infos', _.clone(infosFromString));

      return at3.guessTrackFromString(videoInfos.title, false, false, v);
    })
    .then((guessStringInfos) => {
      if (guessStringInfos.title && guessStringInfos.artistName) {
        return at3.retrieveTrackInformations(guessStringInfos.title, guessStringInfos.artistName, false, v);
      } else {
        return Promise.resolve();
      }
    })
    .then((guessStringInfos) => {
      if (guessStringInfos) {
        guessStringInfos.originalTitle = infosFromString.originalTitle;
        infosFromString = guessStringInfos;
        // progressEmitter.emit('infos', _.clone(infosFromString));
        if (v) {
          console.log('guessStringInfos: ', guessStringInfos);
        }
      } else {
        if (v) {
          console.log('Cannot retrieve detailed information from video title');
        }
      }

      return infosFromString;
    })
    .then((guessStringInfos) => {
      if (guessStringInfos.deezerId) {
        return at3.getDeezerTrackInfos(guessStringInfos.deezerId, v);
      } else if (guessStringInfos.spotifyId) {
        return at3.getSpotifyTrackInfos(guessStringInfos.spotifyId, v);
      } else {
        return guessStringInfos;
      }
    })
    .catch((_error) => {
      // The download must have failed to, and emit an error
    });
};

/**
 * Identify the song from a file and then search complete information about it
 * @param file string
 * @param v boolean Verbosity
 * @return Promise(object)
 */
at3.getCompleteInfosFromFile = (file, v) => {
  return at3
    .guessTrackFromFile(file)
    .then((guessFileInfos) => {
      if (guessFileInfos.title && guessFileInfos.artistName) {
        return at3.retrieveTrackInformations(guessFileInfos.title, guessFileInfos.artistName, false, v);
      } else {
        return Promise.resolve();
      }
    })
    .then((guessFileInfos) => {
      if (guessFileInfos) {
        if (v) {
          console.log('guessFileInfos: ', guessFileInfos);
        }
        return guessFileInfos;
      } else {
        if (v) {
          console.log('Cannot retrieve detailed information from MP3 file');
        }
      }
    });
};

/**
 * Simplify a string so it works well as a filename
 * @param {String} string
 * @return {String}
 */
at3.escapeForFilename = (string) => {
  return _.startCase(_.toLower(_.deburr(string)))
    .replace(/^\.+/, '')
    .replace(/\.+$/, '');
};

/**
 * Return a correctly formatted filename for a song.
 * Example: "02 - On Top Of The World"
 * @param title string Title of the song
 * @param artist string Artist
 * @param position int Position on the disk
 * @return string
 */
at3.formatSongFilename = (title, artist, position) => {
  let filename = at3.escapeForFilename(artist) + ' - ';
  if (position) {
    if (position < 10) {
      filename += '0';
    }
    filename += position + ' - ';
  }

  filename += at3.escapeForFilename(title);

  return filename;
};

/**
 * Create necessary folders for a subpath
 * @param baseFolder {string} The path of the outputfolder
 * @param subPathFormat {string} The subPath format: {artist}/{title}/
 * @param title {string} Title
 * @param artist {string} Artist
 * @return {String} The complete path
 */
at3.createSubPath = (baseFolder, subPathFormat, title, artist) => {
  subPathFormat = subPathFormat.replace(/\{artist\}/g, at3.escapeForFilename(artist));
  subPathFormat = subPathFormat.replace(/\{title\}/g, at3.escapeForFilename(title));

  let p = path.join(baseFolder, subPathFormat);
  if (p.charAt(p.length - 1) != path.sep) {
    p += path.sep;
  }

  const folders = subPathFormat.split(path.sep);
  let currentFolder = baseFolder;
  folders.forEach((f) => {
    currentFolder = path.join(currentFolder, f);
    if (!fs.existsSync(currentFolder)) {
      fs.mkdirSync(currentFolder);
    }
  });

  return p;
};

/**
 * Download and convert a single URL,
 * retrieve and add tags to the MP3 file
 * @param url
 * @param outputFolder
 * @param callback Callback function
 * @param title string Optional requested title
 * @param infos object Basic infos to tag the file
 * @param v boolean Verbosity
 * @param options object { bitrate: '256k' } output audio bitrate
 * @return Event
 */
at3.downloadAndTagSingleURL = (url, outputFolder, callback, title, v, infos, options = {}) => {
  if (v === undefined) {
    v = false;
  }
  if (callback === undefined) {
    callback = () => {};
  }
  if (outputFolder.charAt(outputFolder.length - 1) !== path.sep) {
    outputFolder += path.sep;
  }
  title = title || '';
  const bitrate = options.bitrate || '256k';

  const progressEmitter = new EventEmitter();

  const tempFile = (at3.tempFolder || outputFolder) + randomstring.generate(10) + '.mp3';

  // Download and convert file
  const dl = at3.downloadSingleURL(url, tempFile, bitrate);
  const onDownload = (infos) => {
    progressEmitter.emit('download', infos);
  };
  const onConvert = (infos) => {
    progressEmitter.emit('convert', infos, infos);
  };
  dl.on('download', onDownload);
  dl.once('download-end', () => {
    dl.removeListener('download', onDownload);
    progressEmitter.emit('download-end');
  });
  dl.on('convert', onConvert);
  dl.once('error', (error) => {
    dl.removeListener('download', onDownload);
    dl.removeListener('convert', onConvert);
    callback(null, 'error');
    progressEmitter.emit('error', new Error(error));
  });
  progressEmitter.once('abort', () => {
    dl.emit('abort');
  });

  let infosFromString,
    infosFromFile,
    infosRequests = [];

  if (infos && infos.deezerId) {
    // If deezer track id is provided, with fetch more information
    let getMoreInfos = at3
      .getDeezerTrackInfos(infos.deezerId, v)
      .then((inf) => {
        infosFromString = inf;
      })
      .catch(() => {
        infosFromString = {
          title: infos.title,
          artistName: infos.artistName,
        };
      });

    infosRequests.push(getMoreInfos);
  } else if (infos && infos.spotifyId) {
    // If spotify track id is provided, with fetch more information
    let getMoreInfos = at3
      .getSpotifyTrackInfos(infos.spotifyId, v)
      .then((inf) => {
        infosFromString = inf;
      })
      .catch(() => {
        infosFromString = {
          title: infos.title,
          artistName: infos.artistName,
        };
      });
    infosRequests.push(getMoreInfos);
  } else {
    // Try to find information based on video title
    let getStringInfos = at3
      .getCompleteInfosFromURL(url, v)
      .then((inf) => {
        if (title === undefined) {
          title = inf.originalTitle;
        }
        infosFromString = inf;
        progressEmitter.emit('infos', _.clone(infosFromString));
      })
      .catch(() => {
        // The download must have failed to, and emit an error
      });

    infosRequests.push(getStringInfos);
  }

  // Try to find information based on MP3 file when dl is finished
  dl.once('end', () => {
    dl.removeListener('convert', onConvert);
    progressEmitter.emit('convert-end');

    if (!infos || (!infos.deezerId && !infos.spotifyId)) {
      let getFileInfos = at3.getCompleteInfosFromFile(tempFile, v).then((inf) => {
        infosFromFile = inf;
        if (infosFromFile && infosFromFile.title && infosFromFile.artistName) {
          progressEmitter.emit('infos', _.clone(infosFromFile));
        }
      });

      infosRequests.push(getFileInfos);
    }

    // [TODO] Improve network issue resistance
    Promise.all(infosRequests).then(() => {
      // ça on peut garder
      let infos = infosFromString;
      if (infosFromFile) {
        let scoreFromFile = Math.min(
          levenshtein.get(simpleName(infosFromFile.title + ' ' + infosFromFile.artistName), simpleName(title)),
          levenshtein.get(simpleName(infosFromFile.artistName + ' ' + infosFromFile.title), simpleName(title)),
        );
        let scoreFromString = Math.min(
          levenshtein.get(simpleName(infosFromString.title + ' ' + infosFromString.artistName), simpleName(title)),
          levenshtein.get(simpleName(infosFromString.artistName + ' ' + infosFromString.title), simpleName(title)),
        );

        if (v) {
          console.log('Infos from file score: ', scoreFromFile);
          console.log('Infos from string score: ', scoreFromString);
        }

        if (infosFromFile.cover && scoreFromFile < scoreFromString + Math.ceil(simpleName(title).length / 10.0)) {
          infos = infosFromFile;
        }
      }

      progressEmitter.emit('infos', _.clone(infos));

      if (v) {
        console.log('Final infos: ', infos);
      }

      at3
        .findLyrics(infos.title, infos.artistName)
        .then((lyrics) => {
          return new Promise((resolve, reject) => {
            fs.writeFile(tempFile + '.lyrics', lyrics, (error) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          });
        })
        .then(() => {
          infos.lyrics = tempFile + '.lyrics';
        })
        .catch(() => {
          // no lyrics
        })
        .finally(() => {
          return at3.tagFile(tempFile, infos);
        })
        .then(() => {
          let finalFile = outputFolder;
          finalFile += at3.formatSongFilename(infos.title, infos.artistName, infos.position) + '.mp3';
          fs.moveSync(tempFile, finalFile, { overwrite: true });
          if (infos.lyrics) {
            fs.unlinkSync(tempFile + '.lyrics');
          }
          const finalInfos = {
            infos: infos,
            file: finalFile,
          };
          progressEmitter.emit('end', finalInfos);
          callback(finalInfos);
        })
        .catch((err) => {
          progressEmitter.emit('error', err);
        });
    });
  });

  return progressEmitter;
};

/**
 * Search a query on YouTube and return the detailed results
 * @param query string
 * @param regionCode string ISO 3166-1 alpha-2 country code (ex: FR, US)
 * @param relevanceLanguage string ISO 639-1 two-letter language code (ex: en: fr)
 * @param v boolean Verbosity
 * @return Promise
 */
at3.searchOnYoutube = (query, regionCode, relevanceLanguage, v) => {
  if (v === undefined) {
    v = false;
  }

  /**
   * Remove useless information in the title
   * like (audio only), (lyrics)...
   * @param title string
   * @return string
   */
  const improveTitle = (title) => {
    let useless = [
      'audio only',
      'audio',
      'paroles/lyrics',
      'lyrics/paroles',
      'with lyrics',
      'w/lyrics',
      'w / lyrics',
      'avec paroles',
      'avec les paroles',
      'avec parole',
      'lyrics',
      'paroles',
      'parole',
      'radio edit.',
      'radio edit',
      'radio-edit',
      'shazam version',
      'shazam v...',
      'music video',
      'clip officiel',
      'officiel',
      'new song',
      'official video',
      'official',
    ];

    _.forEach(useless, (u) => {
      title = title.replace(new RegExp('((\\(|\\[)?)( ?)' + u + '( ?)((\\)|\\])?)', 'gi'), '');
    });

    title = title.replace(new RegExp('(\\(|\\[)( ?)hd( ?)(\\)|\\])', 'gi'), '');
    title = title.replace(new RegExp('hd', 'gi'), '');
    title = _.trim(title);

    return title;
  };

  // We simply search on YouTube
  return ytsr(query, { limit: 20 }).then(({ items }) => {
    const videos = items.filter((item) => item.type === 'video');

    if (videos.length === 0) {
      return Promise.reject();
    }

    return Promise.all(
      videos.map(async (video) => {
        const infoApiData = await ytdl.getInfo(video.url);
        const infos = infoApiData.videoDetails;
        const formats = infoApiData.formats;

        let ratio = 1.0;
        if (infos.dislikes > 0) {
          ratio = infos.likes / infos.dislikes;
        }
        if (ratio === 0) {
          ratio = 1;
        }
        const realLike = (infos.likes - infos.dislikes) * ratio;

        return {
          id: infos.videoId,
          url: video.url,
          title: improveTitle(infos.title),
          hd: formats.some(
            ({ qualityLabel }) => qualityLabel && (qualityLabel.startsWith('720p') || qualityLabel.startsWith('1080p')),
          ),
          duration: parseInt(infos.length_seconds, 10),
          views: video.views,
          realLike,
        };
      }),
    );
  });
};

/**
 * @param song Object Searched song
 * @param videos Array List of videos
 * @param v boolean Verbosity
 */
at3.findBestVideo = (song, videos, v) => {
  if (v === undefined) {
    v = false;
  }

  /**
   * Returns the score of a video, comparing to the request
   * @param song Object Searched song
   * @param video object
   * @param largestRealLike
   * @param largestViews
   * @return Object
   */
  const score = (song, video, largestRealLike, largestViews) => {
    // weight of each argument
    let weights = {
      title: 30,
      hd: 0.3,
      duration: 20,
      views: 10,
      realLike: 15,
    };

    let duration = song.duration || video.duration;

    // Score for title
    let videoTitle = ' ' + _.lowerCase(video.title) + ' ';
    let songTitle = ' ' + _.lowerCase(song.title) + ' '; // we add spaces to help longest-common-substring
    let songArtist = ' ' + _.lowerCase(song.artistName) + ' '; // (example: the artist "M")

    // for longest-common-substring, which works with arrays
    let videoTitlea = videoTitle.split('');
    let songTitlea = songTitle.split('');
    let songArtista = songArtist.split('');

    const videoSongTitle = lcs(videoTitlea, songTitlea);
    if (
      videoSongTitle.length > 0 &&
      videoSongTitle.startString2 === 0 &&
      videoTitle[videoSongTitle.startString1 + videoSongTitle.length - 1] === ' '
    ) {
      // The substring must start at the beginning of the song title, and the next char in the video title must be a space
      videoTitle =
        videoTitle.substring(0, videoSongTitle.startString1) +
        ' ' +
        videoTitle.substring(videoSongTitle.startString1 + videoSongTitle.length);
      videoTitlea = videoTitle.split('');
    }
    const videoSongArtist = lcs(videoTitlea, songArtista);
    if (
      videoSongArtist.length > 0 &&
      videoSongArtist.startString2 === 0 &&
      videoTitle[videoSongArtist.startString1 + videoSongArtist.length - 1] === ' '
    ) {
      // The substring must start at the beginning of the song title, and the next char in the video title must be a space
      videoTitle =
        videoTitle.substring(0, videoSongArtist.startString1) +
        videoTitle.substring(videoSongArtist.startString1 + videoSongArtist.length);
    }

    videoTitle = _.lowerCase(videoTitle);
    const sTitle =
      videoTitle.length + (songTitle.length - videoSongTitle.length) + (songArtist.length - videoSongArtist.length);

    const videoScore = {
      title: sTitle * weights.title,
      hd: video.hd * weights.hd,
      duration: Math.sqrt(Math.abs(video.duration - duration)) * weights.duration,
      views: (video.views / largestViews) * weights.views,
      realLike: (video.realLike / largestRealLike) * weights.realLike || -50, // video.realLike is NaN when the likes has been deactivated, which is a very bad sign
    };
    video.videoScore = videoScore;

    let preVideoScore = videoScore.views + videoScore.realLike - videoScore.title - videoScore.duration;
    preVideoScore = preVideoScore + Math.abs(preVideoScore) * videoScore.hd;

    return preVideoScore;
  };

  const largestRealLike = _.reduce(
    videos,
    (v, r) => {
      if (r.realLike > v) {
        return r.realLike;
      }
      return v;
    },
    0,
  );
  const largestViews = _.reduce(
    videos,
    (v, r) => {
      if (r.views > v) {
        return r.views;
      }
      return v;
    },
    0,
  );

  _.forEach(videos, (r) => {
    r.score = score(song, r, largestRealLike, largestViews);
  });

  return _.reverse(_.sortBy(videos, 'score'));
};

/**
 * Try to find the best video matching a song
 * @param song Object Searched song
 * @param v boolean Verbosity
 * @return Promise
 */
at3.findVideoForSong = (song, v) => {
  if (v === undefined) {
    v = false;
  }

  let query = song.title + ' - ' + song.artistName;
  return at3.searchOnYoutube(query, at3.regionCode, at3.relevanceLanguage, v).then((youtubeResults) => {
    return at3.findBestVideo(song, youtubeResults, v);
  });
};

// [TODO] we could also add a method that just take the first youtube video and download it
/**
 * Try to find the best video matching a song request
 * @param query string
 * @param v boolean Verbosity
 * @return Promise
 */
at3.findVideo = (query, v) => {
  if (v === undefined) {
    v = false;
  }

  // We try to find the song
  return at3
    .guessTrackFromString(query, true, false, v)
    .then((guessStringInfos) => {
      if (guessStringInfos.title && guessStringInfos.artistName) {
        return at3.retrieveTrackInformations(guessStringInfos.title, guessStringInfos.artistName, true, v);
      } else {
        return Promise.reject({ error: 'No song corresponds to your query' });
      }
    })
    .then((song) => {
      return at3.findVideoForSong(song, v);
    });
};

/**
 * Find a song from a query, then download the corresponding video,
 * convert and tag it
 * @param query string
 * @param outputFolder
 * @param callback Callback function
 * @param v boolean Verbosity
 * @return Event
 */
at3.findAndDownload = (query, outputFolder, callback, v) => {
  if (v === undefined) {
    v = false;
  }
  const progressEmitter = new EventEmitter();

  at3
    .findVideo(query, v)
    .then((results) => {
      if (results.length === 0) {
        progressEmitter.emit('error', new Error('Cannot find any video matching'));
        return callback(null, 'Cannot find any video matching');
      }
      let i = 0;
      progressEmitter.emit('search-end');
      let dl = at3.downloadAndTagSingleURL(results[i].url, outputFolder, callback, query);

      const onDownload = (infos) => {
        progressEmitter.emit('download', infos);
      };
      const onConvert = (infos) => {
        progressEmitter.emit('convert', infos);
      };
      const onInfos = (infos) => {
        progressEmitter.emit('infos', infos);
      };

      dl.on('download', onDownload);
      dl.once('download-end', () => {
        dl.removeListener('download', onDownload);
        progressEmitter.emit('download-end');
      });
      dl.on('convert', onConvert);
      dl.once('convert-end', () => {
        dl.removeListener('convert', onConvert);
        progressEmitter.emit('convert-end');
      });
      dl.on('infos', onInfos);
      dl.once('error', (error) => {
        dl.removeListener('download', onDownload);
        dl.removeListener('convert', onConvert);
        dl.removeListener('infos', onInfos);
        // [TODO]: try to download the next video, in case of ytdl error only
        // if (i < results.length) {
        //     dl = at3.downloadAndTagSingleURL(results[i++].url, outputFolder, callback, query);
        // } else {
        progressEmitter.emit('error', new Error(error));
        // }
      });
      dl.once('end', () => {
        dl.removeListener('infos', onInfos);
      });
    })
    .catch(() => {
      progressEmitter.emit('error', new Error('Cannot find any video matching'));
      return callback(null, 'Cannot find any video matching');
    });

  return progressEmitter;
};

/**
 * Find videos for a track, and download it
 * @param track trackInfos
 * @param outputFolder
 * @param callback Callback function
 * @param v boolean Verbosity
 * @return Event
 */
at3.downloadTrack = (track, outputFolder, callback, v) => {
  if (v === undefined) {
    v = false;
  }
  const progressEmitter = new EventEmitter();
  let aborted = false;

  at3
    .findVideoForSong(track, v)
    .then((results) => {
      if (aborted) {
        return;
      }
      if (results.length === 0) {
        progressEmitter.emit('error', new Error('Cannot find any video matching'));
        return callback(null, 'Cannot find any video matching');
      }
      let i = 0;
      progressEmitter.emit('search-end');
      const dlNext = () => {
        if (i >= results.length) {
          progressEmitter.emit('error', new Error('Cannot find any video matching'));
          return;
        }
        if (v) {
          console.log('Will be downloaded:', results[i].url);
        }
        let aborted = false;
        let dl = at3.downloadAndTagSingleURL(results[i].url, outputFolder, callback, '', v, track);
        const onDownload = (infos) => {
          progressEmitter.emit('download', infos);
        };
        const onConvert = (infos) => {
          progressEmitter.emit('convert', infos);
        };
        const onInfos = (infos) => {
          progressEmitter.emit('infos', infos);
        };
        dl.on('download', onDownload);
        dl.once('download-end', () => {
          dl.removeListener('download', onDownload);
          progressEmitter.emit('download-end');
        });
        dl.on('convert', onConvert);
        dl.once('convert-end', () => {
          dl.removeListener('convert', onConvert);
          progressEmitter.emit('convert-end');
        });
        dl.on('infos', onInfos);
        dl.once('end', (finalInfos) => {
          dl.removeListener('infos', onInfos);
          progressEmitter.emit('end', finalInfos);
        });
        dl.once('error', (_error) => {
          dl.removeListener('download', onDownload);
          dl.removeListener('convert', onConvert);
          dl.removeListener('infos', onInfos);
          i += 1;
          aborted = true;
          dlNext();
        });
        progressEmitter.once('abort', () => {
          if (!aborted) {
            dl.emit('abort');
          }
        });
      };
      dlNext();
    })
    .catch(() => {
      progressEmitter.emit('error', new Error('Cannot find any video matching'));
      return callback(null, 'Cannot find any video matching');
    });

  progressEmitter.on('abort', () => {
    aborted = true;
  });

  return progressEmitter;
};

/**
 * Return URLs contained in a playlist (YouTube or SoundCloud)
 * @param url
 * @return Promise(object)
 */
at3.getPlaylistURLsInfos = (url) => {
  let type = at3.guessURLType(url);

  if (type === 'youtube') {
    let playlistId = url.match(/list=([0-9a-zA-Z_-]+)/);
    playlistId = playlistId[1];
    return ytpl(playlistId).then((playlist) => {
      return {
        title: playlist.title,
        cover: playlist.author.avatar,
        artistName: playlist.author.name,
        items: playlist.items.map((item) => {
          return {
            url: item.url_simple,
            title: item.title,
            cover: item.thumbnail,
          };
        }),
      };
    });
  } else if (type === 'soundcloud') {
    return request({
      url: 'http://api.soundcloud.com/resolve?client_id=' + API_SOUNDCLOUD + '&url=' + url,
      json: true,
    }).then((playlistDetails) => {
      let playlistInfos = {
        title: playlistDetails.title,
        artistName: playlistDetails.user.username,
        cover: playlistDetails.artwork_url,
      };
      let items = [];

      _.forEach(playlistDetails.tracks, (track) => {
        items.push({
          url: track.permalink_url,
          title: track.title,
          cover: track.artwork_url,
          artistName: track.user.username,
        });
      });

      playlistInfos.items = items;

      return playlistInfos;
    });
  }
};

/**
 * Returns info (title, cover, songs) about a playlist (Deezer or Spotify)
 * @param url
 * @return Promise(object)
 */
at3.getPlaylistTitlesInfos = (url) => {
  // Deezer Playlist
  // Deezer Album
  // Deezer Loved Tracks [TODO]
  // Spotify playlist
  // Spotify Album
  const type = at3.guessURLType(url);

  const regDeezerPlaylist = /playlist\/([0-9]+)/;
  const regDeezerAlbum = /album\/([0-9]+)/;

  const regSpotifyPlaylist = /playlist\/([0-9a-zA-Z]+)/;
  const regSpotifyAlbum = /album\/([0-9a-zA-Z]+)/;

  if (type === 'deezer') {
    // Deezer Playlist
    if (regDeezerPlaylist.test(url)) {
      const playlistId = url.match(regDeezerPlaylist)[1];

      return request({
        url: 'https://api.deezer.com/playlist/' + playlistId,
        json: true,
      }).then((playlistDetails) => {
        const playlist = {};
        const items = [];

        playlist.title = playlistDetails.title;
        playlist.artistName = playlistDetails.creator.name;
        playlist.cover = playlistDetails.picture_big;

        _.forEach(playlistDetails.tracks.data, (track) => {
          items.push({
            title: track.title,
            artistName: track.artist.name,
            deezerId: track.id,
            album: track.album.title,
            cover: track.album.cover,
          });
        });

        playlist.items = items;

        return playlist;
      });
    } else if (regDeezerAlbum.test(url)) {
      // Deezer Album
      let albumId = url.match(regDeezerAlbum)[1];
      let albumInfos = {};

      return request({
        url: 'https://api.deezer.com/album/' + albumId,
        json: true,
      })
        .then((ralbumInfos) => {
          albumInfos.cover = ralbumInfos.cover_big;
          albumInfos.title = ralbumInfos.title;
          albumInfos.artistName = ralbumInfos.artist.name;

          return request({
            url: 'https://api.deezer.com/album/' + albumId + '/tracks',
            json: true,
          });
        })
        .then((albumTracks) => {
          let items = [];

          _.forEach(albumTracks.data, (track) => {
            items.push({
              title: track.title,
              artistName: track.artist.name,
              deezerId: track.id,
              album: albumInfos.title,
              cover: albumInfos.cover,
              duration: track.duration,
            });
          });

          albumInfos.items = items;

          return albumInfos;
        });
    }
  } else if (type === 'spotify') {
    // Spotify Playlist
    if (regSpotifyPlaylist.test(url)) {
      const playlistId = url.match(regSpotifyPlaylist)[1];

      return at3.requestSpotify('https://api.spotify.com/v1/playlists/' + playlistId).then((playlistDetails) => {
        const playlist = {};
        const items = [];

        playlist.title = playlistDetails.name;
        playlist.artistName = playlistDetails.owner.id;
        playlist.cover = playlistDetails.images[0].url;

        playlist.items = items;

        const processSpotifyPage = (page) => {
          page.items.forEach((t) => {
            let track = t.track;
            items.push({
              title: track.name,
              artistName: track.artists[0].name,
              spotifyId: track.id,
              album: track.album.name,
              cover: track.album.images[0] ? track.album.images[0].url : undefined,
              duration: Math.ceil(track.duration_ms / 1000),
            });
          });

          if (page.next) {
            return at3.requestSpotify(page.next).then(processSpotifyPage);
          } else {
            return playlist;
          }
        };

        return processSpotifyPage(playlistDetails.tracks);
      });
    } else if (regSpotifyAlbum.test(url)) {
      // Spotify Album
      let albumId = url.match(regSpotifyAlbum)[1];
      let albumInfos = {};

      return at3.requestSpotify('https://api.spotify.com/v1/albums/' + albumId).then((ralbumInfos) => {
        albumInfos.title = ralbumInfos.name;
        albumInfos.artistName = ralbumInfos.artists[0].name;
        albumInfos.cover = ralbumInfos.images[0].url;

        let items = [];

        ralbumInfos.tracks.items.forEach((track) => {
          items.push({
            title: track.name,
            artistName: track.artists[0].name,
            spotifyId: track.id,
            album: albumInfos.title,
            cover: albumInfos.cover,
            duration: Math.ceil(track.duration_ms / 1000),
          });
        });

        albumInfos.items = items;

        return albumInfos;
      });
    }
  }
};

/**
 * Download a playlist containing URLs
 * @param url {string}
 * @param outputFolder {string}
 * @param callback {Function}
 * @param maxSimultaneous {number} Maximum number of simultaneous track processing
 * @param subPathFormat {string} The format of the subfolder: {artist}/{title}/
 * @return {Event}
 */
at3.downloadPlaylistWithURLs = (url, outputFolder, callback, maxSimultaneous, subPathFormat) => {
  if (maxSimultaneous === undefined) {
    maxSimultaneous = 1;
  }
  if (subPathFormat === undefined) {
    subPathFormat = '';
  }

  const emitter = new EventEmitter();
  let running = 0;
  let lastIndex = 0;
  let aborted = false;

  at3.getPlaylistURLsInfos(url).then((playlistInfos) => {
    if (aborted) {
      return;
    }

    outputFolder = at3.createSubPath(outputFolder, subPathFormat, playlistInfos.title, playlistInfos.artistName);

    emitter.emit('playlist-infos', playlistInfos);

    for (let i = 0; i < maxSimultaneous; i += 1) {
      downloadNext(playlistInfos.items, i);
    }
  });

  const downloadNext = (urls, currentIndex) => {
    if (aborted) {
      return;
    }
    if (urls.length === currentIndex) {
      if (running === 0) {
        emitter.emit('end');
        callback(urls);
      }
      return;
    }
    running += 1;
    if (currentIndex > lastIndex) {
      lastIndex = currentIndex;
    }

    if (currentIndex > urls.length) {
      return;
    }

    const currentUrl = urls[currentIndex];

    currentUrl.progress = {};

    emitter.emit('begin-url', currentIndex);

    const dl = at3.downloadAndTagSingleURL(currentUrl.url, outputFolder, (infos, _error) => {
      if (infos) {
        currentUrl.file = infos.file;
        currentUrl.infos = infos.infos;
      }
      running -= 1;

      emitter.emit('end-url', currentIndex);

      if (running < maxSimultaneous) {
        downloadNext(urls, lastIndex + 1);
      }
    });

    emitter.once('abort', () => {
      aborted = true;
      dl.emit('abort');
    });

    const onDownload = (infos) => {
      currentUrl.progress.download = infos;
      emitter.emit('download', currentIndex);
    };
    const onConvert = (infos) => {
      currentUrl.progress.convert = infos;
      emitter.emit('convert', currentIndex);
    };
    const onInfos = (infos) => {
      currentUrl.infos = infos;
      emitter.emit('infos', currentIndex);
    };

    dl.on('download', onDownload);
    dl.once('download-end', () => {
      dl.removeListener('download', onDownload);
      emitter.emit('download-end', currentIndex);
      if (running < maxSimultaneous) {
        downloadNext(urls, lastIndex + 1);
      }
    });
    dl.on('convert', onConvert);
    dl.once('convert-end', () => {
      dl.removeListener('convert', onConvert);
      emitter.emit('convert-end', currentIndex);
    });
    dl.on('infos', onInfos);
    dl.once('error', () => {
      dl.removeListener('download', onDownload);
      dl.removeListener('convert', onConvert);
      dl.removeListener('infos', onInfos);
      emitter.emit('error', new Error(currentIndex));
      if (running < maxSimultaneous) {
        downloadNext(urls, lastIndex + 1);
      }
    });
    dl.once('end', () => {
      dl.removeListener('infos', onInfos);
    });
  };

  emitter.once('abort', () => {
    aborted = true;
  });

  return emitter;
};

/**
 * Download a playlist containing titles
 * @param url {string}
 * @param outputFolder {string}
 * @param callback {Function}
 * @param maxSimultaneous {number} Maximum number of simultaneous track processing
 * @param subPathFormat {string} The format of the subfolder: {artist}/{title}/
 * @return {Event}
 */
at3.downloadPlaylistWithTitles = (url, outputFolder, callback, maxSimultaneous, subPathFormat) => {
  if (maxSimultaneous === undefined) {
    maxSimultaneous = 1;
  }
  if (subPathFormat === undefined) {
    subPathFormat = '';
  }

  const emitter = new EventEmitter();
  let running = 0;
  let lastIndex = 0;
  let aborted = false;

  at3.getPlaylistTitlesInfos(url).then((playlistInfos) => {
    if (aborted) {
      return;
    }

    outputFolder = at3.createSubPath(outputFolder, subPathFormat, playlistInfos.title, playlistInfos.artistName);

    emitter.emit('playlist-infos', playlistInfos);

    for (let i = 0; i < maxSimultaneous; i += 1) {
      downloadNext(playlistInfos.items, i);
    }
  });

  const downloadNext = (urls, currentIndex) => {
    if (aborted) {
      return;
    }
    if (urls.length === currentIndex) {
      if (running === 0) {
        emitter.emit('end');
        callback(urls);
      }
      return;
    }
    running += 1;
    if (currentIndex > lastIndex) {
      lastIndex = currentIndex;
    }

    if (currentIndex > urls.length) {
      return;
    }

    let currentTrack = urls[currentIndex];

    currentTrack.progress = {};

    emitter.emit('begin-url', currentIndex);

    at3
      .findVideoForSong(currentTrack)
      .then((videos) => {
        if (aborted) {
          return;
        }
        emitter.emit('search-end', currentIndex);

        const downloadFinished = (infos, error) => {
          if (!infos || error) {
            return;
          }
          currentTrack.file = infos.file;
          currentTrack.infos = infos.infos;
          running -= 1;

          emitter.emit('end-url', currentIndex);

          if (running < maxSimultaneous) {
            downloadNext(urls, lastIndex + 1);
          }
        };

        let i = 0;

        const handleDl = (dl) => {
          const onDownload = (infos) => {
            currentTrack.progress.download = infos;
            emitter.emit('download', currentIndex);
          };
          const onConvert = (infos) => {
            currentTrack.progress.convert = infos;
            emitter.emit('convert', currentIndex);
          };
          const onInfos = (infos) => {
            currentTrack.infos = infos;
            emitter.emit('infos', currentIndex);
          };

          dl.on('download', onDownload);
          dl.once('download-end', () => {
            dl.removeListener('download', onDownload);
            emitter.emit('download-end', currentIndex);
            if (running < maxSimultaneous) {
              downloadNext(urls, lastIndex + 1);
            }
          });
          dl.on('convert', onConvert);
          dl.once('convert-end', () => {
            dl.removeListener('convert', onConvert);
            emitter.emit('convert-end', currentIndex);
          });
          dl.on('infos', onInfos);
          dl.once('end', () => {
            dl.removeListener('infos', onInfos);
          });
          dl.once('error', () => {
            dl.removeListener('download', onDownload);
            dl.removeListener('convert', onConvert);
            if (i < videos.length - 1) {
              i += 1;
              handleDl(
                at3.downloadAndTagSingleURL(
                  videos[i].url,
                  outputFolder,
                  downloadFinished,
                  undefined,
                  false,
                  currentTrack,
                ),
              );
            } else {
              emitter.emit('error', new Error(currentIndex));
              if (running < maxSimultaneous) {
                downloadNext(urls, lastIndex + 1);
              }
            }
          });
          emitter.once('abort', () => {
            aborted = true;
            dl.emit('abort');
          });
        };

        handleDl(
          at3.downloadAndTagSingleURL(videos[i].url, outputFolder, downloadFinished, undefined, false, currentTrack),
        );
      })
      .catch((err) => {
        emitter.emit('error', new Error(currentIndex));
        if (running < maxSimultaneous) {
          downloadNext(urls, lastIndex + 1);
        }
      });
  };

  emitter.once('abort', () => {
    aborted = true;
  });

  return emitter;
};

/**
 * Download a playlist containing urls or titles
 * @param url {string}
 * @param outputFolder {string}
 * @param callback {Function}
 * @param maxSimultaneous {number} Maximum number of simultaneous track processing
 * @return {Event}
 */
at3.downloadPlaylist = (url, outputFolder, callback, maxSimultaneous, subPathFormat) => {
  const type = at3.guessURLType(url);
  const sitesTitles = ['deezer', 'spotify'];
  const sitesURLs = ['youtube', 'soundcloud'];

  if (sitesTitles.indexOf(type) >= 0) {
    return at3.downloadPlaylistWithTitles(url, outputFolder, callback, maxSimultaneous, subPathFormat);
  } else if (sitesURLs.indexOf(type) >= 0) {
    return at3.downloadPlaylistWithURLs(url, outputFolder, callback, maxSimultaneous, subPathFormat);
  } else {
    callback(null, 'Website not supported yet');
    return new EventEmitter().emit('error', new Error('Website not supported yet'));
  }
};

/**
 * Download a track from an URL
 * @param url
 * @param outputFolder
 * @param callback
 * @param v boolean Verbose
 * @return Event
 */
at3.downloadTrackURL = (url, outputFolder, callback, v) => {
  if (v === undefined) {
    v = false;
  }
  const type = at3.guessURLType(url);
  const emitter = new EventEmitter();

  if (type === 'spotify') {
    const trackId = url.match(/\/track\/([0-9a-zA-Z]+)/)[1];
    at3.requestSpotify('https://api.spotify.com/v1/tracks/' + trackId).then((trackInfos) => {
      const track = {
        title: trackInfos.name,
        artistName: trackInfos.artists[0].name,
        duration: Math.ceil(trackInfos.duration_ms / 1000),
        spotifyId: trackId,
        cover: trackInfos.album.images[0].url,
      };
      const e = at3.downloadTrack(track, outputFolder, callback, v);

      at3.forwardEvents(e, emitter);
    });
  } else if (type === 'deezer') {
    const trackId = url.match(/\/track\/([0-9]+)/)[1];
    at3.getDeezerTrackInfos(trackId, v).then((trackInfos) => {
      const e = at3.downloadTrack(trackInfos, outputFolder, callback, v);

      at3.forwardEvents(e, emitter);
    });
  }

  return emitter;
};

/**
 * Forward any classical event from e1 to e2, and abort from e2 to e1
 * @param e1 Event The source
 * @param e2 Event the destination
 * @return e2
 */
at3.forwardEvents = (e1, e2) => {
  const events = [
    'download',
    'download-end',
    'convert',
    'convert-end',
    'infos',
    'error',
    'playlist-infos',
    'begin-url',
    'end-url',
    'end',
    'search-end',
  ];
  events.forEach((e) => {
    e1.on(e, (data) => {
      e2.emit(e, data);
    });
  });
  e2.once('abort', () => {
    e1.emit('abort');
  });
  return e2;
};

/**
 * Return the suggested songs for the query
 * @param query string
 * @param limit number
 * @return Promise<array<trackInfos>> Array of potential songs
 */
at3.suggestedSongs = (query, limit) => {
  if (!limit) {
    limit = 5;
  }

  return request({
    uri: 'https://api.deezer.com/search?limit=' + limit + '&q=' + encodeURIComponent(query),
    json: true,
  }).then((results) => {
    return _.map(results.data, (r) => {
      return {
        title: r.title,
        artistName: r.artist.name,
        duration: r.duration,
        cover: r.album.cover_medium,
        deezerId: r.id,
      };
    });
  });
};

/**
 * Return the suggested albums for the query
 * @param query string
 * @param limit number
 * @return Promise<array<Object>> Array of potential albums
 */
at3.suggestedAlbums = (query, limit) => {
  if (!limit) {
    limit = 5;
  }

  return request({
    uri: 'https://api.deezer.com/search/album?limit=' + limit + '&q=' + encodeURIComponent(query),
    json: true,
  }).then((results) => {
    return _.map(results.data, (r) => {
      return {
        title: r.title,
        artistName: r.artist.name,
        cover: r.cover_medium,
        deezerId: r.id,
        link: r.link,
        nbTracks: r.nb_tracks,
      };
    });
  });
};

/**
 * Return the type of the query
 * @param query string
 * @return string: text, single-url, playlist-url, track-url, not-supported
 */
at3.typeOfQuery = (query) => {
  if (!at3.isURL(query)) {
    return 'text';
  }
  const type = at3.guessURLType(query);
  if (!type) {
    return 'not-supported';
  }

  if (type === 'youtube' && /list=([0-9a-zA-Z_-]+)/.test(query)) {
    return 'playlist-url';
  } else if (type === 'deezer') {
    if (/\/(playlist|album)\//.test(query)) {
      return 'playlist-url';
    } else if (/\/track\//.test(query)) {
      return 'track-url';
    }
    return 'not-supported';
  } else if (type === 'soundcloud' && /\/sets\//.test(query)) {
    return 'playlist-url';
  } else if (type === 'spotify') {
    if (/\/(playlist|album)\//.test(query)) {
      return 'playlist-url';
    } else if (/\/track\//.test(query)) {
      return 'track-url';
    }
    return 'not-supported';
  }

  return 'single-url';
};

/**
 * Return URL type
 * @param url
 * @return string
 */
at3.guessURLType = (url) => {
  if (/^(https?:\/\/)?((www|m)\.)?((youtube\.([a-z]{2,4}))|(youtu\.be))/.test(url)) {
    return 'youtube';
  } else if (/^(https?:\/\/)?(((www)|(m))\.)?(soundcloud\.([a-z]{2,4}))/.test(url)) {
    return 'soundcloud';
  } else if (/^(https?:\/\/)?(www\.)?(deezer\.([a-z]{2,4}))\//.test(url)) {
    return 'deezer';
  } else if (/^(https?:\/\/)?((open|play)\.)?spotify\.([a-z]{2,4})/.test(url)) {
    return 'spotify';
  }
};

const imatch = (textSearched, text) => {
  // [TODO] Improve this function (use .test and espace special caracters + use it everywhere else)
  return text.match(new RegExp(textSearched, 'gi'));
};
const vsimpleName = (text, exact) => {
  if (exact === undefined) {
    exact = false;
  }
  text = text.toLowerCase();
  if (!exact) {
    // text = text.replace('feat', '');
  }
  text = text.replace(/((\[)|(\())?radio edit((\])|(\)))?/gi, '');
  text = text.replace(/[^a-zA-Z0-9]/gi, '');
  return text;
};
const delArtist = (artist, text, exact) => {
  if (exact === undefined) {
    exact = false;
  }
  if (vsimpleName(artist).length <= 2) {
    // Artist with a very short name (Mathieu Chedid - M)
    return vsimpleName(text, exact);
  } else {
    // [TODO] Improve, escape regex special caracters in vsimpleName(artist)
    return vsimpleName(text, exact).replace(new RegExp(vsimpleName(artist), 'ig'), '');
  }
};
const simpleName = (text) => {
  return text.replace(/\(.+\)/g, '');
};

module.exports = at3;
