import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { outbound } from '../../helpers/recording-mock';

/**
 * Pure unit tests for src/hitlist.ts: submission flow (dup-email guard,
 * voting window, cardName construction, verification mail), async track
 * processing (scoring/filtering/dedupe, track upserts, birthday track),
 * verification, cached company-list lookup and the MusicFetch search.
 *
 * Everything (prisma, cache, spotify, vibe, data, utils, axios) is mocked;
 * mail is asserted through the global recording mock.
 */

const h = vi.hoisted(() => {
  const cacheStore = new Map<string, string>();
  return {
    cacheStore,
    cacheGet: vi.fn(async (key: string) => cacheStore.get(key) ?? null),
    cacheSet: vi.fn(async (key: string, value: string, _ttl?: number) => {
      cacheStore.set(key, value);
    }),
    prisma: {
      companyListSubmission: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
        update: vi.fn(),
      },
      companyList: {
        findUnique: vi.fn(),
        findFirst: vi.fn(),
      },
      track: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
        create: vi.fn(),
      },
      companyListSubmissionTrack: {
        deleteMany: vi.fn(),
        create: vi.fn(),
      },
    },
    getTracksByIds: vi.fn(),
    spotifySearchTracks: vi.fn(),
    markSpotifyForReload: vi.fn(async () => undefined),
    updateTrackYear: vi.fn(async () => undefined),
  };
});

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => h.prisma },
}));
vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
  },
}));
vi.mock('../../../src/cache', () => ({
  default: { getInstance: () => ({ get: h.cacheGet, set: h.cacheSet }) },
}));
vi.mock('../../../src/utils', () => ({
  default: class {
    parseBoolean(value: any): boolean {
      return value === true || value === 'true' || value === 1;
    }
    generateRandomString(_len?: number): string {
      return 'VHASH32';
    }
    async createDir(_p: string): Promise<void> {}
  },
}));
vi.mock('../../../src/spotify', () => ({
  default: {
    getInstance: () => ({
      getTracksByIds: h.getTracksByIds,
      searchTracks: h.spotifySearchTracks,
    }),
  },
}));
vi.mock('../../../src/music', () => ({ Music: class {} }));
vi.mock('../../../src/settings', () => ({
  default: { getInstance: () => ({}) },
}));
vi.mock('../../../src/data', () => ({
  default: { getInstance: () => ({ updateTrackYear: h.updateTrackYear }) },
}));
vi.mock('../../../src/vibe', () => ({
  default: {
    getInstance: () => ({ markSpotifyForReload: h.markSpotifyForReload }),
  },
}));
vi.mock('../../../src/translation', () => ({
  default: class {
    allLocales = ['en', 'nl'];
  },
}));
vi.mock('axios');

import axios from 'axios';
import Hitlist from '../../../src/hitlist';

const hitlist = Hitlist.getInstance();
const axiosGet = vi.mocked(axios.get);

/** Allow the un-awaited processSubmissionAsync chain to settle. */
const flushAsync = () => new Promise((resolve) => setImmediate(resolve));

function resetPrisma() {
  for (const model of Object.values(h.prisma)) {
    for (const fn of Object.values(model)) {
      (fn as any).mockReset();
    }
  }
}

const COMPANY_LIST = {
  id: 9,
  name: 'Summer List',
  startAt: null as Date | null,
  endAt: null as Date | null,
  Company: { name: 'ACME' },
  slug: 'acme-list',
  qrvote: true,
  numberOfTracks: 3,
  numberOfCards: 2,
  minimumNumberOfTracks: 1,
};

function makeSubmission(overrides: Record<string, any> = {}) {
  return [
    {
      submissionHash: 'subhash',
      companyListId: '9',
      firstname: 'rick',
      lastname: 'van der berg',
      email: 'r@example.com',
      locale: 'en',
      agreeToUseName: 'true',
      marketingEmails: false,
      trackId: 'A',
      position: 1,
      ...overrides,
    },
  ];
}

