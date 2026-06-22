import { CronJob } from 'cron';
import cluster from 'cluster';
import Holidays from 'date-holidays';
import Logger from './logger';
import { color } from 'console-log-colors';
import PrismaInstance from './prisma';
import Utils from './utils';
import { ChatGPT } from './chatgpt';
import PushoverClient from './pushover';
import Translation from './translation';
import Cache from './cache';
import Shipping from './shipping';
import ShippingConfig from './shippingconfig';
import {
  TARGET_COUNTRIES,
  OCCASION_MATCHERS,
  SUPPLEMENT_RULES,
  BASE_EVENT_SEEDS,
  LOCALE_PRIMARY_COUNTRY,
  slugify,
  occasionSlug,
} from './data/giftOccasions';
import { projectPlaylistsByIds } from './data/featuredPlaylists';

export interface PrefillSummary {
  countries: number;
  years: number[];
  created: number;
  updated: number;
}

export interface CalendarSearchFilters {
  searchTerm?: string;
  country?: string;
  upcomingOnly?: boolean;
  page?: number;
  limit?: number;
}

export interface CalendarEventInput {
  name: string;
  country: string;
  date: string | Date;
  baseEventId?: number | null;
  relevant?: boolean;
  hidden?: boolean;
  notes?: string | null;
}

export interface BaseEventInput {
  name: string;
  key?: string;
  description?: string | null;
  body?: string | null;
  windowDaysBefore?: number;
  notes?: string | null;
}

interface CollectedEvent {
  eventKey: string;
  name: string;
  country: string;
  date: Date;
  year: number;
  type: string;
}

class CalendarService {
  private static instance: CalendarService;
  private static backfillRunning = false;
  private logger = new Logger();
  private prisma = PrismaInstance.getInstance();
  private utils = new Utils();
  private chatgpt = new ChatGPT();
  private pushover = new PushoverClient();
  private translation = new Translation();
  private cache = Cache.getInstance();
  private shipping = Shipping.getInstance();
  private shippingConfig = ShippingConfig.getInstance();

  /**
   * Total order→delivery lead time (days) for a country: production days +
   * worst-case shipping (historical max + admin offset, with a fallback for
   * markets we have no delivery data for). Used to compute the order-by cutoff
   * so the seasonal strip never promises a delivery it can't make.
   */
  private async getCountryLeadTimeDays(country: string): Promise<number> {
    try {
      const info = await this.shipping.getShippingInfoByCountry();
      const prod = info?.productionDays ?? 3;
      const c = info?.countries?.find((x: any) => x.countryCode === country);
      const cfg = await this.shippingConfig.getConfigForCountry(country);
      const baseShip = c && c.maxDays > 0 ? c.maxDays : 7; // fallback for unknown markets
      const ship = baseShip + (cfg?.maxDaysOffset || 0);
      return prod + Math.max(ship, 1);
    } catch {
      return 10; // conservative production + shipping fallback
    }
  }

  /** Invalidate the public occasion + seasonal caches after an admin change. */
  private async bustOccasionCaches(): Promise<void> {
    try {
      await Promise.all([
        this.cache.delPattern('occasion_v1_*'),
        this.cache.delPattern('occasions_list_v1_*'),
        this.cache.delPattern('seasonal_v1_*'),
      ]);
    } catch {
      // Non-fatal: caches expire on their own TTL.
    }
  }

  private constructor() {
    // Nothing to load on startup.
  }

  public static getInstance(): CalendarService {
    if (!CalendarService.instance) {
      CalendarService.instance = new CalendarService();
      CalendarService.instance.startPrefillCron();
    }
    return CalendarService.instance;
  }

