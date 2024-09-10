require('dotenv').config();
const Fastify = require('fastify');
const axios = require('axios');
const querystring = require('querystring');
const fs = require('fs');
const path = require('path');
const { OpenAI } = require('openai');
const { blue, white, green, magenta, red } = require('console-log-colors');
const { format } = require('date-fns');

// Command line arguments
let [, , amount, playlistName, playlistDescription] = process.argv;

if (!playlistName || !playlistDescription || !amount) {
  console.error(
    'Please provide the amount, playlist name and description as command line arguments.'
  );
  process.exit(1);
}

playlistName = '[QRSong] ' + playlistName;

const fastify = Fastify({ logger: false });

const openai = new OpenAI({
  apiKey: process.env['OPENAI_TOKEN'],
});

const client_id = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
const redirect_uri = 'http://localhost:8888/callback'; // Ensure this matches the registered URI

const TOKEN_PATH = path.join(__dirname, 'spotify_tokens.json');

function saveTokens(tokens) {
  fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
}

function loadTokens() {
  if (fs.existsSync(TOKEN_PATH)) {
    const tokens = fs.readFileSync(TOKEN_PATH);
    return JSON.parse(tokens);
  }
  return null;
}

fastify.get('/login', (request, reply) => {
  const scope = 'playlist-modify-public';
  reply.redirect(
    'https://accounts.spotify.com/authorize?' +
      querystring.stringify({
        response_type: 'code',
        client_id: client_id,
        scope: scope,
        redirect_uri: redirect_uri,
      })
  );
});

fastify.get('/callback', async (request, reply) => {
  const code = request.query.code || null;
  const authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    form: {
      code: code,
      redirect_uri: redirect_uri,
      grant_type: 'authorization_code',
    },
    headers: {
      Authorization:
        'Basic ' +
        Buffer.from(client_id + ':' + client_secret).toString('base64'),
    },
    json: true,
  };

  try {
    const response = await axios.post(
      authOptions.url,
      querystring.stringify(authOptions.form),
      {
        headers: authOptions.headers,
      }
    );

    const access_token = response.data.access_token;
    const refresh_token = response.data.refresh_token;

    // Save tokens to JSON file
    saveTokens({ access_token, refresh_token });

    reply.send('Authentication successful! You can close this window.');
  } catch (error) {
    fastify.log.error(
      'Error during authentication:',
      error.response ? error.response.data : error.message
    );
    reply.send('Authentication failed.');
  }
});

// Function to refresh access token
async function refreshAccessToken() {
  const tokens = loadTokens();
  if (!tokens || !tokens.refresh_token) {
    throw new Error('No refresh token available');
  }

  const authOptions = {
    url: 'https://accounts.spotify.com/api/token',
    form: {
      grant_type: 'refresh_token',
      refresh_token: tokens.refresh_token,
    },
    headers: {
      Authorization:
        'Basic ' +
        Buffer.from(client_id + ':' + client_secret).toString('base64'),
    },
    json: true,
  };

  try {
    const response = await axios.post(
      authOptions.url,
      querystring.stringify(authOptions.form),
      {
        headers: authOptions.headers,
      }
    );

    const access_token = response.data.access_token;
    tokens.access_token = access_token;
    saveTokens(tokens);
    return access_token;
  } catch (error) {
    fastify.log.error(
      'Error refreshing access token:',
      error.response ? error.response.data : error.message
    );
  }
}

