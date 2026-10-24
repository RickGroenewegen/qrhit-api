const Anthropic = require('@anthropic-ai/sdk');
const Bottleneck = require('bottleneck');
const crypto = require('crypto');
const fs = require('fs').promises;
const path = require('path');
const colors = require('colors');
require('dotenv').config();

const SITE_TARGETS = require('./src/data/shared/locales.json').locales.filter(
  (l) => l.site && l.code !== 'en'
);

// Translation bundles. The `main` bundle drives the app's own (informal)
// copy; `business` holds the formal B2B document copy used by quotations,
// technical instructions and MoneyBird invoice lines, which has to be written
// in polite register (German Sie, Dutch u) and must never inherit the
// informal tone of the main bundle.
const bundles = [
  {
    name: 'main',
    baseDir: path.join(__dirname, '/src/locales'),
    // Every language qrsong.io is served in, from src/data/shared/locales.json.
    languages: SITE_TARGETS.map((l) => l.code),
    languagesFull: SITE_TARGETS.map((l) => l.name),
    style: 'Be informal.',
  },
  {
    name: 'business',
    baseDir: path.join(__dirname, '/src/locales/business'),
    languages: ['nl', 'de'],
    languagesFull: ['Dutch', 'German'],
    style:
      'This is formal written business correspondence for a B2B quotation, ' +
      'invoice or technical specification sheet. Use the formal register ' +
      'throughout: German must use the Sie form and never du; Dutch must use ' +
      'the u form. Use each language\'s standard commercial vocabulary ' +
      '(Angebot, Rechnung, zzgl. MwSt., Gültig bis, Mit freundlichen Grüßen). ' +
      'Preserve any HTML tags and {{placeholders}} exactly as they appear. ' +
      // One word per thing across the price-list brochure, so a translation
      // never calls the same box a doos, a box and a doosje on one page.
      'Use this fixed vocabulary. Dutch: the product box is "doos" (plural ' +
      '"dozen"; "doosje" only for the small 48-card box); sample boxes are ' +
      '"proefdoosjes"; shipping cartons are "omdozen"; a playlist is ' +
      '"playlist", never "afspeellijst"; the digital proof is "digitale ' +
      'proef"; a release year is "jaartal"; resellers are "resellers"; ' +
      'setup costs are "opstartkosten"; templates are "sjablonen"; VAT is ' +
      '"btw". German: the product ' +
      'box is "Box" (plural "Boxen"); sample boxes are "Musterboxen"; ' +
      'shipping cartons are "Umkartons"; a playlist is "Playlist"; the ' +
      'digital proof is "digitaler Proof"; resellers are "Wiederverkäufer"; ' +
      'VAT is "MwSt.".',
  },
];

// Changed English is translated again. Each bundle's translated.hashes holds,
// per key, a fingerprint of the English its translations were made from; a key
// whose English no longer matches loses its cache entry and is translated into
// every language again. A key without a fingerprint (the first run, a new key)
// only gets one recorded, so starting this retranslates nothing. More than
// RETRANSLATE_LIMIT changed keys in a bundle (a rename across en.json, a
// reformatted file) are listed and left alone until the run is given
// --retranslate-changed.
const RETRANSLATE_LIMIT = 25;
const RETRANSLATE_CHANGED = process.argv.includes('--retranslate-changed');

// Reassigned per bundle by main().
let baseDirPath = bundles[0].baseDir;
let inputFile = path.join(baseDirPath, 'en.json');
let cacheFile = path.join(baseDirPath, 'translated.cache');
let hashesFile = path.join(baseDirPath, 'translated.hashes');
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

// Claude Opus 5.5 at effort high: customer mails and business documents, so
// quality comes before price. A request the model declines is retried on an
// older model inside the same call (`fallbacks`).
const anthropic = new Anthropic({ apiKey: process.env['ANTHROPIC_API_KEY'] });
const MODEL = 'claude-opus-5-5';

// The bundle's rules, the same for every request of a bundle, so they go in
// the (cached) system prompt; each batch's languages and texts go in the user
// message.
const systemPrompt = () =>
  'You translate the texts of QRSong!, an application that takes Spotify ' +
  'playlists and converts them into physical QR playing cards. ' +
  promptStyle +
  ' Try to keep each translation about as long as the original and not ' +
  'much longer. ' +
  // The same rule as the site's translate.js: in Dutch, Swedish, Norwegian
  // and Danish the model gave both products the gift card's word.
  "QRSong! has two different gift products, and one word must never stand for both. A 'gift card' is credit the recipient spends on cards of their own choosing at checkout. A 'gift voucher' is a printed voucher that hands over a set of cards the giver already bought; it is redeemed at qrsong.io/redeem. The gift card is: Dutch 'cadeaubon', German 'Geschenkkarte', French 'carte cadeau', Spanish 'tarjeta regalo', Italian 'carta regalo', Portuguese 'cartão presente', Polish 'karta podarunkowa', Hungarian 'ajándékkártya', Finnish 'lahjakortti', Czech 'dárková karta', Swedish 'presentkort', Norwegian and Danish 'gavekort', Japanese 'ギフトカード', Chinese '礼品卡'. The gift voucher is: Dutch 'cadeauvoucher', German 'Geschenkgutschein', French 'bon cadeau', Spanish 'vale regalo', Italian 'buono regalo', Portuguese 'vale-presente', Polish 'bon podarunkowy', Hungarian 'ajándékutalvány', Finnish 'lahjaseteli', Czech 'dárkový poukaz', Swedish 'presentbevis', Norwegian and Danish 'gavebevis', Japanese 'ギフト券', Chinese '礼品券'. When a text says only 'voucher' in the gift context, it is the gift voucher.";