beforeEach(() => {
  outbound.reset();
  resetPrisma();
  h.cacheStore.clear();
  h.cacheGet.mockClear();
  h.cacheSet.mockClear();
  h.getTracksByIds.mockReset();
  h.spotifySearchTracks.mockReset();
  h.markSpotifyForReload.mockClear();
  h.updateTrackYear.mockClear();
  axiosGet.mockReset();
});

describe('Hitlist.submit', () => {
  beforeEach(() => {
    h.prisma.companyList.findUnique.mockResolvedValue({ ...COMPANY_LIST });
    h.prisma.companyListSubmission.findFirst.mockResolvedValue(null);
    h.prisma.companyListSubmission.findUnique.mockResolvedValue(null);
    h.prisma.companyListSubmission.create.mockImplementation(
      async ({ data }: any) => ({ id: 55, ...data })
    );
    h.prisma.companyListSubmission.update.mockImplementation(
      async ({ data }: any) => ({ id: 60, ...data })
    );
    // End the fire-and-forget async processing immediately.
    h.getTracksByIds.mockResolvedValue({ success: false });
  });

  it('rejects when submission hash or list id is missing', async () => {
    const res = await hitlist.submit([{ companyListId: '9' }]);
    expect(res).toEqual({
      success: false,
      error: 'Missing submission hash or company list ID',
    });
    expect(h.prisma.companyList.findUnique).not.toHaveBeenCalled();
  });

  it('rejects a second submission with the same email, excluding own hash', async () => {
    h.prisma.companyListSubmission.findFirst.mockResolvedValue({ id: 1 });
    const res = await hitlist.submit(makeSubmission());
    expect(res).toEqual({ success: false, error: 'playlistAlreadySubmitted' });
    expect(h.prisma.companyListSubmission.findFirst).toHaveBeenCalledWith({
      where: {
        companyListId: 9,
        email: 'r@example.com',
        NOT: { hash: 'subhash' },
      },
    });
    expect(h.prisma.companyListSubmission.create).not.toHaveBeenCalled();
  });

  it('rejects when the company list does not exist', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(null);
    const res = await hitlist.submit(makeSubmission());
    expect(res).toEqual({ success: false, error: 'Company list not found' });
  });

  it('rejects with votingClosed when endAt is in the past', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      ...COMPANY_LIST,
      startAt: new Date(Date.now() - 86400_000),
      endAt: new Date(Date.now() - 3600_000),
    });
    const res = await hitlist.submit(makeSubmission());
    expect(res).toEqual({ success: false, error: 'votingClosed' });
    expect(h.prisma.companyListSubmission.create).not.toHaveBeenCalled();
    expect(outbound.calls('Mail')).toHaveLength(0);
  });

  it('rejects with votingClosed when only startAt is set and lies in the future', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      ...COMPANY_LIST,
      startAt: new Date(Date.now() + 3600_000),
      endAt: null,
    });
    const res = await hitlist.submit(makeSubmission());
    expect(res).toEqual({ success: false, error: 'votingClosed' });
  });

  it('creates a new submission with tussenvoegsel-aware cardName and sends the verification mail', async () => {
    const res = await hitlist.submit(makeSubmission());
    await flushAsync();

    expect(res).toEqual({ success: true });
    expect(h.prisma.companyListSubmission.create).toHaveBeenCalledWith({
      data: {
        companyListId: 9,
        hash: 'subhash',
        verificationHash: 'VHASH32',
        status: 'pending_verification',
        firstname: 'rick',
        lastname: 'van der berg',
        email: 'r@example.com',
        agreeToUseName: true,
        marketingEmails: false,
        locale: 'en',
        // "rick" capitalized + tussenvoegsel "van der" + "B." from "berg"
        cardName: 'Rick van der B.',
        birthDate: null,
      },
    });
    expect(h.markSpotifyForReload).toHaveBeenCalledWith(9);

    const mails = outbound.calls('Mail', 'sendVerificationEmail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args).toEqual([
      'r@example.com',
      'rick van der berg',
      'ACME',
      'VHASH32',
      'en',
      'acme-list',
      true,
    ]);
  });

  it('updates an existing submission, keeping old fields when new ones are empty', async () => {
    h.prisma.companyListSubmission.findUnique.mockResolvedValue({
      id: 60,
      firstname: 'Old',
      lastname: 'Name',
      email: 'old@example.com',
      birthDate: null,
      locale: 'nl',
    });
    h.prisma.companyListSubmission.update.mockImplementation(
      async ({ data }: any) => ({ id: 60, ...data, locale: 'nl' })
    );

    const res = await hitlist.submit(
      makeSubmission({ firstname: '', lastname: '', email: 'new@example.com' })
    );
    await flushAsync();

    expect(res).toEqual({ success: true });
    expect(h.prisma.companyListSubmission.create).not.toHaveBeenCalled();
    expect(h.prisma.companyListSubmission.update).toHaveBeenCalledWith({
      where: { id: 60 },
      data: {
        status: 'pending_verification',
        firstname: 'Old',
        lastname: 'Name',
        email: 'new@example.com',
        verificationHash: 'VHASH32',
        agreeToUseName: true,
        marketingEmails: false,
        birthDate: null,
      },
    });
    // Email is sent with the submission's stored locale.
    const mails = outbound.calls('Mail', 'sendVerificationEmail');
    expect(mails).toHaveLength(1);
    expect(mails[0].args[4]).toBe('nl');
  });

  it('skips the verification mail when no email is given', async () => {
    const res = await hitlist.submit(
      makeSubmission({ email: undefined, firstname: '', lastname: '' })
    );
    await flushAsync();
    expect(res).toEqual({ success: true });
    // No email -> no duplicate check either.
    expect(h.prisma.companyListSubmission.findFirst).not.toHaveBeenCalled();
    expect(outbound.calls('Mail', 'sendVerificationEmail')).toHaveLength(0);
    // cardName is null when firstname is empty.
    expect(
      h.prisma.companyListSubmission.create.mock.calls[0][0].data.cardName
    ).toBeNull();
  });

  it('returns a generic error when prisma throws', async () => {
    h.prisma.companyListSubmission.findFirst.mockRejectedValue(
      new Error('db down')
    );
    const res = await hitlist.submit(makeSubmission());
    expect(res).toEqual({ success: false, error: 'Error submitting hitlist' });
  });
});

