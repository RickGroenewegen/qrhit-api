import crypto from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import { sanitizeCardDesign } from '../cardDesigns';
import { cardOf, composePhoto, FacePictures, loadScene } from '../productPhoto/compose';
import { renderShowcaseCards } from '../productPhoto/cards';
import { listedSongs, photoCards } from '../productPhoto/orderPhoto';
import { webPhoto } from '../productPhoto/outputs';
import { CARD_PX, productPhotoFor } from '../productPhoto/photos';
import { pickByRule } from '../productPhoto/songs';
import { isValidServiceType } from '../enums/ServiceType';

/**
 * The picture on a playlist card in ChatGPT (widget.ts): the photo of the
 * playlist's own cards that the product page opens on, instead of the cover.
 *
 * A ready-made playlist has that photo already (productPhoto/photos.ts). A
 * customer's own playlist has none: the site makes it in the visitor's
 * browser. Here it is made on the server the way the abandoned-payment mail
 * makes an order's (productPhoto/orderPhoto.ts): five of its songs by the
 * rule, drawn as printed in the standard design, put into scene-1. That costs
 * one Lambda render and a few seconds of CPU, so:
 *
 * - the picture's URL is signed: only a link get_playlist handed out is made;
 * - a playlist's picture is made once and kept on disk for KEEP_DAYS;
 * - one is made at a time, and no more than HOURLY_LIMIT an hour. Past that
 *   the URL answers 404 and the card keeps the playlist's cover.
 *
 * get_playlist starts the picture when it answers, so it is usually there by
 * the time the card asks for it.
 */

const PHOTO_WIDTH = 720;
const KEEP_DAYS = 30;
const HOURLY_LIMIT = 60;
const SIGNATURE = /^[0-9a-f]{24}$/;
const PLAYLIST_ID = /^[A-Za-z0-9._:-]{1,200}$/;

const photoDir = () => path.join(process.env['PUBLIC_DIR'] as string, 'mcp_photos');
const apiBase = () => (process.env['API_URI'] || 'https://api.qrsong.io').replace(/\/+$/, '');

/** The product photo of a ready-made playlist at the card's size, or null. */
export async function featuredPhotoUrl(slug: string): Promise<string | null> {
  const urls = await productPhotoFor(slug).catch(() => null);
  if (!urls) return null;
  // "…-720.webp 720w, …-1080.webp 1080w, …": the smallest is first
  const first = urls.webp.split(',')[0]?.trim().split(' ')[0];
  return first || null;
}

function sign(service: string, playlistId: string): string | null {
  const secret = process.env['JWT_SECRET'];
  if (!secret) return null;
  return crypto.createHmac('sha256', secret).update(`mcp-photo:${service}:${playlistId}`).digest('hex').slice(0, 24);
}

/** Where the picture of a customer's own playlist will be, or null when it cannot be made. */
export function ownPhotoUrl(service: string, playlistId: string): string | null {
  if (!isValidServiceType(service) || !PLAYLIST_ID.test(playlistId)) return null;
  const signature = sign(service, playlistId);
  if (!signature) return null;
  return `${apiBase()}/mcp/photo/${service}/${encodeURIComponent(playlistId)}/${signature}.webp`;
}

const fileFor = (service: string, playlistId: string) =>
  path.join(
    photoDir(),
    `${crypto.createHash('sha1').update(`${service}:${playlistId}`).digest('hex')}.webp`
  );

const making = new Map<string, Promise<string | null>>();
let line: Promise<unknown> = Promise.resolve();
let made: number[] = [];

function underLimit(): boolean {
  const hourAgo = Date.now() - 60 * 60 * 1000;
  made = made.filter((at) => at > hourAgo);
  return made.length < HOURLY_LIMIT;
}

async function make(service: string, playlistId: string, file: string): Promise<string | null> {
  const songs = pickByRule(await listedSongs({ playlistId, serviceType: service }, false));
  if (!songs.length) return null;
  const faces = await renderShowcaseCards(
    { design: sanitizeCardDesign({}), cards: photoCards(songs, 1) },
    CARD_PX
  );
  const scene = await loadScene();
  const pictures: FacePictures = {};
  for (const face of scene.manifest.faces) {
    if (face.side !== 'page') pictures[face.role] = faces[cardOf(face)][face.side];
  }
  const picture = await webPhoto(await composePhoto(pictures, scene), PHOTO_WIDTH);
  await fs.mkdir(photoDir(), { recursive: true });
  // written under another name first: a request never reads half a file
  const partial = `${file}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  await fs.writeFile(partial, picture);
  await fs.rename(partial, file);
  return file;
}

/**
 * The file of a customer's own playlist's picture, made now when it is not
 * there yet. Null when the signature is not ours, the playlist has no songs
 * a card can show, the hour's limit is reached or the cards could not be
 * drawn.
 */
export async function ownPhotoFile(
  service: string,
  playlistId: string,
  signature: string
): Promise<string | null> {
  if (!SIGNATURE.test(signature) || !isValidServiceType(service) || !PLAYLIST_ID.test(playlistId)) return null;
  const expected = sign(service, playlistId);
  if (!expected || !crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;

  const file = fileFor(service, playlistId);
  const stat = await fs.stat(file).catch(() => null);
  if (stat && Date.now() - stat.mtimeMs < KEEP_DAYS * 24 * 60 * 60 * 1000) return file;

  const key = `${service}:${playlistId}`;
  const running = making.get(key);
  if (running) return running;
  if (!underLimit()) return null;
  made.push(Date.now());

  const job = line
    .then(() => make(service, playlistId, file))
    .catch(() => null)
    .finally(() => making.delete(key));
  line = job;
  making.set(key, job);
  return job;
}

/** Starts the picture of a customer's own playlist; the answer does not wait for it. */
export function warmOwnPhoto(service: string, playlistId: string): void {
  const signature = sign(service, playlistId);
  if (!signature) return;
  void ownPhotoFile(service, playlistId, signature).catch(() => null);
}