  /**
   * Schedule the monthly prefill. Production main server only — never in
   * development. `isMainServer()` already returns false off-AWS, so dev never
   * runs the cron; the prefill is exposed as an on-demand admin bulk-action
   * instead (see /admin/calendar/prefill).
   */
  public startPrefillCron(): void {
    if (cluster.isPrimary) {
      this.utils.isMainServer().then((isMainServer) => {
        if (isMainServer) {
          const job = new CronJob('0 4 1 * *', async () => {
            this.logger.log(color.blue.bold('Starting monthly event-calendar prefill...'));
            try {
              const summary = await this.prefillEvents();
              this.logger.log(
                color.green.bold(
                  `Event-calendar prefill done: ${color.white.bold(
                    String(summary.created)
                  )} created, ${color.white.bold(String(summary.updated))} updated`
                )
              );
            } catch (e: any) {
              this.logger.log(
                color.red.bold(`Event-calendar prefill failed: ${e.message || e}`)
              );
            }
          });
          job.start();
          this.logger.log(
            color.blue.bold(
              `Event-calendar prefill cron scheduled for ${color.white.bold('1st of month, 4 AM')}`
            )
          );
        }
      });
    }
  }

  /**
   * Idempotently prefill gift-relevant, country-specific occasions for the
   * current year through `yearsAhead` years out. Auto events upsert on
   * (country, eventKey, year); admin edits to relevant/hidden/notes and all
   * manual events (eventKey = null) are left untouched.
   */
  public async prefillEvents(yearsAhead = 2): Promise<PrefillSummary> {
    const currentYear = new Date().getUTCFullYear();
    const years: number[] = [];
    for (let y = currentYear; y <= currentYear + yearsAhead; y++) years.push(y);

    // Ensure a base event exists for every occasion so each instance can link
    // to it (key -> base id). Re-running never overwrites admin edits.
    const baseMap = await this.ensureBaseEvents();

    // key = `${country}|${eventKey}|${year}` — library entries win over the
    // computed supplement.
    const collected = new Map<string, CollectedEvent>();

    for (const country of TARGET_COUNTRIES) {
      const hd = new Holidays(country, { languages: ['en'] });
      for (const year of years) {
        const holidays = hd.getHolidays(year) || [];
        for (const holiday of holidays) {
          for (const matcher of OCCASION_MATCHERS) {
            if (matcher.countries && !matcher.countries.includes(country)) continue;
            if (!matcher.match.test(holiday.name)) continue;
            const key = `${country}|${matcher.key}|${year}`;
            if (!collected.has(key)) {
              collected.set(key, {
                eventKey: matcher.key,
                name: holiday.name,
                country,
                date: this.toUtcMidnight(holiday.date),
                year,
                type: holiday.type || 'observance',
              });
            }
            break;
          }
        }
      }
    }

    // Fill gaps the library does not cover.
    for (const country of TARGET_COUNTRIES) {
      for (const year of years) {
        for (const rule of SUPPLEMENT_RULES) {
          if (rule.countries && !rule.countries.includes(country)) continue;
          const key = `${country}|${rule.key}|${year}`;
          if (collected.has(key)) continue;
          const date = rule.resolve(year, country);
          if (!date) continue;
          collected.set(key, {
            eventKey: rule.key,
            name: rule.label,
            country,
            date,
            year,
            type: 'observance',
          });
        }
      }
    }

    // Pre-fetch existing auto keys so we can report created vs updated counts.
    const existing = await this.prisma.calendarEvent.findMany({
      where: { source: 'auto', year: { in: years } },
      select: { country: true, eventKey: true, year: true },
    });
    const existingKeys = new Set(
      existing.map((e) => `${e.country}|${e.eventKey}|${e.year}`)
    );

    let created = 0;
    let updated = 0;
    const rows = [...collected];
    for (const [key] of rows) {
      if (existingKeys.has(key)) updated++;
      else created++;
    }

    // Upsert in parallel chunks — sequential round-trips to the DB are far too
    // slow for ~hundreds of rows (matters for the synchronous bulk-action).
    const CHUNK = 25;
    for (let i = 0; i < rows.length; i += CHUNK) {
      await Promise.all(
        rows.slice(i, i + CHUNK).map(([, ev]) =>
          this.prisma.calendarEvent.upsert({
            where: {
              country_eventKey_year: {
                country: ev.country,
                eventKey: ev.eventKey,
                year: ev.year,
              },
            },
            // Refresh only library-derived fields (incl. the base link, to
            // backfill existing rows); never touch admin-controlled
            // relevant / hidden / notes on existing rows.
            update: {
              name: ev.name,
              date: ev.date,
              type: ev.type,
              baseEventId: baseMap.get(ev.eventKey) ?? null,
            },
            create: {
              eventKey: ev.eventKey,
              baseEventId: baseMap.get(ev.eventKey) ?? null,
              name: ev.name,
              country: ev.country,
              date: ev.date,
              year: ev.year,
              type: ev.type,
              source: 'auto',
              relevant: true,
            },
          })
        )
      );
    }

    await this.bustOccasionCaches();
    return { countries: TARGET_COUNTRIES.length, years, created, updated };
  }