describe('Hitlist.processSubmissionAsync', () => {
  const callAsync = (list: any[], submissionId = 55, birthdayTrackId: string | null = null) =>
    (hitlist as any).processSubmissionAsync(list, submissionId, birthdayTrackId);

  beforeEach(() => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      numberOfTracks: 3,
      numberOfCards: 2,
      name: 'Summer List',
    });
    h.prisma.track.findUnique.mockResolvedValue(null);
    h.prisma.track.create.mockImplementation(async ({ data }: any) => ({
      id: 22,
      ...data,
    }));
    h.prisma.companyListSubmissionTrack.deleteMany.mockResolvedValue({});
    h.prisma.companyListSubmissionTrack.create.mockResolvedValue({});
  });

  it('does nothing for an empty hitlist', async () => {
    await callAsync([]);
    expect(h.prisma.companyList.findUnique).not.toHaveBeenCalled();
    expect(h.getTracksByIds).not.toHaveBeenCalled();
  });

  it('does nothing when companyListId is missing', async () => {
    await callAsync([{ trackId: 'A', position: 1 }]);
    expect(h.prisma.companyList.findUnique).not.toHaveBeenCalled();
  });

  it('does nothing when the company list cannot be found', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(null);
    await callAsync([{ companyListId: '9', trackId: 'A', position: 1 }]);
    expect(h.getTracksByIds).not.toHaveBeenCalled();
  });

  it('scores by position, keeps the top numberOfCards tracks, reuses exact-match tracks and creates new ones', async () => {
    h.prisma.track.findFirst.mockImplementation(async ({ where }: any) =>
      where.artist === 'Artist A' ? { id: 11 } : null
    );
    const spotifyData = [
      {
        trackId: 'A',
        name: 'Song A',
        artist: 'Artist A',
        album: 'Album A',
        preview: 'pA',
        isrc: 'iA',
        releaseDate: '1999-05-01',
        link: 'lA',
      },
      {
        trackId: 'B',
        name: 'Song B',
        artist: 'Artist B',
        album: 'Album B',
        preview: 'pB',
        isrc: 'iB',
        releaseDate: '2001-07-07',
        link: 'lB',
      },
    ];
    h.getTracksByIds.mockResolvedValue({ success: true, data: spotifyData });

    // 3 tracks, numberOfCards = 2 -> position 3 must be dropped.
    await callAsync([
      { companyListId: '9', trackId: 'A', position: 1 },
      { companyListId: '9', trackId: 'B', position: 2 },
      { companyListId: '9', trackId: 'C', position: 3 },
    ]);

    expect(h.getTracksByIds).toHaveBeenCalledWith(['A', 'B']);
    // Track A matched on artist+name, only B gets created.
    expect(h.prisma.track.create).toHaveBeenCalledTimes(1);
    expect(h.prisma.track.create).toHaveBeenCalledWith({
      data: {
        trackId: 'B',
        name: 'Song B',
        artist: 'Artist B',
        album: 'Album B',
        preview: 'pB',
        isrc: 'iB',
        spotifyYear: 2001,
        spotifyLink: 'lB',
        youtubeLink: '',
        manuallyChecked: false,
      },
    });
    expect(h.updateTrackYear).toHaveBeenCalledWith(['B'], spotifyData);
    expect(
      h.prisma.companyListSubmissionTrack.deleteMany
    ).toHaveBeenCalledWith({ where: { companyListSubmissionId: 55 } });
    expect(
      h.prisma.companyListSubmissionTrack.create.mock.calls.map(
        (c: any[]) => c[0]
      )
    ).toEqual([
      { data: { companyListSubmissionId: 55, trackId: 11, position: 1 } },
      { data: { companyListSubmissionId: 55, trackId: 22, position: 2 } },
    ]);
    expect(h.markSpotifyForReload).toHaveBeenCalledWith(9);
  });

  it('deduplicates repeated trackIds before fetching from Spotify', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue({
      numberOfTracks: 5,
      numberOfCards: 5,
      name: 'Summer List',
    });
    h.prisma.track.findFirst.mockResolvedValue({ id: 11 });
    h.getTracksByIds.mockResolvedValue({
      success: true,
      data: [
        {
          trackId: 'A',
          name: 'Song A',
          artist: 'Artist A',
          album: 'x',
          preview: '',
          isrc: '',
          releaseDate: null,
          link: '',
        },
      ],
    });

    await callAsync([
      { companyListId: '9', trackId: 'A', position: 1 },
      { companyListId: '9', trackId: 'A', position: 2 },
    ]);

    expect(h.getTracksByIds).toHaveBeenCalledWith(['A']);
    expect(h.prisma.companyListSubmissionTrack.create).toHaveBeenCalledTimes(1);
  });

  it('drops ALL tracks when numberOfCards is 0 despite logging that all are processed (suspected bug)', async () => {
    // Lines ~352-371: maxTracksToKeep=0 -> slice(0, 0) yields an empty list,
    // contradicting the "Processing all submitted tracks" log message.
    h.prisma.companyList.findUnique.mockResolvedValue({
      numberOfTracks: 0,
      numberOfCards: 0,
      name: 'Broken List',
    });
    await callAsync([{ companyListId: '9', trackId: 'A', position: 1 }]);
    expect(h.getTracksByIds).not.toHaveBeenCalled();
    expect(
      h.prisma.companyListSubmissionTrack.deleteMany
    ).not.toHaveBeenCalled();
  });

  it('leaves existing submission tracks untouched when Spotify lookup fails', async () => {
    h.getTracksByIds.mockResolvedValue({ success: false });
    await callAsync([{ companyListId: '9', trackId: 'A', position: 1 }]);
    expect(
      h.prisma.companyListSubmissionTrack.deleteMany
    ).not.toHaveBeenCalled();
    expect(h.markSpotifyForReload).not.toHaveBeenCalled();
  });
});

