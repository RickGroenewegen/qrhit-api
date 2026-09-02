const axios = require('axios');
const Bottleneck = require('bottleneck');
const fs = require('fs').promises;
const path = require('path');
const colors = require('colors');
require('dotenv').config();

// Translation bundles. The `main` bundle drives the app's own (informal)
// copy; `business` holds the formal B2B document copy used by quotations,
// technical instructions and MoneyBird invoice lines, which has to be written
// in polite register (German Sie, Dutch u) and must never inherit the
// informal tone of the main bundle.
const bundles = [
  {
    name: 'main',
    baseDir: path.join(__dirname, '/src/locales'),
    languages: ['nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'jp', 'cn', 'sv', 'no'],
    languagesFull: [
      'Dutch',
      'German',
      'French',
      'Spanish',
      'Italian',
      'Portuguese',
      'Polish',
      'Japanese',
      'Chinese', // (Simplified)
      'Swedish',
      'Norwegian',
    ],
    style:
      '. Be informal. ',
  },
  {
    name: 'business',
    baseDir: path.join(__dirname, '/src/locales/business'),
    languages: ['nl', 'de'],
    languagesFull: ['Dutch', 'German'],
    style:
      '. This is formal written business correspondence for a B2B quotation, ' +
      'invoice or technical specification sheet. Use the formal register ' +
      'throughout: German must use the Sie form and never du; Dutch must use ' +
      'the u form. Use each language\'s standard commercial vocabulary ' +
      '(Angebot, Rechnung, zzgl. MwSt., Gültig bis, Mit freundlichen Grüßen). ' +
      'Preserve any HTML tags and {{placeholders}} exactly as they appear. ',
  },
];

// Reassigned per bundle by main().
let baseDirPath = bundles[0].baseDir;
let inputFile = path.join(baseDirPath, 'en.json');
let cacheFile = path.join(baseDirPath, 'translated.cache');
let languages = bundles[0].languages;
let languagesFull = bundles[0].languagesFull;
let promptStyle = bundles[0].style;

// Initialize rate limiter with desired limits
const limiter = new Bottleneck({
  maxConcurrent: 2,
  minTime: 2000,
});

const pause = (duration) => {
  return new Promise((resolve) => {
    setTimeout(resolve, duration);
  });
};

// Flattens nested JSON objects into dot notation
const flattenJson = (obj, parentKey = '', result = {}) => {
  for (let key in obj) {
    const newKey = parentKey ? `${parentKey}.${key}` : key;
    if (typeof obj[key] === 'object' && obj[key] !== null) {
      flattenJson(obj[key], newKey, result);
    } else {
      result[newKey] = obj[key];
    }
  }
  return result;
};

// Convert flat json back to nested (removed - we'll keep everything flat)
const translate = async (texts, currentPaths, translatedCache) => {
  await pause(5000);

  const untranslatedLanguages = languages.filter((lang) =>
    texts.some(
      (_, index) =>
        !checkTranslationStatus(translatedCache, currentPaths[index], [lang])
    )
  );
  const untranslatedLanguagesFull = untranslatedLanguages.map(
    (lang) => languagesFull[languages.indexOf(lang)]
  );

  if (untranslatedLanguages.length === 0) {
    console.log('All languages are already translated for these keys.'.green);
    return null;
  }

  const prompt =
    'I want you to translate the following texts into ' +
    untranslatedLanguagesFull.join(', ') +
    promptStyle +
    'You should return a JSON object where each key is the index of the text (starting from 0), and the value is another object with the keys (' +
    untranslatedLanguages.join(',') +
    ') which contain the translations for those languages. Try to keep the translation length the same as the original and not much longer. The output MUST be JSON valid and ONLY JSON. No other text. It is all in the context of a application that takes Spotify playlists and converts them into physical QR playing cards. The texts you should translate are:\n\n' +
    texts.map((text, index) => `${index}: "${text}"`).join('\n');

  console.log();
  console.log(
    'Translating keys '.blue.bold +
      currentPaths.join(', ').white.bold +
      ' for languages: '.blue.bold +
      untranslatedLanguages.join(', ').white.bold
  );

  const requestFunc = async () => {
    try {
      const res = await axios.post(
        'https://api.openai.com/v1/chat/completions',
        {
          model: 'gpt-4.1',
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

      const index = answer.indexOf('{');
      answer = answer.slice(index);
      answer = answer.replace(/```/g, '');

      try {
        returnValue = JSON.parse(answer);
      } catch (e) {
        console.error(
          'Invalid JSON response: '.red.bold + e.message.white.bold
        );
        return null;
      }

      return returnValue;
    } catch (error) {
      console.error('Axios request error:'.red.bold, error.message.white.bold);
      return null;
    }
  };

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
  const flatJson = flattenJson(json);
  const batchSize = 10;
  let batchTexts = [];
  let batchPaths = [];

  // Initialize flat language files
  for (let lang of languages) {
    if (!languageFiles[lang]) {
      languageFiles[lang] = {};
    }
    // Ensure existing translations are flat
    if (Object.keys(languageFiles[lang]).length > 0) {
      languageFiles[lang] = flattenJson(languageFiles[lang]);
    }
  }

  const processBatch = async () => {
    if (batchTexts.length > 0) {
      let translatedTexts = await translate(
        batchTexts,
        batchPaths,
        translatedCache
      );

      if (translatedTexts !== null) {
        for (let i = 0; i < batchTexts.length; i++) {
          let currentPath = batchPaths[i];

          for (let lang of languages) {
            if (translatedTexts[i] && translatedTexts[i][lang]) {
              // Store translations with flat keys
              languageFiles[lang][currentPath] = translatedTexts[i][lang];

              if (!translatedCache[currentPath]) {
                translatedCache[currentPath] = [];
              }
              if (!translatedCache[currentPath].includes(lang)) {
                translatedCache[currentPath].push(lang);
              }

              // Write flat structure to file
              await fs.writeFile(
                path.join(baseDirPath, `${lang}.json`),
                JSON.stringify(languageFiles[lang], null, 2),
                'utf8'
              );

              console.log(
                'Updated key path '.blue.bold +
                  currentPath.white.bold +
                  ' for '.blue.bold +
                  lang.white.bold
              );
            }
          }
        }
      }

      batchTexts = [];
      batchPaths = [];
    }
  };

  for (let key in flatJson) {
    let translationNeeded = languages.some(
      (lang) => !checkTranslationStatus(translatedCache, key, [lang])
    );

    if (translationNeeded) {
      batchTexts.push(flatJson[key]);
      batchPaths.push(key);

      if (batchTexts.length >= batchSize) {
        await processBatch();
      }
    } else {
      // Copy existing translations while maintaining flat structure
      for (let lang of languages) {
        if (languageFiles[lang][key]) {
          // Use existing translation
          continue;
        }
        // If no translation exists, copy from source
        languageFiles[lang][key] = flatJson[key];
      }
    }
  }

  // Process any remaining items in the batch
  await processBatch();

  await fs.writeFile(
    cacheFile,
    JSON.stringify(translatedCache, null, 2),
    'utf8'
  );

  return languageFiles;
};

const runBundle = async () => {
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

  await translateJson(json, translatedCache, '', languageFiles);
};

const main = async () => {
  // Optional bundle filter: `node translate.js business`
  const only = process.argv[2];
  for (const bundle of bundles) {
    if (only && bundle.name !== only) continue;

    baseDirPath = bundle.baseDir;
    inputFile = path.join(baseDirPath, 'en.json');
    cacheFile = path.join(baseDirPath, 'translated.cache');
    languages = bundle.languages;
    languagesFull = bundle.languagesFull;
    promptStyle = bundle.style;

    console.log();
    console.log('Bundle: '.blue.bold + bundle.name.white.bold);
    await runBundle();
  }
};

main().catch(console.error);
