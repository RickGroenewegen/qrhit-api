/**
 * Product photo tools (src/productPhoto/).
 *
 *   npx tsx scripts/product-photo.ts textures --slug=<slug> --hero=<trackId>
 *       --backs=<trackId,...> --out=<dir> [--from=https://api.qrsong.io] [--px=2048]
 *
 * textures: the cards a photo shows as PNGs, drawn by the printer template
 * through the PDF Lambda (renderShowcaseCards), for building and lighting a
 * scene in Blender. The playlist, its songs and its design come from the
 * public API at --from (what the product page shows), so a playlist that is
 * only in production works from a development machine. Card 0 is the hero
 * (its QR code plays the song, through /qr_url2 with the Spotify link), then
 * the backs in the order given. Writes card-<n>-front.png, card-<n>-back.png
 * and spec.json to --out.
 *
 * In development the Lambda opens the card pages through API_URI (the ngrok
 * tunnel), so the local API has to run, and a design picture this machine
 * does not have is copied from --from into PUBLIC_DIR first.
 *
 *   npx tsx scripts/product-photo.ts tiers --in=<master.png> --name=<slug> --out=<dir>
 *
 * tiers: the files a photo is published as (photoOutputs), from a 16:10
 * transparent master render, e.g. into the site's
 * src/assets/images/optimized/product-photo/ for the pilot.
 *
 *   npx tsx scripts/product-photo.ts compose --textures=<dir> --out=<photo.png> [--tiers=<dir>]
 *
 * compose: the product photo of a textures folder without Blender
 * (composePhoto over assets/product-photo/scene-1), the way the server makes
 * one; with --tiers also its published files.
 *
 *   npx tsx scripts/product-photo.ts generate --slug=<slug> [--force] [--repick]
 *
 * generate: what the queue's worker does for one featured playlist of this
 * machine's database (generateProductPhoto): songs, cards, photo, files, row.
 *
 *   npx tsx scripts/product-photo.ts web-passes [--site=../qrhit]
 *
 * web-passes: the light copies of every scene in assets/product-photo
 * (webPasses.ts), the photo and the format tiles, for the site's browser
 * compositor, into the site's src/assets/product-photo/<scene>-<fingerprint>/
 * (older copies removed) and src/app/shared/card-photo/scenes.generated.ts.
 * Run it after exporting a scene, then build the site.
 *
 *   npx tsx scripts/product-photo.ts tiles --textures=<dir> [--site=../qrhit] [--masters=<dir>]
 *
 * tiles: the site's standard format tiles (tiles.ts), from the standard
 * design's textures (qrhit/studio/product-photo/textures/all-taylor-swift-songs),
 * into src/assets/images/format-tiles/standard-<fingerprint>/
 * <kind>-<160|320|640>.<avif|webp|png> (older folders removed: /assets is cached
 * for a year, so a new tile needs a new URL) and
 * src/app/shared/format-tile/standard-tiles.generated.ts. --masters also
 * keeps the full-size PNGs.
 *
 *   npx tsx scripts/product-photo.ts page-textures --textures=<dir> --out=<dir>
 *
 * page-textures: the page pictures (pages.ts) of a textures folder at their
 * layout's size, page-<layout>.png, as the tile scenes' .blend files use them
 * (qrhit/studio/product-photo/textures/tiles/).
 */
import 'dotenv/config';
import path from 'path';
import { promises as fs } from 'fs';
import { color, white } from 'console-log-colors';
import { designImages, showcaseDesign } from '../src/productPhoto/design';
import { renderShowcaseCards, ShowcaseCard } from '../src/productPhoto/cards';
import { photoOutputs } from '../src/productPhoto/outputs';
import { composePhoto, FacePictures, FaceRole, loadScene, SCENE_DIR } from '../src/productPhoto/compose';
import { silhouetteMask, webPasses, WebPassesManifest } from '../src/productPhoto/webPasses';
import { CardPicture, composeTile, loadTileScenes, TILE_KINDS, TILE_WIDTHS, tileOutputs } from '../src/productPhoto/tiles';
import { PAGE_LAYOUTS, pagePicture } from '../src/productPhoto/pages';
import { createHash } from 'crypto';
import { readQrCodes } from '../src/qrRead';
import { generateProductPhoto, productPhotoFor } from '../src/productPhoto/photos';
import PrismaInstance from '../src/prisma';
import sharp from 'sharp';

