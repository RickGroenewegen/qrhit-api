import path from 'path';
import crypto from 'crypto';
import { promises as fs } from 'fs';
import { color, white } from 'console-log-colors';
import Logger from './logger';
import Cache from './cache';
import Utils from './utils';
import HitsterDetector, { HitsterClass } from './hitsterDetector';
import { hitsterThreshold } from './hitsterThresholds';

/**
 * Hitster screen of one image in the card or box designer, while the
 * customer is still designing: POST /designer/screen.
 *
 * The designer sends a small copy of a picture the customer just picked (or
 * the name of an upload already stored) and gets back whether it shows
 * Hitster material, so it can say so at once instead of after payment. The
 * judge is our own model (hitsterDetector.ts), not a paid API: a picture
 * costs about 70 ms of one core. The verdict is kept per picture content and
 * model, so the same picture is judged once, whoever picks it.
 *
 * Every way this can go wrong ends in "unchecked", which the designer treats
 * as no opinion: the model not loading, an unreadable picture, the per-address
 * cap (the endpoint is public, and each picture costs CPU).
 *
 * DESIGN_SCREEN_MODE travels with every answer, so it can change without a
 * frontend deploy:
 *   off    nothing is screened
 *   warn   a flagged image gets a message (the default)
 *   block  reserved: a flagged image has to be replaced before continuing
 * HITSTER_THRESHOLD (default 0.5, src/hitsterThresholds.ts) is the score at
 * which a picture is flagged here; finalCheck holds an order from its own,
 * higher HITSTER_HOLD_THRESHOLD.
 */

export type DesignScreenMode = 'off' | 'warn' | 'block';
export type DesignScreenStatus = 'clean' | 'flagged' | 'unchecked';

export interface DesignScreenAnswer {
  status: DesignScreenStatus;
  mode: DesignScreenMode;
  /** What was found and where, in pixels of the picture sent; only when flagged. */
  marks?: { class: HitsterClass; box: { x: number; y: number; width: number; height: number } }[];
}

/** What to screen: a small picture of a file the visitor just picked, or a stored upload. */
export interface DesignScreenInput {
  image?: unknown;
  filename?: unknown;
  type?: unknown;
}

// A 512 pixel JPEG is some tens of kilobytes; a megabyte of base64 is a
// picture nobody made with the designer.
const MAX_DATA_URI_LENGTH = 1_000_000;
const VERDICT_TTL_SECONDS = 30 * 24 * 3600;
const DAILY_LIMIT_PER_IP = 400;
const DATA_URI = /^data:image\/(?:png|jpe?g|webp);base64,([A-Za-z0-9+/=]+)$/;
// The names Designer gives its uploads (src/designer.ts): random letters and
// digits plus the extension, nothing that could leave the upload folder.
const UPLOAD_FILENAME = /^[a-z0-9]{8,64}\.(?:png|jpe?g|webp)$/i;

export function designScreenMode(): DesignScreenMode {
  const mode = (process.env['DESIGN_SCREEN_MODE'] || 'warn').toLowerCase();
  return mode === 'off' || mode === 'block' ? mode : 'warn';
}

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

class DesignScreen {
  private static instance: DesignScreen;
  private logger = new Logger();
  private cache = Cache.getInstance();
  private utils = new Utils();
  private detector = HitsterDetector.getInstance();
  private modelStamp: Promise<string> | null = null;

  public static getInstance(): DesignScreen {
    if (!DesignScreen.instance) DesignScreen.instance = new DesignScreen();
    return DesignScreen.instance;
  }

  /** Size and time of the model file: a new model never answers from old verdicts. */
  private stamp(): Promise<string> {
    if (!this.modelStamp) {
      this.modelStamp = fs
        .stat(this.detector.modelPath())
        .then((file) => `${file.size}-${Math.round(file.mtimeMs)}`);
      this.modelStamp.catch(() => {
        this.modelStamp = null;
      });
    }
    return this.modelStamp;
  }

  /** The bytes to screen, or null when the request names nothing usable. */
  private async readInput(input: DesignScreenInput): Promise<Buffer | null> {
    if (typeof input.image === 'string') {
      if (input.image.length > MAX_DATA_URI_LENGTH) return null;
      const match = DATA_URI.exec(input.image);
      return match ? Buffer.from(match[1], 'base64') : null;
    }
    if (
      typeof input.filename !== 'string' ||
      !UPLOAD_FILENAME.test(input.filename) ||
      (input.type !== 'background' && input.type !== 'logo')
    ) {
      return null;
    }
    try {
      return await fs.readFile(
        path.join(process.env['PUBLIC_DIR'] as string, input.type, input.filename)
      );
    } catch {
      return null;
    }
  }

  /** True while this address is under its daily cap. */
  private async underCap(ip: string): Promise<boolean> {
    if (process.env['ENVIRONMENT'] === 'development' || this.utils.isTrustedIp(ip)) {
      return true;
    }
    const key = `designscreen:ip:${ip}:${today()}`;
    const used = parseInt((await this.cache.get(key)) || '0', 10) + 1;
    await this.cache.set(key, String(used), 24 * 3600);
    return used <= DAILY_LIMIT_PER_IP;
  }

  public async screen(input: DesignScreenInput, ip: string): Promise<DesignScreenAnswer> {
    const mode = designScreenMode();
    const unchecked: DesignScreenAnswer = { status: 'unchecked', mode };
    if (mode === 'off') return unchecked;

    try {
      const picture = await this.readInput(input);
      if (!picture) return unchecked;

      const hash = crypto.createHash('sha256').update(picture).digest('hex');
      const key = `designscreen:hitster:${await this.stamp()}:${hash}`;
      const known = await this.cache.get(key);
      if (known) {
        return { ...JSON.parse(known), mode };
      }
      if (!(await this.underCap(ip))) return unchecked;

      const started = Date.now();
      const verdict = await this.detector.detect(picture, hitsterThreshold());
      const answer: Omit<DesignScreenAnswer, 'mode'> = verdict.marks.length
        ? {
            status: 'flagged',
            marks: verdict.marks.map((m) => ({ class: m.class, box: m.box })),
          }
        : { status: 'clean' };
      await this.cache.set(key, JSON.stringify(answer), VERDICT_TTL_SECONDS);

      const found = verdict.marks
        .map((m) => `${m.class} ${m.score.toFixed(2)}`)
        .join(', ');
      const line = `[${white.bold('designScreen')}] ${white.bold(hash.slice(0, 12))} → ${white.bold(
        answer.status
      )}${found ? ` (${white.bold(found)})` : ''} in ${white.bold(`${Date.now() - started} ms`)}`;
      this.logger.log(
        answer.status === 'flagged' ? color.yellow.bold(line) : color.blue.bold(line)
      );
      return { ...answer, mode };
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `[${white.bold('designScreen')}] screen failed: ${white.bold(
            (error as Error).message
          )}`
        )
      );
      return unchecked;
    }
  }
}

export default DesignScreen;