  /** Paginated, filtered list for the admin table. */
  public async searchEvents(filters: CalendarSearchFilters) {
    const page = Math.max(1, Number(filters.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(filters.limit) || 25));

    const where: any = {};
    if (filters.country) where.country = filters.country;
    if (filters.searchTerm) where.name = { contains: filters.searchTerm };
    if (filters.upcomingOnly) {
      const now = new Date();
      where.date = { gte: new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())) };
    }

    const [events, total] = await Promise.all([
      this.prisma.calendarEvent.findMany({
        where,
        orderBy: [{ date: 'asc' }, { country: 'asc' }],
        skip: (page - 1) * limit,
        take: limit,
        include: {
          baseEvent: {
            select: { id: true, key: true, name_en: true, windowDaysBefore: true },
          },
        },
      }),
      this.prisma.calendarEvent.count({ where }),
    ]);

    // Expose the base event's English name as `name` for the admin UI.
    const mapped = events.map((e: any) => ({
      ...e,
      baseEvent: e.baseEvent
        ? {
            id: e.baseEvent.id,
            key: e.baseEvent.key,
            name: e.baseEvent.name_en,
            windowDaysBefore: e.baseEvent.windowDaysBefore,
          }
        : null,
    }));

    return { events: mapped, total, page, totalPages: Math.ceil(total / limit) || 1 };
  }

  /**
   * Create a manual event (eventKey = null, source = 'manual'). A base event is
   * required so the instance can carry occasion-level settings + playlist links.
   */
  public async createEvent(input: CalendarEventInput) {
    const date = this.toUtcMidnight(input.date);
    const created = await this.prisma.calendarEvent.create({
      data: {
        eventKey: null,
        baseEventId: input.baseEventId ?? null,
        name: input.name,
        country: input.country,
        date,
        year: date.getUTCFullYear(),
        type: 'custom',
        source: 'manual',
        relevant: input.relevant ?? true,
        hidden: input.hidden ?? false,
        notes: input.notes ?? null,
      },
    });
    await this.bustOccasionCaches();
    return created;
  }

  public async updateEvent(id: number, input: Partial<CalendarEventInput>) {
    const data: any = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.country !== undefined) data.country = input.country;
    if (input.date !== undefined) {
      const date = this.toUtcMidnight(input.date);
      data.date = date;
      data.year = date.getUTCFullYear();
    }
    if (input.baseEventId !== undefined) data.baseEventId = input.baseEventId;
    if (input.relevant !== undefined) data.relevant = input.relevant;
    if (input.hidden !== undefined) data.hidden = input.hidden;
    if (input.notes !== undefined) data.notes = input.notes;
    const updated = await this.prisma.calendarEvent.update({ where: { id }, data });
    await this.bustOccasionCaches();
    return updated;
  }

  public async deleteEvent(id: number) {
    await this.prisma.calendarEvent.delete({ where: { id } });
    await this.bustOccasionCaches();
  }

  // --- base events ---------------------------------------------------------

  /** Upsert the seeded base occasions; returns a key -> id map. */
  private async ensureBaseEvents(): Promise<Map<string, number>> {
    const results = await Promise.all(
      BASE_EVENT_SEEDS.map((seed) =>
        this.prisma.eventBase.upsert({
          where: { key: seed.key },
          // Never overwrite admin edits to name / window / notes on re-run.
          update: {},
          create: {
            key: seed.key,
            name_en: seed.name,
            description_en: seed.description,
            body_en: seed.body,
          },
        })
      )
    );
    return new Map(results.map((b) => [b.key, b.id]));
  }

  /** All base events with their linked-instance counts (for the admin UI). */
  public async listBaseEvents() {
    const bases = await this.prisma.eventBase.findMany({
      orderBy: { name_en: 'asc' },
      include: { _count: { select: { events: true } } },
    });
    // Expose the English name/description as `name`/`description` for the
    // (English-only) admin UI.
    return bases.map((b) => ({ ...b, name: b.name_en, description: b.description_en }));
  }

  public async createBaseEvent(input: BaseEventInput) {
    const key = (input.key && input.key.trim()) || (await this.uniqueKeyFromName(input.name));
    const base = await this.prisma.eventBase.create({
      data: {
        key,
        name_en: input.name,
        description_en: input.description ?? null,
        body_en: input.body ?? null,
        windowDaysBefore: input.windowDaysBefore ?? 14,
        notes: input.notes ?? null,
      },
    });
    // Fire-and-forget: translate name + description + body into all languages.
    // The save (and the HTTP response) must not wait for the LLM round-trip.
    void this.translateBaseEvent(base.id, base.name_en, base.description_en, base.body_en);
    await this.bustOccasionCaches();
    return base;
  }

  /** Translate a base event's English name + description into all languages (async). */
  private async translateBaseEvent(
    id: number,
    name: string,
    description: string | null,
    body: string | null = null
  ): Promise<void> {
    try {
      // All app locales except the English source.
      const locales = this.translation.allLocales.filter((l) => l !== 'en');
      const data: any = {};

      const nameTranslations = await this.chatgpt.translateText(name, locales);
      for (const loc of locales) {
        if (nameTranslations[loc]) data[`name_${loc}`] = nameTranslations[loc];
      }
      if (description && description.trim()) {
        const descTranslations = await this.chatgpt.translateText(description, locales);
        for (const loc of locales) {
          if (descTranslations[loc]) data[`description_${loc}`] = descTranslations[loc];
        }
      }
      if (body && body.trim()) {
        const bodyTranslations = await this.chatgpt.translateText(body, locales);
        for (const loc of locales) {
          if (bodyTranslations[loc]) data[`body_${loc}`] = bodyTranslations[loc];
        }
      }

      if (Object.keys(data).length) {
        await this.prisma.eventBase.update({ where: { id }, data });
        await this.bustOccasionCaches();
        this.logger.log(
          color.green.bold(
            `Translated base event ${color.white.bold(name)} (${color.white.bold(
              String(Object.keys(data).length)
            )} fields)`
          )
        );
      }
    } catch (e: any) {
      this.logger.log(
        color.red.bold(`Failed to translate base event (${name}): ${e.message || e}`)
      );
    }
  }

  public async updateBaseEvent(id: number, input: any) {
    const data: any = {};
    // Per-locale name/description/body columns (admin edits all languages).
    for (const loc of this.translation.allLocales) {
      for (const field of ['name', 'description', 'body']) {
        const col = `${field}_${loc}`;
        if (input[col] !== undefined) data[col] = input[col];
      }
    }
    // Back-compat: plain name/description/body update the English source.
    if (input.name !== undefined) data.name_en = input.name;
    if (input.description !== undefined) data.description_en = input.description;
    if (input.body !== undefined) data.body_en = input.body;
    if (input.windowDaysBefore !== undefined) data.windowDaysBefore = input.windowDaysBefore;
    if (input.notes !== undefined) data.notes = input.notes;
    const updated = await this.prisma.eventBase.update({ where: { id }, data });
    await this.bustOccasionCaches();
    return updated;
  }

  /** Delete a base event. Linked calendar events cascade (schema onDelete). */
  public async deleteBaseEvent(id: number) {
    await this.prisma.eventBase.delete({ where: { id } });
    await this.bustOccasionCaches();
  }

  /** Slugify a name into a unique base-event key. */
  private async uniqueKeyFromName(name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .trim()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 50) || 'event';
    let key = base;
    let n = 2;
    while (await this.prisma.eventBase.findUnique({ where: { key } })) {
      key = `${base}_${n++}`;
    }
    return key;
  }

  // --- playlist <-> base event links ---------------------------------------

  /** Base events linked to a playlist (looked up by its string playlistId). */
  public async getPlaylistBaseEvents(playlistIdStr: string) {
    const playlist = await this.prisma.playlist.findUnique({
      where: { playlistId: playlistIdStr },
      select: {
        id: true,
        eventBaseLinks: {
          select: { baseEvent: { select: { id: true, key: true, name_en: true } } },
          orderBy: { baseEvent: { name_en: 'asc' } },
        },
      },
    });
    if (!playlist) throw new Error('Playlist not found');
    return playlist.eventBaseLinks.map((l) => ({
      id: l.baseEvent.id,
      key: l.baseEvent.key,
      name: l.baseEvent.name_en,
    }));
  }

  /** Replace a playlist's base-event links with the given set of base ids. */
  public async setPlaylistBaseEvents(playlistIdStr: string, baseEventIds: number[]) {
    const playlist = await this.prisma.playlist.findUnique({
      where: { playlistId: playlistIdStr },
      select: { id: true },
    });
    if (!playlist) throw new Error('Playlist not found');

    const wanted = [...new Set((baseEventIds || []).map(Number).filter((n) => !isNaN(n)))];
    await this.prisma.$transaction([
      // Remove links no longer wanted (notIn [-1] = remove all when wanted is empty).
      this.prisma.eventBasePlaylist.deleteMany({
        where: {
          playlistId: playlist.id,
          baseEventId: { notIn: wanted.length ? wanted : [-1] },
        },
      }),
      ...wanted.map((baseEventId) =>
        this.prisma.eventBasePlaylist.upsert({
          where: { baseEventId_playlistId: { baseEventId, playlistId: playlist.id } },
          update: {},
          create: { baseEventId, playlistId: playlist.id },
        })
      ),
      // Manual curation marks the playlist as reviewed (even when set to none).
      this.prisma.playlist.update({
        where: { id: playlist.id },
        data: { baseEventsTagged: true },
      }),
    ]);
    await this.bustOccasionCaches();
    return this.getPlaylistBaseEvents(playlistIdStr);
  }

  /** Count featured playlists that have not been reviewed for base events yet. */
  public async countUntaggedFeatured(): Promise<number> {
    return this.prisma.playlist.count({
      where: { featured: true, baseEventsTagged: false },
    });
  }

  /**
   * One-time AI backfill: for every featured playlist with no base-event links,
   * ask the LLM which base events it fits and create the links. Runs in the
   * background (logs progress, Pushover summary on completion) and skips
   * already-linked playlists so it is safe to re-run.
   */
  public async backfillPlaylistBaseEvents(): Promise<void> {
    if (CalendarService.backfillRunning) {
      this.logger.log(
        color.yellow.bold('Playlist base-event backfill already running; skipping.')
      );
      return;
    }
    CalendarService.backfillRunning = true;
    const startedAt = Date.now();
    try {
      const baseMap = await this.ensureBaseEvents();
      const baseRows = await this.prisma.eventBase.findMany({
        select: { key: true, name_en: true, description_en: true },
      });
      // Feed the classifier the English name + description of each occasion.
      const bases = baseRows.map((b) => ({
        key: b.key,
        name: b.name_en,
        description: b.description_en,
      }));

      const playlists = await this.prisma.playlist.findMany({
        where: { featured: true, baseEventsTagged: false },
        select: {
          id: true,
          name: true,
          description_en: true,
          genre: { select: { name_en: true } },
        },
      });

      this.logger.log(
        color.blue.bold(
          `Starting playlist base-event backfill for ${color.white.bold(
            String(playlists.length)
          )} featured playlists...`
        )
      );

      let processed = 0;
      let linked = 0;
      const CHUNK = 5; // limit concurrent LLM calls
      for (let i = 0; i < playlists.length; i += CHUNK) {
        await Promise.all(
          playlists.slice(i, i + CHUNK).map(async (p) => {
            const keys = await this.chatgpt.determineBaseEvents(
              p.name,
              p.description_en,
              p.genre?.name_en ?? null,
              bases
            );
            const rows = keys
              .map((k) => baseMap.get(k))
              .filter((id): id is number => typeof id === 'number')
              .map((baseEventId) => ({ baseEventId, playlistId: p.id }));
            if (rows.length) {
              await this.prisma.eventBasePlaylist.createMany({
                data: rows,
                skipDuplicates: true,
              });
              linked += rows.length;
            }
            // Mark reviewed regardless of whether any occasion matched.
            await this.prisma.playlist.update({
              where: { id: p.id },
              data: { baseEventsTagged: true },
            });
            processed++;
          })
        );
        this.logger.log(
          color.blue(
            `Backfill progress: ${color.white.bold(
              `${processed}/${playlists.length}`
            )} (${color.white.bold(String(linked))} links)`
          )
        );
      }

      await this.bustOccasionCaches();
      const secs = Math.round((Date.now() - startedAt) / 1000);
      // Plain text for the Pushover notification (no color codes).
      const summary = `Playlist base-event backfill done: ${processed} playlists processed, ${linked} links created in ${secs}s.`;
      this.logger.log(
        color.green.bold(
          `Playlist base-event backfill done: ${color.white.bold(
            String(processed)
          )} playlists processed, ${color.white.bold(
            String(linked)
          )} links created in ${color.white.bold(`${secs}s`)}.`
        )
      );
      this.pushover.sendMessage(
        { message: summary, title: 'Event backfill complete' },
        '',
        true
      );
    } catch (e: any) {
      this.logger.log(
        color.red.bold(`Playlist base-event backfill failed: ${e.message || e}`)
      );
    } finally {
      CalendarService.backfillRunning = false;
    }
  }

  // --- public occasion surfaces (seasonal row + landing pages) -------------

  /**
   * Active occasions for a visitor's country today: base events whose
   * country-specific date is within [today, today + windowDaysBefore], soonest
   * first, each with its linked **featured** playlists (card-projected).
   */
  public async getActiveOccasionsForCountry(country: string, locale: string) {
    const safeLocale = this.safeLocale(locale);
    const today = this.todayUtc();
    const horizon = new Date(today.getTime() + 60 * 86400000); // lookahead cap
    const leadTimeDays = await this.getCountryLeadTimeDays((country || '').toUpperCase());

    const events = await this.prisma.calendarEvent.findMany({
      where: {
        country: (country || '').toUpperCase(),
        hidden: false,
        relevant: true,
        baseEventId: { not: null },
        date: { gte: today, lte: horizon },
      },
      orderBy: { date: 'asc' },
      include: {
        baseEvent: {
          include: {
            playlists: {
              orderBy: { sortOrder: 'asc' },
              include: { playlist: { select: { id: true, featured: true } } },
            },
          },
        },
      },
    });

    const out: any[] = [];
    for (const ev of events) {
      const eb: any = ev.baseEvent;
      if (!eb) continue;
      const daysUntil = Math.round((ev.date.getTime() - today.getTime()) / 86400000);
      if (daysUntil > eb.windowDaysBefore) continue; // not yet in the promo window
      const ids = eb.playlists
        .filter((l: any) => l.playlist?.featured)
        .map((l: any) => l.playlistId);
      const playlists = await projectPlaylistsByIds(this.prisma, this.utils, ids, safeLocale);
      if (playlists.length === 0) continue;
      // Order-by cutoff so we never promise a delivery we can't make.
      const shipByDays = daysUntil - leadTimeDays;
      const shipByDate = new Date(ev.date.getTime() - leadTimeDays * 86400000);
      out.push({
        key: eb.key,
        name: eb[`name_${safeLocale}`] || eb.name_en,
        description: eb[`description_${safeLocale}`] || eb.description_en || null,
        slug: occasionSlug(eb, safeLocale),
        date: ev.date,
        daysUntil,
        leadTimeDays,
        shipByDays, // days left to order in time (negative = too late to ship)
        shipByDate,
        canShip: shipByDays >= 0,
        playlists,
      });
    }
    return out;
  }

  /**
   * Data for an occasion landing page `/[locale]/occasion/[slug]`. Resolves the
   * slug to a base event, uses the locale's primary market for the date, and
   * returns ALL linked playlists (card-projected) + per-locale slugs (hreflang).
   */
  public async getOccasionLanding(locale: string, slug: string) {
    const safeLocale = this.safeLocale(locale);
    const primaryCountry = LOCALE_PRIMARY_COUNTRY[safeLocale] || 'US';

    const bases = await this.prisma.eventBase.findMany();
    let eb: any = bases.find((b) => occasionSlug(b, safeLocale) === slug);
    let shouldRedirect = false;
    let correctSlug: string | undefined;
    if (!eb) {
      // Slug may belong to another locale or the raw key — redirect to canonical.
      eb = bases.find((b) => {
        const candidates = Object.keys(LOCALE_PRIMARY_COUNTRY).map((l) =>
          occasionSlug(b, l)
        );
        candidates.push(slugify(((b as any).key || '').replace(/_/g, ' ')));
        return candidates.includes(slug);
      });
      if (!eb) return { success: false as const };
      shouldRedirect = true;
      correctSlug = occasionSlug(eb, safeLocale);
    }

    // Which locales get a page for this occasion (primary market applies).
    const countryRows = await this.prisma.calendarEvent.findMany({
      where: { eventKey: eb.key },
      select: { country: true },
      distinct: ['country'],
    });
    const countries = new Set(countryRows.map((r) => r.country));
    const allSlugs: Record<string, string> = {};
    for (const [loc, ctry] of Object.entries(LOCALE_PRIMARY_COUNTRY)) {
      if (countries.has(ctry)) allSlugs[loc] = occasionSlug(eb, loc);
    }

    // Upcoming instance for the locale's primary market (fallback: latest).
    const today = this.todayUtc();
    let instance = await this.prisma.calendarEvent.findFirst({
      where: { eventKey: eb.key, country: primaryCountry, date: { gte: today } },
      orderBy: { date: 'asc' },
    });
    if (!instance) {
      instance = await this.prisma.calendarEvent.findFirst({
        where: { eventKey: eb.key, country: primaryCountry },
        orderBy: { date: 'desc' },
      });
    }
    const date = instance?.date ?? null;
    const daysUntil = date
      ? Math.round((date.getTime() - today.getTime()) / 86400000)
      : null;

    // ALL linked playlists (sortOrder), card-projected.
    const links = await this.prisma.eventBasePlaylist.findMany({
      where: { baseEventId: eb.id },
      orderBy: { sortOrder: 'asc' },
      select: { playlistId: true },
    });
    const playlists = await projectPlaylistsByIds(
      this.prisma,
      this.utils,
      links.map((l) => l.playlistId),
      safeLocale
    );

    return {
      success: true as const,
      occasion: {
        key: eb.key,
        name: eb[`name_${safeLocale}`] || eb.name_en,
        description: eb[`description_${safeLocale}`] || eb.description_en || null,
        body: eb[`body_${safeLocale}`] || eb.body_en || null,
        slug: occasionSlug(eb, safeLocale),
        date,
        daysUntil,
        allSlugs,
        playlists,
        shouldRedirect,
        correctSlug,
      },
    };
  }

  /** Occasions applicable to a locale's primary market (for the sitemap/index). */
  public async listOccasions(locale: string) {
    const safeLocale = this.safeLocale(locale);
    const primaryCountry = LOCALE_PRIMARY_COUNTRY[safeLocale] || 'US';
    const rows = await this.prisma.calendarEvent.findMany({
      where: { country: primaryCountry, baseEventId: { not: null } },
      select: { baseEventId: true },
      distinct: ['baseEventId'],
    });
    const ids = rows.map((r) => r.baseEventId!).filter((x) => x != null);
    if (ids.length === 0) return [];
    const bases = await this.prisma.eventBase.findMany({ where: { id: { in: ids } } });
    return bases.map((b) => ({
      slug: occasionSlug(b, safeLocale),
      updatedAt: b.updatedAt,
    }));
  }

  private safeLocale(locale: string): string {
    return locale && this.translation.isValidLocale(locale) ? locale : 'en';
  }

  private todayUtc(): Date {
    const n = new Date();
    return new Date(Date.UTC(n.getUTCFullYear(), n.getUTCMonth(), n.getUTCDate()));
  }

  /** Normalise any date input to a UTC-midnight Date (calendar date only). */
  private toUtcMidnight(value: string | Date): Date {
    const ymd =
      typeof value === 'string'
        ? value.slice(0, 10)
        : value.toISOString().slice(0, 10);
    return new Date(`${ymd}T00:00:00.000Z`);
  }
}

export default CalendarService;