// which picture of a textures folder each face of scene-1 shows (the cards
// the .blend was built with)
const TEXTURE_FACES: Record<FaceRole, string> = {
  hero: 'card-0-front.png',
  answer: 'card-0-back.png',
  songs: 'card-1-back.png',
  song: 'card-3-back.png',
  fan: 'card-4-front.png',
  deck: 'card-6-front.png',
};

function arg(name: string): string | undefined {
  const prefix = `--${name}=`;
  return process.argv.find((a) => a.startsWith(prefix))?.slice(prefix.length);
}

async function post(from: string, route: string, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${from}${route}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json: any = await response.json();
  if (!json.success) throw new Error(`${route}: ${json.error || response.status}`);
  return json.data;
}

/** Copies the design's pictures this machine lacks from the API at `from`. */
async function fetchMissingImages(from: string, files: string[]): Promise<void> {
  const publicDir = process.env['PUBLIC_DIR'] as string;
  for (const file of files) {
    const target = path.join(publicDir, file);
    if (await fs.access(target).then(() => true, () => false)) continue;
    const response = await fetch(`${from}/public/${file}`);
    if (!response.ok) throw new Error(`${from}/public/${file}: ${response.status}`);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, Buffer.from(await response.arrayBuffer()));
    console.log(color.blue.bold(`Copied ${white.bold(file)} from ${white.bold(from)}`));
  }
}

async function textures(): Promise<void> {
  const slug = arg('slug');
  const hero = arg('hero');
  const backs = (arg('backs') || '').split(',').filter(Boolean);
  const out = arg('out');
  const from = (arg('from') || 'https://api.qrsong.io').replace(/\/$/, '');
  const px = Number(arg('px') || 2048);
  if (!slug || !hero || !backs.length || !out) {
    console.log(
      'usage: npx tsx scripts/product-photo.ts textures --slug=<slug> --hero=<trackId> --backs=<id,...> --out=<dir> [--from=<api>] [--px=2048]'
    );
    process.exitCode = 1;
    return;
  }

  const playlist = await post(from, '/spotify/playlists', { playlistId: slug, cache: 1, featured: 1, slug: 1, locale: 'en' });
  const listed = await post(from, '/spotify/playlists/tracks', {
    playlistId: playlist.playlistId,
    slug,
    cache: 1,
    featured: 1,
    locale: 'en',
  });
  const byId = new Map<string, any>(listed.tracks.map((track: any) => [track.id, track]));
  // the public answer only carries a design the product page may show
  const { design, source } = showcaseDesign({ design: playlist.design });

  const cards: ShowcaseCard[] = [hero, ...backs].map((id) => {
    const track = byId.get(id);
    if (!track) throw new Error(`track ${id} is not in ${slug}`);
    const year = Number(track.trueYear || String(track.releaseDate || '').slice(0, 4));
    if (!year) throw new Error(`track ${id} (${track.artist}, ${track.name}) has no year`);
    return {
      trackId: id,
      artist: track.artist,
      name: track.name,
      year,
      qrUrl: `${from}/qr_url2?link=${encodeURIComponent(track.spotifyLink || track.link)}`,
    };
  });

  if (process.env['ENVIRONMENT'] === 'development') await fetchMissingImages(from, designImages(design));

  console.log(
    color.blue.bold(
      `Rendering ${white.bold(cards.length)} cards of ${white.bold(playlist.name)} (${white.bold(source)} design) at ${white.bold(px)} px`
    )
  );
  const faces = await renderShowcaseCards({ design, cards }, px);
  await fs.mkdir(out, { recursive: true });
  for (const [index, face] of faces.entries()) {
    await fs.writeFile(path.join(out, `card-${index}-front.png`), face.front);
    await fs.writeFile(path.join(out, `card-${index}-back.png`), face.back);
  }
  await fs.writeFile(
    path.join(out, 'spec.json'),
    JSON.stringify({ slug, name: playlist.name, source, px, design, cards }, null, 2)
  );
  for (const [index, card] of cards.entries()) {
    console.log(`  ${white.bold(index)}  ${card.year}  ${card.artist} - ${card.name}`);
  }
  console.log(color.green.bold(`Wrote ${white.bold(faces.length * 2)} pictures to ${white.bold(out)}`));
}