describe('Hitlist.processBirthdayTrack', () => {
  const callBirthday = (trackId = 'BD1') =>
    (hitlist as any).processBirthdayTrack(trackId, 55, 9);

  it('links an existing track as birthday track at position 0', async () => {
    h.getTracksByIds.mockResolvedValue({
      success: true,
      data: [
        {
          trackId: 'BD1',
          name: 'Birthday Song',
          artist: 'Party Artist',
          album: 'x',
          preview: '',
          isrc: '',
          releaseDate: '2010-01-01',
          link: '',
        },
      ],
    });
    h.prisma.track.findFirst.mockResolvedValue({ id: 33 });
    h.prisma.companyListSubmissionTrack.create.mockResolvedValue({});

    await callBirthday();

    expect(h.prisma.track.create).not.toHaveBeenCalled();
    expect(h.prisma.companyListSubmissionTrack.create).toHaveBeenCalledWith({
      data: {
        companyListSubmissionId: 55,
        trackId: 33,
        position: 0,
        isBirthdayTrack: true,
      },
    });
    expect(h.markSpotifyForReload).toHaveBeenCalledWith(9);
  });

  it('creates the track when unknown, parsing spotifyYear from the release date', async () => {
    h.getTracksByIds.mockResolvedValue({
      success: true,
      data: [
        {
          trackId: 'BD1',
          name: 'Birthday Song',
          artist: 'Party Artist',
          album: 'Al',
          preview: 'p',
          isrc: 'i',
          releaseDate: '2010-01-01',
          link: 'l',
        },
      ],
    });
    h.prisma.track.findFirst.mockResolvedValue(null);
    h.prisma.track.findUnique.mockResolvedValue(null);
    h.prisma.track.create.mockImplementation(async ({ data }: any) => ({
      id: 44,
      ...data,
    }));
    h.prisma.companyListSubmissionTrack.create.mockResolvedValue({});

    await callBirthday();

    expect(h.prisma.track.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        trackId: 'BD1',
        spotifyYear: 2010,
        manuallyChecked: false,
      }),
    });
    expect(h.prisma.companyListSubmissionTrack.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ trackId: 44, isBirthdayTrack: true }),
    });
  });

  it('does nothing when Spotify cannot resolve the birthday track', async () => {
    h.getTracksByIds.mockResolvedValue({ success: true, data: [] });
    await callBirthday();
    expect(h.prisma.companyListSubmissionTrack.create).not.toHaveBeenCalled();
    expect(h.markSpotifyForReload).not.toHaveBeenCalled();
  });
});