// The answer, enforced by structured output: per text number, one string per
// language code asked for. The shape the rest of the script reads.
const answerSchema = (count, codes) => {
  const perText = {
    type: 'object',
    properties: Object.fromEntries(codes.map((code) => [code, { type: 'string' }])),
    required: codes,
    additionalProperties: false,
  };
  const numbers = Array.from({ length: count }, (_, i) => String(i));
  return {
    type: 'object',
    properties: Object.fromEntries(numbers.map((n) => [n, perText])),
    required: numbers,
    additionalProperties: false,
  };
};

const askClaude = async (prompt, schema) => {
  const message = await anthropic.beta.messages
    .stream({
      model: MODEL,
      max_tokens: 32000,
      system: [{ type: 'text', text: systemPrompt(), cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
      output_config: { effort: 'high', format: { type: 'json_schema', schema } },
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
    })
    .finalMessage();

  if (message.stop_reason !== 'end_turn') {
    throw new Error(`Claude stopped with "${message.stop_reason}"`);
  }
  const usage = message.usage || {};
  if ((usage.iterations || []).some((run) => run.type === 'fallback_message')) {
    console.log(`Answered by the fallback model ${message.model}`.yellow.bold);
  }
  console.log(
    `  tokens: ${usage.input_tokens} in, ${usage.cache_creation_input_tokens || 0} written to cache, ${usage.cache_read_input_tokens || 0} read from cache, ${usage.output_tokens} out`.gray
  );
  return JSON.parse(
    message.content
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('')
  );
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

const sourceHash = (text) =>
  crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);

// Compares en.json with the stored fingerprints (see RETRANSLATE_LIMIT).
// `next` is what to store: every current key's fingerprint, except that held
// keys (more changes than the limit, no --retranslate-changed) keep their old
// one, so the next run finds them again.
const compareSource = (json, hashes) => {
  const next = {};
  const changed = [];
  let recorded = 0;
  for (const [key, text] of Object.entries(flattenJson(json))) {
    const hash = sourceHash(text);
    if (!(key in hashes)) recorded++;
    else if (hashes[key] !== hash) changed.push(key);
    next[key] = hash;
  }
  const held = changed.length > RETRANSLATE_LIMIT && !RETRANSLATE_CHANGED;
  if (held) for (const key of changed) next[key] = hashes[key];
  return { next, changed, held, recorded };
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
    'Translate each text below into these languages (code: language): ' +
    untranslatedLanguages
      .map((code, i) => `${code}: ${untranslatedLanguagesFull[i]}`)
      .join(', ') +
    ".\n\nAnswer with one entry per text, under the text's number, holding its translation for each language code.\n\n" +
    'The texts, as a JSON object keyed by number:\n\n' +
    JSON.stringify(Object.fromEntries(texts.map((text, index) => [index, text])), null, 2);
  const schema = answerSchema(texts.length, untranslatedLanguages);

  console.log();
  console.log(
    'Translating keys '.blue.bold +
      currentPaths.join(', ').white.bold +
      ' for languages: '.blue.bold +
      untranslatedLanguages.join(', ').white.bold
  );

  const requestFunc = async () => {
    try {
      return await askClaude(prompt, schema);
    } catch (error) {
      // The SDK has already retried rate limits and server errors twice.
      console.error('Translation request failed:'.red.bold, error.message.white.bold);
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
  // The answer schema has one required string per text and language: 10 texts
  // in 13 languages was refused as "compiled grammar is too large" (400).
  const batchSize = 3;
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

  // Changed English loses its cache entry here, so translateJson treats it as
  // untranslated. The cache and the fingerprints are written together before
  // anything is translated: a run that dies halfway still knows what to redo.
  let hashes = {};
  try {
    hashes = JSON.parse(await fs.readFile(hashesFile, 'utf8'));
  } catch {
    // No fingerprints yet: every key is recorded, nothing is retranslated.
  }
  const source = compareSource(json, hashes);
  if (source.held) {
    console.log(
      `${source.changed.length} key(s) have new English, more than the ${RETRANSLATE_LIMIT} a run retranslates on its own. They are left as they are; check the list and run again with --retranslate-changed:`.red.bold
    );
    for (const key of source.changed) console.log(`    - ${key}`.gray);
  } else if (source.changed.length) {
    console.log(
      'English changed since the last translation, translating again: '.blue.bold +
        source.changed.join(', ').white.bold
    );
    for (const key of source.changed) delete translatedCache[key];
  }
  if (source.recorded) {
    console.log(`Recorded the English of ${source.recorded} key(s) for the first time.`.green);
  }
  await fs.writeFile(cacheFile, JSON.stringify(translatedCache, null, 2), 'utf8');
  await fs.writeFile(hashesFile, JSON.stringify(source.next, null, 2), 'utf8');

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
  const only = process.argv.slice(2).find((arg) => !arg.startsWith('--'));
  for (const bundle of bundles) {
    if (only && bundle.name !== only) continue;

    baseDirPath = bundle.baseDir;
    inputFile = path.join(baseDirPath, 'en.json');
    cacheFile = path.join(baseDirPath, 'translated.cache');
    hashesFile = path.join(baseDirPath, 'translated.hashes');
    languages = bundle.languages;
    languagesFull = bundle.languagesFull;
    promptStyle = bundle.style;

    console.log();
    console.log('Bundle: '.blue.bold + bundle.name.white.bold);
    await runBundle();
  }
};

main().catch(console.error);