async function tiers(): Promise<void> {
  const input = arg('in');
  const name = arg('name');
  const out = arg('out');
  if (!input || !name || !out || !/^[a-z0-9-]+$/.test(name)) {
    console.log('usage: npx tsx scripts/product-photo.ts tiers --in=<master.png> --name=<slug> --out=<dir>');
    process.exitCode = 1;
    return;
  }
  const files = await photoOutputs(await fs.readFile(input), name);
  await fs.mkdir(out, { recursive: true });
  for (const { file, data } of files) {
    await fs.writeFile(path.join(out, file), data);
    console.log(`  ${white.bold(file)}  ${Math.round(data.length / 1024)} KB`);
  }
  console.log(color.green.bold(`Wrote ${white.bold(files.length)} files to ${white.bold(out)}`));
}

async function compose(): Promise<void> {
  const dir = arg('textures');
  const out = arg('out');
  if (!dir || !out) {
    console.log('usage: npx tsx scripts/product-photo.ts compose --textures=<dir> --out=<photo.png> [--tiers=<dir>]');
    process.exitCode = 1;
    return;
  }
  const pictures = {} as FacePictures;
  for (const [role, file] of Object.entries(TEXTURE_FACES) as [FaceRole, string][]) {
    pictures[role] = await fs.readFile(path.join(dir, file));
  }
  const started = Date.now();
  const photo = await composePhoto(pictures);
  console.log(color.blue.bold(`Composed in ${white.bold(Date.now() - started)} ms`));
  await fs.writeFile(out, photo);
  // the smallest tier, as a phone shows it
  const small = await sharp(photo).resize({ width: 720 }).flatten({ background: '#feefe5' }).png().toBuffer();
  const codes = await readQrCodes(small);
  if (codes.length) console.log(color.green.bold(`QR at 720 px: ${white.bold(codes.join(', '))}`));
  else console.log(color.yellow.bold('No QR code read at 720 px'));
  const tiersDir = arg('tiers');
  if (tiersDir) {
    const files = await photoOutputs(photo, path.basename(dir));
    await fs.mkdir(tiersDir, { recursive: true });
    for (const { file, data } of files) await fs.writeFile(path.join(tiersDir, file), data);
  }
  console.log(color.green.bold(`Wrote ${white.bold(out)}`));
}

async function generate(): Promise<void> {
  const slug = arg('slug');
  if (!slug) {
    console.log('usage: npx tsx scripts/product-photo.ts generate --slug=<slug> [--force] [--repick]');
    process.exitCode = 1;
    return;
  }
  const playlist = await PrismaInstance.getInstance().playlist.findFirst({ where: { slug }, select: { id: true } });
  if (!playlist) throw new Error(`no playlist ${slug} in this database`);
  const result = await generateProductPhoto(playlist.id, {
    force: process.argv.includes('--force'),
    repick: process.argv.includes('--repick'),
  });
  console.log(color.green.bold(`${white.bold(result.status)}${result.key ? ` (key ${white.bold(result.key)})` : ''}${result.reason ? `: ${result.reason}` : ''}`));
  const urls = await productPhotoFor(slug);
  if (urls) console.log(`  ${white.bold(urls.fallback)}`);
}

/** A textures folder's card pictures (card-<n>-front.png, card-<n>-back.png), numbers wrapping round. */
async function texturePictures(dir: string): Promise<CardPicture> {
  const cards: Array<{ front: Buffer; back: Buffer }> = [];
  for (let n = 0; ; n++) {
    const front = await fs.readFile(path.join(dir, `card-${n}-front.png`)).catch(() => null);
    const back = await fs.readFile(path.join(dir, `card-${n}-back.png`)).catch(() => null);
    if (!front || !back) break;
    cards.push({ front, back });
  }
  if (!cards.length) throw new Error(`no card-0-front.png and card-0-back.png in ${dir}`);
  return (card, side) => cards[card % cards.length][side];
}