describe('Hitlist.verifySubmission', () => {
  it('returns false for an unknown verification hash', async () => {
    h.prisma.companyListSubmission.findUnique.mockResolvedValue(null);
    expect(await hitlist.verifySubmission('nope')).toBe(false);
    expect(h.prisma.companyListSubmission.update).not.toHaveBeenCalled();
  });

  it('marks the submission verified/submitted and reloads Spotify', async () => {
    h.prisma.companyListSubmission.findUnique.mockResolvedValue({
      id: 70,
      hash: 'subhash',
      companyListId: 9,
    });
    h.prisma.companyListSubmission.update.mockResolvedValue({});

    expect(await hitlist.verifySubmission('VHASH32')).toBe(true);
    expect(h.prisma.companyListSubmission.update).toHaveBeenCalledWith({
      where: { id: 70 },
      data: {
        status: 'submitted',
        verified: true,
        verifiedAt: expect.any(Date),
      },
    });
    expect(h.markSpotifyForReload).toHaveBeenCalledWith(9);
  });

  it('returns false when the update throws', async () => {
    h.prisma.companyListSubmission.findUnique.mockResolvedValue({
      id: 70,
      hash: 'subhash',
      companyListId: 9,
    });
    h.prisma.companyListSubmission.update.mockRejectedValue(new Error('boom'));
    expect(await hitlist.verifySubmission('VHASH32')).toBe(false);
  });
});

