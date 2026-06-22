import { describe, it, expect, beforeAll, vi } from 'vitest';
import { resetDb, prisma } from '../helpers/db';
import CalendarService from '../../src/calendarService';
import { ChatGPT } from '../../src/chatgpt';

/**
 * Event-calendar prefill + CRUD against the test database. Verifies
 * country-specific dates, idempotent upserts, that admin edits and manual
 * events survive a re-prefill, and the search/CRUD helpers.
 */
describe('CalendarService', () => {
  const calendar = CalendarService.getInstance();

  beforeAll(async () => {
    // Never hit OpenAI from tests: createBaseEvent fires an async name
    // translation, and the backfill uses determineBaseEvents.
    vi.spyOn(ChatGPT.prototype, 'translateText').mockResolvedValue({});
    vi.spyOn(ChatGPT.prototype, 'determineBaseEvents').mockResolvedValue([]);
    await resetDb();
  });

  it('prefills country-specific, gift-relevant occasions', { timeout: 30000 }, async () => {
    const summary = await calendar.prefillEvents();
    expect(summary.countries).toBe(15);
    expect(summary.created).toBeGreaterThan(0);
    expect(summary.updated).toBe(0);

    const total = await prisma().calendarEvent.count();
    expect(total).toBe(summary.created);

    // Mother's Day falls in different months per country.
    const nlMother = await prisma().calendarEvent.findFirst({
      where: { eventKey: 'mothers_day', country: 'NL', year: summary.years[0] },
    });
    const gbMother = await prisma().calendarEvent.findFirst({
      where: { eventKey: 'mothers_day', country: 'GB', year: summary.years[0] },
    });
    expect(nlMother).toBeTruthy();
    expect(gbMother).toBeTruthy();
    expect(nlMother!.date.getUTCMonth()).not.toBe(gbMother!.date.getUTCMonth());

    // Market-specific occasions only exist where applicable.
    const sinterklaasCountries = await prisma().calendarEvent.findMany({
      where: { eventKey: 'sinterklaas' },
      select: { country: true },
      distinct: ['country'],
    });
    expect(sinterklaasCountries.map((r) => r.country).sort()).toEqual(['BE', 'NL']);

    const thanksgiving = await prisma().calendarEvent.findMany({
      where: { eventKey: 'thanksgiving' },
      select: { country: true },
      distinct: ['country'],
    });
    expect(thanksgiving.map((r) => r.country)).toEqual(['US']);
  });

  it('is idempotent and preserves admin edits + manual events', { timeout: 30000 }, async () => {
    const before = await prisma().calendarEvent.count();

    // Admin marks one auto event not-relevant and hidden.
    const target = await prisma().calendarEvent.findFirst({
      where: { eventKey: 'christmas', country: 'NL' },
    });
    await calendar.updateEvent(target!.id, { relevant: false, hidden: true });

    // Add a manual event.
    const manual = await calendar.createEvent({
      name: 'Company Anniversary',
      country: 'NL',
      date: '2026-09-01',
    });
    expect(manual.eventKey).toBeNull();
    expect(manual.source).toBe('manual');

    const summary = await calendar.prefillEvents();
    expect(summary.created).toBe(0);
    expect(summary.updated).toBe(before);

    // No duplicates: total only grew by the one manual event.
    expect(await prisma().calendarEvent.count()).toBe(before + 1);

    // Admin edits untouched.
    const reloaded = await prisma().calendarEvent.findUnique({ where: { id: target!.id } });
    expect(reloaded!.relevant).toBe(false);
    expect(reloaded!.hidden).toBe(true);

    // Manual event survives.
    expect(await prisma().calendarEvent.findUnique({ where: { id: manual.id } })).toBeTruthy();
  });

  it('searches with country and upcoming filters', async () => {
    const byCountry = await calendar.searchEvents({ country: 'NL', upcomingOnly: false, limit: 100 });
    expect(byCountry.events.length).toBeGreaterThan(0);
    expect(byCountry.events.every((e) => e.country === 'NL')).toBe(true);

    const byName = await calendar.searchEvents({ searchTerm: 'Anniversary', upcomingOnly: false });
    expect(byName.events.some((e) => e.name === 'Company Anniversary')).toBe(true);
  });

  it('updates and deletes events', async () => {
    const created = await calendar.createEvent({
      name: 'Temp Event',
      country: 'DE',
      date: '2027-01-15',
    });
    const updated = await calendar.updateEvent(created.id, { name: 'Renamed Event', date: '2028-02-20' });
    expect(updated.name).toBe('Renamed Event');
    expect(updated.year).toBe(2028);

    await calendar.deleteEvent(created.id);
    expect(await prisma().calendarEvent.findUnique({ where: { id: created.id } })).toBeNull();
  });

  it('seeds base events and links every auto instance', async () => {
    const bases = await calendar.listBaseEvents();
    expect(bases.length).toBeGreaterThanOrEqual(9);

    const christmas = bases.find((b) => b.key === 'christmas');
    expect(christmas).toBeTruthy();
    expect(christmas!._count.events).toBeGreaterThan(0);

    // No auto event is left without a base link.
    const unlinked = await prisma().calendarEvent.count({
      where: { source: 'auto', baseEventId: null },
    });
    expect(unlinked).toBe(0);
  });

  it('creates, updates and cascade-deletes base events', async () => {
    const base = await calendar.createBaseEvent({ name: 'Black Friday', windowDaysBefore: 7 });
    expect(base.key).toBe('black_friday'); // slug auto-derived from the name
    expect(base.windowDaysBefore).toBe(7);

    // A manual event can link to the new base.
    const evt = await calendar.createEvent({
      name: 'Black Friday 2026',
      country: 'NL',
      date: '2026-11-27',
      baseEventId: base.id,
    });
    expect(evt.baseEventId).toBe(base.id);

    const updated = await calendar.updateBaseEvent(base.id, { windowDaysBefore: 30 });
    expect(updated.windowDaysBefore).toBe(30);

    // Deleting the base cascades to its linked events.
    await calendar.deleteBaseEvent(base.id);
    expect(await prisma().eventBase.findUnique({ where: { id: base.id } })).toBeNull();
    expect(await prisma().calendarEvent.findUnique({ where: { id: evt.id } })).toBeNull();
  });

  it('links playlists to base events, marks them tagged, and cascades on base delete', async () => {
    const base = await calendar.createBaseEvent({ name: 'Christmas Tagging Test' });
    const playlist = await prisma().playlist.create({
      data: { playlistId: 'pl_evt_test', name: 'Xmas Hits', image: 'x.png', featured: true },
    });
    expect(playlist.baseEventsTagged).toBe(false);

    const untaggedBefore = await calendar.countUntaggedFeatured();
    expect(untaggedBefore).toBeGreaterThan(0);

    // Linking sets the tags and flips baseEventsTagged.
    const links = await calendar.setPlaylistBaseEvents('pl_evt_test', [base.id]);
    expect(links.map((l) => l.id)).toContain(base.id);
    const reloaded = await prisma().playlist.findUnique({ where: { id: playlist.id } });
    expect(reloaded!.baseEventsTagged).toBe(true);
    expect(await calendar.countUntaggedFeatured()).toBe(untaggedBefore - 1);

    // get reflects the link
    expect(await calendar.getPlaylistBaseEvents('pl_evt_test')).toHaveLength(1);

    // Clearing to none keeps the playlist tagged (reviewed) but removes links.
    const cleared = await calendar.setPlaylistBaseEvents('pl_evt_test', []);
    expect(cleared).toHaveLength(0);
    expect(await calendar.countUntaggedFeatured()).toBe(untaggedBefore - 1);

    // Re-link, then deleting the base cascades the link away.
    await calendar.setPlaylistBaseEvents('pl_evt_test', [base.id]);
    expect(await calendar.getPlaylistBaseEvents('pl_evt_test')).toHaveLength(1);
    await calendar.deleteBaseEvent(base.id);
    expect(await calendar.getPlaylistBaseEvents('pl_evt_test')).toHaveLength(0);
    // The playlist itself survives (only the link cascades).
    expect(await prisma().playlist.findUnique({ where: { id: playlist.id } })).toBeTruthy();
  });
});