async function tiles(): Promise<void> {
  const dir = arg('textures');
  if (!dir) {
    console.log('usage: npx tsx scripts/product-photo.ts tiles --textures=<dir> [--site=../qrhit] [--masters=<dir>]');
    process.exitCode = 1;
    return;
  }
  const site = path.resolve(arg('site') ?? path.join(__dirname, '../../qrhit'));
  const assets = path.join(site, 'src/assets/images/format-tiles');
  const generated = path.join(site, 'src/app/shared/format-tile/standard-tiles.generated.ts');
  const masters = arg('masters');
  const picture = await texturePictures(dir);
  const scenes = await loadTileScenes();

  const files: Array<{ file: string; data: Buffer }> = [];
  for (const kind of TILE_KINDS) {
    const scene = scenes[kind];
    if (!scene) throw new Error(`no tile scene for ${kind} in assets/product-photo`);
    const started = Date.now();
    const master = await composeTile(scene, picture);
    if (masters) {
      await fs.mkdir(masters, { recursive: true });
      await fs.writeFile(path.join(masters, `tile-${kind}.png`), master);
    }
    const outputs = await tileOutputs(master, kind);
    for (const { file, data } of outputs) files.push({ file: file.replace(/^tile-([a-z]+)-(\d+)\./, '$1-$2.'), data });
    const sizes = outputs.map(({ file, data }) => `${file.split('-').pop()} ${Math.round(data.length / 1024)} KB`).join(', ');
    console.log(color.blue.bold(`${white.bold(kind)} in ${white.bold(Date.now() - started)} ms: ${sizes}`));
  }

  const hash = createHash('sha256');
  for (const { file, data } of files) hash.update(file).update(data);
  const folder = `standard-${hash.digest('hex').slice(0, 10)}`;
  await fs.mkdir(path.join(assets, folder), { recursive: true });
  for (const { file, data } of files) await fs.writeFile(path.join(assets, folder, file), data);
  for (const old of (await fs.readdir(assets)).filter((name) => name.startsWith('standard-') && name !== folder)) {
    await fs.rm(path.join(assets, old), { recursive: true, force: true });
  }

  const url = (kind: string, width: number, ext: string) => `assets/images/format-tiles/${folder}/${kind}-${width}.${ext}`;
  const srcset = (kind: string, ext: string) => TILE_WIDTHS.map((width) => `${url(kind, width, ext)} ${width}w`).join(', ');
  const entries = TILE_KINDS.map((kind) =>
    [
      `  ${kind}: {`,
      `    avif: '${srcset(kind, 'avif')}',`,
      `    webp: '${srcset(kind, 'webp')}',`,
      `    png: '${srcset(kind, 'png')}',`,
      `    src: '${url(kind, TILE_WIDTHS[0], 'png')}',`,
      '  },',
    ].join('\n')
  );
  await fs.mkdir(path.dirname(generated), { recursive: true });
  await fs.writeFile(
    generated,
    [
      '// Generated by qrhit-api scripts/product-photo.ts tiles from the tile scenes in',
      '// qrhit-api/assets/product-photo and the standard design. Do not edit; run the script again.',
      "import type { FormatTileImages } from './format-tile.model';",
      '',
      'export const STANDARD_TILES: FormatTileImages = {',
      ...entries,
      '};',
      '',
    ].join('\n')
  );
  console.log(color.green.bold(`Wrote the standard format tiles to ${white.bold(path.join(assets, folder))} and ${white.bold(generated)}`));
}

async function pageTextures(): Promise<void> {
  const dir = arg('textures');
  const out = arg('out');
  if (!dir || !out) {
    console.log('usage: npx tsx scripts/product-photo.ts page-textures --textures=<dir> --out=<dir>');
    process.exitCode = 1;
    return;
  }
  const picture = await texturePictures(dir);
  await fs.mkdir(out, { recursive: true });
  for (const [name, layout] of Object.entries(PAGE_LAYOUTS)) {
    await fs.writeFile(path.join(out, `page-${name}.png`), await pagePicture(layout, picture, 1));
    console.log(`  ${white.bold(`page-${name}.png`)}  ${layout.width} x ${layout.height}`);
  }
  console.log(color.green.bold(`Wrote ${white.bold(Object.keys(PAGE_LAYOUTS).length)} page pictures to ${white.bold(out)}`));
}

// the widths the browser composes at, per scene (the photo: a phone, everything
// else; a tile: the option button, the info modal on a retina screen)
const WEB_WIDTHS: Record<string, number[]> = {
  'scene-1': [720, 1080],
  'tile-digital': [320, 640],
  'tile-sheets': [320, 640],
  'tile-cards': [320, 640],
};