describe('Hitlist.getCompanyListByDomain', () => {
  const fullList = {
    ...COMPANY_LIST,
    languages: 'en,nl',
    showNames: true,
    addBirthdayNumber1: false,
    hideBirthdayNumber1: false,
    votingBackground: 'bg.png',
    votingLogo: 'logo.png',
    buttonBackgroundColor: '#fff',
    buttonTextColor: '#000',
    description_en: 'EN desc',
    description_nl: 'NL desc',
  };

  it('builds the list payload, computes votingOpen and caches for 24h', async () => {
    h.prisma.companyList.findFirst.mockResolvedValue({ ...fullList });
    h.prisma.companyListSubmission.findUnique.mockResolvedValue({
      status: 'submitted',
      verified: true,
    });

    const res = await hitlist.getCompanyListByDomain('d', 'hh', 'acme-list');

    // Description fields are selected dynamically per mocked locale list.
    const select = h.prisma.companyList.findFirst.mock.calls[0][0].select;
    expect(select.description_en).toBe(true);
    expect(select.description_nl).toBe(true);

    expect(res.success).toBe(true);
    expect(res.data).toMatchObject({
      id: 9,
      name: 'Summer List',
      description_en: 'EN desc',
      description_nl: 'NL desc',
      companyName: 'ACME',
      numberOfTracks: 3,
      numberOfCards: 2,
      qrvote: true,
      votingOpen: true, // both dates null
      submissionStatus: 'submitted',
    });
    expect(h.cacheSet).toHaveBeenCalledWith(
      'companyListByDomain:acme-list:hh',
      JSON.stringify(res),
      86400
    );
  });

  it('reports votingOpen=false outside the [startAt, endAt] window', async () => {
    h.prisma.companyList.findFirst.mockResolvedValue({
      ...fullList,
      startAt: new Date(Date.now() - 86400_000),
      endAt: new Date(Date.now() - 3600_000),
    });
    const res = await hitlist.getCompanyListByDomain('d', '', 'closed-list');
    expect(res.data.votingOpen).toBe(false);
    // No hash -> the submission lookup is skipped entirely.
    expect(h.prisma.companyListSubmission.findUnique).not.toHaveBeenCalled();
    expect(res.data.submissionStatus).toBe('open');
  });

  it('serves cache hits without querying the list, refreshing submissionStatus for verified submissions', async () => {
    h.cacheStore.set(
      'companyListByDomain:acme-list:hh',
      JSON.stringify({ success: true, data: { submissionStatus: 'open' } })
    );
    h.prisma.companyListSubmission.findUnique.mockResolvedValue({
      status: 'submitted',
      verified: true,
    });

    const res = await hitlist.getCompanyListByDomain('d', 'hh', 'acme-list');
    expect(res.data.submissionStatus).toBe('submitted');
    expect(h.prisma.companyList.findFirst).not.toHaveBeenCalled();
  });

  it('keeps cached status "open" for unverified pending submissions', async () => {
    h.cacheStore.set(
      'companyListByDomain:acme-list:hh',
      JSON.stringify({ success: true, data: { submissionStatus: 'open' } })
    );
    h.prisma.companyListSubmission.findUnique.mockResolvedValue({
      status: 'pending_verification',
      verified: false,
    });
    const res = await hitlist.getCompanyListByDomain('d', 'hh', 'acme-list');
    expect(res.data.submissionStatus).toBe('open');
  });

  it('returns an error when the list does not exist', async () => {
    h.prisma.companyList.findFirst.mockResolvedValue(null);
    const res = await hitlist.getCompanyListByDomain('d', '', 'missing');
    expect(res).toEqual({ success: false, error: 'Company list not found' });
    expect(h.cacheSet).not.toHaveBeenCalled();
  });
});

