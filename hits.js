require('dotenv').config();
const axios = require('axios');
const { OpenAI } = require('openai');

const openai = new OpenAI({
  apiKey: process.env['OPENAI_TOKEN'],
});

async function parseList(tracks) {
  return tracks.tracks;
}

async function getSongs() {
  const prompt = 'Hip hop';

  try {
    const result = await openai.chat.completions.create({
      model: 'gpt-4-1106-preview',
      temperature: 0,
      messages: [
        {
          role: 'system',
          content: `You are a helpfull assistant that creates Hitster card lists`,
        },
        {
          role: 'user',
          content:
            `Come up with 3 songs for Hitster. Make it diverse and span across as many years as possbile. The theme is:` +
            prompt,
        },
      ],
      function_call: 'auto',
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
          answer = await parseList(completionArguments);
          console.log(222, answer);
        }
      }
    }
  } catch (error) {
    console.error(
      'Error fetching songs:',
      error.response ? error.response.data : error.message
    );
  }
}

getSongs();