async function writeWebPasses(): Promise<void> {
  const site = path.resolve(arg('site') ?? path.join(__dirname, '../../qrhit'));
  const assets = path.join(site, 'src/assets/product-photo');
  const generated = path.join(site, 'src/app/shared/card-photo/scenes.generated.ts');
  const masksFile = path.join(site, 'src/app/shared/card-photo/scene-masks.generated.ts');
  const scenesDir = path.dirname(SCENE_DIR);
  await fs.mkdir(assets, { recursive: true });
  await fs.mkdir(path.dirname(generated), { recursive: true });
  const existing = await fs.readdir(assets);
  const entries: string[] = [];
  const masks: string[] = [];

  for (const scene of Object.keys(WEB_WIDTHS)) {
    const loaded = await loadScene(path.join(scenesDir, scene));
    const files: Array<{ file: string; data: Buffer }> = [];
    const manifests: Record<number, WebPassesManifest> = {};
    for (const width of WEB_WIDTHS[scene]) {
      const passes = await webPasses(loaded, width);
      manifests[width] = passes.manifest;
      files.push({ file: `base-${width}.webp`, data: passes.base }, { file: `faces-${width}.bin`, data: passes.faces });
      console.log(
        color.blue.bold(
          `${white.bold(scene)} at ${white.bold(width)}: base ${white.bold(Math.round(passes.base.length / 1024))} KB, faces ${white.bold(Math.round(passes.faces.length / 1024))} KB`
        )
      );
    }
    // the skeleton's shape: a file, so only a visitor who gets a skeleton downloads it
    const largest = files.filter(({ file }) => file.startsWith('base-')).pop()!;
    files.push({ file: 'mask.png', data: await silhouetteMask(largest.data, scene.startsWith('tile-') ? 200 : 400) });
    const hash = createHash('sha256');
    for (const { file, data } of files) hash.update(file).update(data);
    hash.update(JSON.stringify(manifests));
    const folder = `${scene}-${hash.digest('hex').slice(0, 10)}`;
    masks.push(`  '${scene}': '/assets/product-photo/${folder}/mask.png',`);
    await fs.mkdir(path.join(assets, folder), { recursive: true });
    for (const { file, data } of files) await fs.writeFile(path.join(assets, folder, file), data);
    for (const old of existing.filter((name) => name.startsWith(`${scene}-`) && name !== folder)) {
      await fs.rm(path.join(assets, old), { recursive: true, force: true });
    }
    entries.push(`  '${scene}': {\n    path: 'assets/product-photo/${folder}',\n    widths: ${JSON.stringify(manifests)},\n  },`);
  }

  await fs.writeFile(
    generated,
    [
      '// Generated by qrhit-api scripts/product-photo.ts web-passes from the scenes in',
      '// qrhit-api/assets/product-photo. Do not edit; run the script again.',
      "import type { SceneSet } from './card-photo.model';",
      '',
      'export const SCENES: Record<string, SceneSet> = {',
      ...entries,
      '};',
      '',
    ].join('\n')
  );
  await fs.writeFile(
    masksFile,
    [
      '// Generated by qrhit-api scripts/product-photo.ts web-passes: the URL of each scene\'s',
      '// silhouette (silhouetteMask), the shape of the loading skeletons. Do not edit; run the script again.',
      'export const SCENE_MASKS: Record<string, string> = {',
      ...masks,
      '};',
      '',
    ].join('\n')
  );
  console.log(color.green.bold(`Wrote ${white.bold(entries.length)} scene(s) to ${white.bold(assets)}, ${white.bold(generated)} and ${white.bold(masksFile)}`));
}

async function main(): Promise<void> {
  const command = process.argv[2];
  if (command === 'textures') return textures();
  if (command === 'tiers') return tiers();
  if (command === 'compose') return compose();
  if (command === 'generate') return generate();
  if (command === 'web-passes') return writeWebPasses();
  if (command === 'tiles') return tiles();
  if (command === 'page-textures') return pageTextures();
  console.log('usage: npx tsx scripts/product-photo.ts textures|tiers|compose|generate|web-passes|tiles|page-textures ...');
  process.exitCode = 1;
}

main()
  .catch((error) => {
    console.error(color.red.bold(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  })
  // Redis and the singletons keep the process alive
  .finally(() => process.exit());
