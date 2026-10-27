import { color, white } from 'console-log-colors';
import Logger from '../logger';

/**
 * What the rest of the API calls when something a product photo shows
 * changed: a playlist featured or unfeatured, its design shared, hidden or
 * replaced, its songs replaced. Fire and forget: the admin action or the
 * customer's save that caused it never waits for the queue or fails on it.
 * The queue is loaded on first use, so the data layer does not pull in
 * BullMQ (or a Redis connection) just by importing this.
 */

const logger = new Logger();

function report(what: string, playlistId: number, error: any) {
  logger.log(
    color.red.bold(`Product photo ${what} for playlist ${white.bold(playlistId)} failed: ${error?.message || error}`)
  );
}

/** (Re)makes the photo of a featured playlist; does nothing when nothing it shows changed. */
export function queueProductPhoto(playlistId: number, options: { force?: boolean; repick?: boolean } = {}): void {
  import('../productPhotoQueue')
    .then(({ default: queue }) => queue.getInstance().add(playlistId, options))
    .catch((error) => report('queue', playlistId, error));
}

/** Featured or not, in one call: featured queues the photo, unfeatured drops it. */
export function productPhotoFeatured(playlistId: number, featured: boolean): void {
  if (featured) {
    queueProductPhoto(playlistId);
    return;
  }
  import('./photos')
    .then(({ dropProductPhoto }) => dropProductPhoto(playlistId))
    .catch((error) => report('removal', playlistId, error));
}
