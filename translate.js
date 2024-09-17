const axios = require('axios');
const Bottleneck = require('bottleneck');
const fs = require('fs').promises;
const path = require('path');
const colors = require('colors');
require('dotenv').config();

const baseDirPath = path.join(__dirname, '/src/locales');
const inputFile = path.join(baseDirPath, 'en.json');
const cacheFile = path.join(baseDirPath, 'translated.cache');
const languages = ['nl', 'de', 'fr', 'es'];
const languagesFull = ['Dutch', 'German', 'French', 'Spanish'];

// Initialize rate limiter with desired limits
const limiter = new Bottleneck({
  maxConcurrent: 1, // Number of concurrent requests
  minTime: 5000, // Minimum time (in milliseconds) between consecutive requests
});

const pause = (duration) => {
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
};

const translate = async (text, currentPath) => {
  await pause(5000);

  const prompt =
    'I want you to translate a text into ' +
    languagesFull.join(', ') +
    '. You should return a JSON object with the keys (' +
    languages.join(',') +
    ') which contain the translations for those languages. Try to keep the translation length the same as the original and not much longer. The output MUST be JSON valid and ONLY JSON. No other text. It is all in the context of a mobile app used for measuring pH. The text you should translate is:\n\n "' +
    text +
    '"';

  console.log();
  console.log(
    'Translating key '.blue.bold +
      currentPath.white.bold +
      ' with value: '.blue.bold +
      text.white.bold
  );

  const requestFunc = async () => {
    try {
      const res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4o',
          max_tokens: 4000,
          temperature: 0,
          messages: [{ role: 'user', content: prompt }],
        },
        {
          headers: {
            'Content-Type': 'application/json',
            Authorization: 'Bearer ' + process.env['OPENAI_API_KEY'],
          },
        }
      );

      const completion = res.data;
      let answer = completion.choices[0].message.content.trim();
      let returnValue = null;

      // Find the index of the first '{'
      const index = answer.indexOf('{');

      // Remove all characters before the first '{'
      answer = answer.slice(index);

      // Remove trailing ```
      answer = answer.replace(/```/g, '');

      try {
        returnValue = JSON.parse(answer);
        console.log(returnValue);
      } catch (e) {
        // Invalid JSON response
        console.error(
          'Invalid JSON response: '.red.bold + e.message.white.bold
        );
        return null;
      }

      return returnValue;
    } catch (error) {
      // Axios request error
      console.error('Axios request error:'.red.bold, error.message.white.bold);
      return null;
    }
  };

  // Rate limit the translation function
  const translatedTexts = await limiter.schedule(requestFunc);
  return translatedTexts;
};

const checkExistingFiles = async () => {
  const existingFiles = await Promise.all(
    languages.map(async (lang) => {
      const filePath = path.join(baseDirPath, `${lang}.json`);
      return {
        lang,
        exists: await fs
          .access(filePath)
          .then(() => true)
          .catch(() => false),
      };
    })
  );

  return existingFiles.filter((file) => file.exists);
};

const checkTranslationStatus = (translatedCache, key, languages) => {
  const keyCache = translatedCache[key];
  return languages.every(
    (lang) =>
      keyCache &&
      keyCache.some(
        (cachedLang) => cachedLang.toLowerCase() === lang.toLowerCase()
      )
  );
};

const translateJson = async (
  json,
  translatedCache,
  parentKey = '',
  languageFiles = {}
) => {
  const translated = {};

  for (let key in json) {
    let currentPath = parentKey ? `${parentKey}.${key}` : key;

    if (typeof json[key] === 'object') {
      let translatedNested = await translateJson(
        json[key],
        translatedCache,
        currentPath,
        languageFiles
      );
      for (let lang in translatedNested) {
        if (!translated[lang]) {
          translated[lang] = {};
        }
        translated[lang][key] = translatedNested[lang];
      }
    } else {
      let translationNeeded = languages.filter(
        (lang) =>
          !checkTranslationStatus(translatedCache, currentPath, [lang])
      );

      for (let lang of languages) {
        if (!translated[lang]) {
          translated[lang] = {};
        }
        if (!languageFiles[lang]) {
          languageFiles[lang] = {};
        }

        if (translationNeeded.includes(lang)) {
          let translatedTexts = await translate(json[key], currentPath);
          if (translatedTexts !== null && translatedTexts[lang]) {
            translated[lang][currentPath] = translatedTexts[lang];
            languageFiles[lang][currentPath] = translatedTexts[lang];
            if (!translatedCache[currentPath]) {
              translatedCache[currentPath] = [];
            }
            if (!translatedCache[currentPath].includes(lang)) {
              translatedCache[currentPath].push(lang);
            }
            await fs.writeFile(
              path.join(baseDirPath, `${lang}.json`),
              JSON.stringify(languageFiles[lang], null, 2),
              'utf8'
            );
          }
        } else {
          // Use existing translation from languageFiles
          translated[lang][currentPath] = languageFiles[lang][currentPath] || json[key];
        }
      }

      await fs.writeFile(
        cacheFile,
        JSON.stringify(translatedCache, null, 2),
        'utf8'
      );
    }
  }

  return translated;
};

const main = async () => {
  const existingFiles = await checkExistingFiles();

  let translatedCache = {};
  if (
    await fs
      .access(cacheFile)
      .then(() => true)
      .catch(() => false)
  ) {
    const cacheData = await fs.readFile(cacheFile, 'utf8');

    translatedCache = JSON.parse(cacheData);
  }

  const data = await fs.readFile(inputFile, 'utf8');
  const json = JSON.parse(data);

  const languageFiles = {};
  for (let lang of languages) {
    const languageFilePath = path.join(baseDirPath, `${lang}.json`);
    let languageData = {};

    if (existingFiles.some((file) => file.lang === lang)) {
      const existingData = await fs.readFile(languageFilePath, 'utf8');
      languageData = JSON.parse(existingData);
    }

    languageFiles[lang] = languageData;
  }

  const translatedJson = await translateJson(
    json,
    translatedCache,
    '',
    languageFiles
  );
};

main().catch(console.error);