// Function to create a Spotify playlist
async function createSpotifyPlaylist(accessToken, userId, name, description) {
  const response = await axios.post(
    `https://api.spotify.com/v1/users/${userId}/playlists`,
    {
      name: name,
      description: description,
      public: true,
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
  return response.data.id;
}

// Function to search for a Spotify track
async function searchSpotifyTrack(accessToken, artist, title) {
  const response = await axios.get('https://api.spotify.com/v1/search', {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
    params: {
      q: `artist:${artist} track:${title}`,
      type: 'track',
      limit: 1,
    },
  });

  return response.data.tracks.items[0]?.uri;
}

// Function to add tracks to a Spotify playlist
async function addTracksToSpotifyPlaylist(accessToken, playlistId, trackUris) {
  await axios.post(
    `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
    {
      uris: trackUris,
    },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

// Function to parse the list of tracks
async function parseList({ tracks }) {
  return tracks;
}

function log(message) {
  const timestamp = format(new Date(), 'dd-MM-yyyy HH:mm.ss.SSS');
  const coloredTimestamp = white.bold(`${timestamp}`);
  console.log(`${coloredTimestamp} - ${message}`);
}

// Function to get existing playlist by name
async function getPlaylistByName(accessToken, userId, name) {
  let playlists = [];
  let nextUrl = `https://api.spotify.com/v1/users/${userId}/playlists`;

  while (nextUrl) {
    const response = await axios.get(nextUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
      },
    });

    playlists = playlists.concat(response.data.items);
    nextUrl = response.data.next; // URL for the next page of results, or null if there are no more results
  }

  // Output the names of the playlists
  log(blue.bold('Found the following existing playlists'));

  for (const playlist of playlists) {
    log(magenta('Found playlist: ' + white.bold(playlist.name)));
  }

  const playlist = playlists.find((playlist) => playlist.name === name);
  return playlist ? playlist.id : null;
}

// Function to get tracks from a playlist with pagination support
async function getTracksFromPlaylist(accessToken, playlistId) {
  let tracks = [];
  let nextUrl = `https://api.spotify.com/v1/playlists/${playlistId}/tracks`;

  while (nextUrl) {
    try {
      const response = await axios.get(nextUrl, {
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      tracks = tracks.concat(
        response.data.items.map((item) => ({
          id: item.track.id,
          artist: item.track.artists[0].name,
          title: item.track.name,
        }))
      );

      nextUrl = response.data.next; // URL for the next page of results, or null if there are no more results
    } catch (error) {
      console.error(
        'Error fetching tracks:',
        error.response ? error.response.data : error.message
      );
      break;
    }
  }

  return tracks;
}

// Your existing getSongs function
async function getSongs() {
  try {
    let tokens = loadTokens();
    let accessToken = tokens ? tokens.access_token : null;
    if (!accessToken) {
      accessToken = await refreshAccessToken();
    }

    const userId = 'rickman9';
    let playlistId = await getPlaylistByName(accessToken, userId, playlistName);
    let existingTracks = [];

    if (playlistId) {
      existingTracks = await getTracksFromPlaylist(accessToken, playlistId);
    }

    log(blue.bold('Existing tracks: ') + white.bold(existingTracks.length));

    const existingTrackIds = existingTracks.map((track) => track.id);

    let prompt =
      `Come up with ${amount} songs for a QR Music card game. Do not send duplicate titles. Make it diverse and span across as many decades as possible with as many different artist as possible. The theme for the songs is: ` +
      playlistDescription;

    if (existingTracks.length > 0) {
      prompt += `. Do not include the following songs: ${existingTracks
        .map((track) => `${track.artist} - ${track.title}`)
        .join(', ')}`;
    }

    log(blue.bold('Prompt: ' + white.bold(prompt)));

    const result = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      temperature: 0.8,
      messages: [
        {
          role: 'system',
          content: `You are a helpful assistant that creates Hitster card lists`,
        },
        {
          role: 'user',
          content: prompt,
        },
      ],
      function_call: { name: 'parseList' },
      functions: [
        {
          name: 'parseList',
          description: 'Creates a hitster list from the provided list of songs',
          parameters: {
            type: 'object',
            properties: {
              tracks: {
                type: 'array',
                description: 'An array of music tracks',
                items: {
                  type: 'object',
                  description: 'A track',
                  properties: {
                    artist: {
                      type: 'string',
                      description: 'Name of the artist of the track',
                    },
                    title: {
                      description: 'The title of the song',
                      type: 'string',
                    },
                    releaseYear: {
                      description: 'The year in which the song was released',
                      type: 'string',
                    },
                  },
                  required: ['artist', 'title', 'releaseYear'],
                },
              },
            },
            required: ['tracks'],
          },
        },
      ],
    });

    if (result) {
      if (result.choices[0].message.function_call) {
        const funcCall = result.choices[0].message.function_call;
        const functionCallName = funcCall.name;
        const completionArguments = JSON.parse(funcCall.arguments);
        if (functionCallName == 'parseList') {
          const tracks = await parseList(completionArguments);

          if (!playlistId) {
            playlistId = await createSpotifyPlaylist(
              accessToken,
              userId,
              playlistName,
              playlistDescription
            );
          }

          const trackUris = [];

          for (const track of tracks) {
            const trackUri = await searchSpotifyTrack(
              accessToken,
              track.artist,
              track.title
            );

            if (
              trackUri &&
              !existingTrackIds.includes(trackUri.split(':').pop())
            ) {
              trackUris.push(trackUri);
              log(
                blue.bold(
                  `Added track: ${white.bold(track.artist)} - ${white.bold(
                    track.title
                  )} - ${white.bold(track.releaseYear)}`
                )
              );
            } else {
              log(
                red.bold(
                  `Track not found or already exists: ${white.bold(
                    track.artist
                  )} - ${white.bold(track.title)}`
                )
              );
            }
          }

          if (trackUris.length > 0) {
            await addTracksToSpotifyPlaylist(
              accessToken,
              playlistId,
              trackUris
            );
            log(green.bold('Tracks added successfully!'));
          } else {
            log(green.bold('No new tracks to add.'));
          }
        }
      }
    }
  } catch (error) {
    const errorMessage = error.response
      ? error.response.data.error.message
      : error.message;
    log(red.bold('Error fetching songs: ') + white.bold(errorMessage));
    if (errorMessage == 'The access token expired') {
      require('openurl').open('http://localhost:8888/login');
    }
  }
}

fastify.listen({ port: 8888 }, (err, address) => {
  if (err) {
    fastify.log.error(err);
    process.exit(1);
  }
  fastify.log.info(`Server listening on ${address}`);
});

getSongs();