describe('Hitlist.searchTracks', () => {
  it('rejects search strings shorter than 2 characters', async () => {
    expect(await hitlist.searchTracks('a')).toEqual({
      success: false,
      error: 'Search string too short',
    });
    expect(h.spotifySearchTracks).not.toHaveBeenCalled();
  });

  it('passes the Spotify result straight through', async () => {
    const payload = { success: true, data: { tracks: [{ id: 't' }] } };
    h.spotifySearchTracks.mockResolvedValue(payload);
    expect(await hitlist.searchTracks('queen')).toBe(payload);
    expect(h.spotifySearchTracks).toHaveBeenCalledWith('queen');
  });

  it('passes Spotify failures through unchanged', async () => {
    const failure = { success: false, error: 'rate limited' };
    h.spotifySearchTracks.mockResolvedValue(failure);
    expect(await hitlist.searchTracks('queen')).toBe(failure);
  });
});

describe('Hitlist.searchTracksMusicFetch', () => {
  const ORIGINAL_KEY = process.env['MUSICFETCH_API_KEY'];

  beforeEach(() => {
    process.env['MUSICFETCH_API_KEY'] = 'mf-key';
  });

  afterEach(() => {
    if (ORIGINAL_KEY === undefined) {
      delete process.env['MUSICFETCH_API_KEY'];
    } else {
      process.env['MUSICFETCH_API_KEY'] = ORIGINAL_KEY;
    }
  });

  it('rejects short search strings without calling the API', async () => {
    expect(await hitlist.searchTracksMusicFetch('x')).toEqual({
      success: false,
      error: 'Search string too short',
    });
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('fails when the API key is not configured', async () => {
    delete process.env['MUSICFETCH_API_KEY'];
    expect(await hitlist.searchTracksMusicFetch('queen')).toEqual({
      success: false,
      error: 'MusicFetch API key not configured',
    });
    expect(axiosGet).not.toHaveBeenCalled();
  });

  it('rejects responses without a result body', async () => {
    axiosGet.mockResolvedValue({ data: {} } as any);
    expect(await hitlist.searchTracksMusicFetch('queen')).toEqual({
      success: false,
      error: 'Invalid response from MusicFetch API',
    });
  });

  it('maps tracks to Spotify ids and filters out unusable entries', async () => {
    axiosGet.mockResolvedValue({
      data: {
        result: {
          tracks: [
            {
              link: 'https://open.spotify.com/track/abc123',
              name: 'T1',
              artists: [{ name: 'A1' }],
              image: { url: 'img1' },
            },
            // No /track/ id in the link -> filtered.
            { link: 'https://example.com/x', name: 'T2', artists: [{ name: 'A2' }] },
            // Missing name -> filtered.
            {
              link: 'https://open.spotify.com/track/def456',
              name: '',
              artists: [{ name: 'A3' }],
            },
          ],
        },
      },
    } as any);

    const res = await hitlist.searchTracksMusicFetch('hello world');

    expect(axiosGet).toHaveBeenCalledWith(
      `https://api.musicfetch.io/search?query=${encodeURIComponent(
        'hello world'
      )}&types=track,artist`,
      { headers: { 'x-token': 'mf-key' }, timeout: 10000 }
    );
    expect(res).toEqual({
      success: true,
      data: {
        tracks: [
          {
            id: 'abc123',
            trackId: 'abc123',
            name: 'T1',
            artist: 'A1',
            image: 'img1',
            link: 'https://open.spotify.com/track/abc123',
          },
        ],
        totalCount: 1,
        offset: 0,
        limit: 1,
        hasMore: false,
      },
    });
  });

  it('returns a generic error when the request fails', async () => {
    axiosGet.mockRejectedValue(new Error('timeout'));
    expect(await hitlist.searchTracksMusicFetch('queen')).toEqual({
      success: false,
      error: 'Error searching MusicFetch tracks',
    });
  });
});
