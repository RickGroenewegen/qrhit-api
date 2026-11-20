import { describe, it, expect, vi } from 'vitest';

/**
 * The automatic review of submitted playlists (src/promotionalReview.ts):
 * the pure rules, and the orchestration with every dependency injected. The
 * modules it wires up for production are mocked so nothing real loads.
 */

vi.mock('../../../src/prisma', () => ({ default: { getInstance: () => ({}) } }));
vi.mock('../../../src/cache', () => ({ default: { getInstance: () => ({}) } }));
vi.mock('../../../src/promotional', () => ({ default: { getInstance: () => ({}) } }));
vi.mock('../../../src/data', () => ({ default: { getInstance: () => ({}) } }));
vi.mock('../../../src/linkCheck', () => ({ default: { getInstance: () => ({}) } }));
vi.mock('../../../src/pushover', () => ({ default: class {} }));

import {
  MIN_TRACKS_AUTO_APPROVE,
  PromotionalReview,
  ReviewAnswer,
  ReviewDeps,
  decideReview,
  parseAnswer,
  reviewLocales,
  reviewMode,
  reviewNotice,
  reviewSystemPrompt,
  reviewUserMessage,
  sampleTracks,
  taggableLocales,
} from '../../../src/promotionalReview';

const TAGGABLE = ['nl', 'de', 'fr', 'es', 'ru', 'tr', 'pl'];
const answer = (over: Partial<ReviewAnswer> = {}): ReviewAnswer => ({
  verdict: 'approve',
  reason: 'A coherent mix.',
  languages: [],
  ...over,
});
const facts = (over: Record<string, any> = {}) => ({
  trackCount: 200,
  gone: false,
  siteLanguage: 'de',
  ...over,
});

describe('reviewLocales', () => {
  it('international stays null; en is never a tag', () => {
    expect(reviewLocales([], 'de', TAGGABLE)).toBeNull();
    expect(reviewLocales(['en'], 'de', TAGGABLE)).toBeNull();
  });

  it('a language list also gets the language the customer submitted in (where they buy)', () => {
    expect(reviewLocales(['ru'], 'de', TAGGABLE)).toBe('ru,de');
    expect(reviewLocales(['tr'], 'nl', TAGGABLE)).toBe('tr,nl');
    expect(reviewLocales(['de'], 'de', TAGGABLE)).toBe('de');
    // Submitted on the English site: nothing to add.
    expect(reviewLocales(['de'], 'en', TAGGABLE)).toBe('de');
  });

  it('keeps the main language first, drops unknown codes and repeats', () => {
    expect(reviewLocales(['TR', 'de', 'xx', 'tr'], 'nl', TAGGABLE)).toBe('tr,de,nl');
  });

  it('the site\'s own taggable languages are two-letter and leave out en', () => {
    const codes = taggableLocales();
    expect(codes).toContain('ru');
    expect(codes).toContain('tr');
    expect(codes).not.toContain('en');
    expect(codes.every((c) => /^[a-z]{2}$/.test(c))).toBe(true);
  });
});

describe('decideReview', () => {
  it('approves what the model approves', () => {
    expect(decideReview(answer({ languages: ['ru'] }), facts(), TAGGABLE)).toEqual({
      action: 'accept',
      verdict: 'approve',
      reason: 'A coherent mix.',
      featuredLocale: 'ru,de',
    });
  });

  it('declines a playlist gone from its service, whatever the model says (what Rick did by hand)', () => {
    const d = decideReview(answer(), facts({ gone: true, goneReason: 'Not found: 404' }), TAGGABLE);
    expect(d.action).toBe('decline');
    expect(d.reason).toContain('Not found: 404');
  });

  it('never approves a short list without the admin', () => {
    const d = decideReview(answer(), facts({ trackCount: MIN_TRACKS_AUTO_APPROVE - 1 }), TAGGABLE);
    expect(d.action).toBe('leave');
    expect(d.verdict).toBe('review');
  });

  it('a decline on content is the admin\'s: left with the verdict and reason', () => {
    expect(decideReview(answer({ verdict: 'decline', reason: 'Explicit titles.' }), facts(), TAGGABLE)).toEqual({
      action: 'leave',
      verdict: 'decline',
      reason: 'Explicit titles.',
      featuredLocale: null,
    });
    expect(decideReview(answer({ verdict: 'decline' }), facts({ trackCount: 5 }), TAGGABLE).verdict).toBe('decline');
  });

  it('leaves doubt to the admin', () => {
    expect(decideReview(answer({ verdict: 'review' }), facts(), TAGGABLE).action).toBe('leave');
  });
});

describe('parseAnswer', () => {
  it('takes a known verdict and drops what is not a string', () => {
    expect(parseAnswer({ verdict: 'decline', reason: ' Spam ', languages: ['de', 3] })).toEqual({
      verdict: 'decline',
      reason: 'Spam',
      languages: ['de'],
    });
    expect(parseAnswer({ verdict: 'maybe' })).toBeNull();
    expect(parseAnswer(null)).toBeNull();
  });
});

describe('prompt', () => {
  it('spreads a long list over its whole length', () => {
    const list = Array.from({ length: 1000 }, (_, i) => i);
    const sample = sampleTracks(list, 10);
    expect(sample).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800, 900]);
    expect(sampleTracks([1, 2, 3], 10)).toEqual([1, 2, 3]);
  });

  it('shows title, description, site language and songs; the system prompt names the codes', () => {
    const msg = reviewUserMessage({
      title: 'Russische Lieder',
      description: 'Aus allen Jahrzehnten',
      siteLanguage: 'de',
      trackCount: 2,
      tracks: [
        { artist: 'Кино', name: 'Группа крови', year: 1988 },
        { artist: 'Alla Pugacheva', name: 'Million Roses', year: null },
      ],
    });
    expect(msg).toContain('Title: Russische Lieder');
    // The title as it will be published: a competitor's name already replaced.
    expect(
      reviewUserMessage({ title: 'Hitster Joeri', description: '', siteLanguage: 'nl', trackCount: 0, tracks: [] })
    ).toContain('Title: QRSong! Joeri');
    expect(msg).toContain('Submitted on the site in: de');
    expect(msg).toContain('Кино – Группа крови (1988)');
    expect(msg).toContain('Alla Pugacheva – Million Roses\n'.trim());
    expect(reviewSystemPrompt(TAGGABLE)).toContain('Codes: nl, de, fr, es, ru, tr, pl');
  });

  it('a notice says what happened, or what would in suggest mode', () => {
    const d = decideReview(answer({ languages: ['tr'] }), facts(), TAGGABLE);
    expect(reviewNotice('Türkisch Pop', 200, d, 'apply')).toEqual({
      title: 'Submitted playlist approved',
      message: 'Türkisch Pop (200 songs, tr,de): A coherent mix.',
    });
    expect(reviewNotice('Türkisch Pop', 200, d, 'suggest').title).toBe('Submitted playlist would approve');
  });

  it('the switch: unset applies in production only; a value wins anywhere', () => {
    expect(reviewMode(undefined, 'production')).toBe('apply');
    expect(reviewMode(undefined, 'development')).toBe('off');
    expect(reviewMode('nonsense', 'development')).toBe('off');
    expect(reviewMode(' Suggest ', 'development')).toBe('suggest');
    expect(reviewMode('apply', 'development')).toBe('apply');
    expect(reviewMode('off', 'production')).toBe('off');
  });
});

describe('PromotionalReview', () => {
  const waiting = {
    id: 7,
    playlistId: 'sp-7',
    serviceType: 'spotify',
    name: 'raw name',
    promotionalTitle: 'Russische Lieder',
    promotionalDescription: 'Aus allen Jahrzehnten',
    promotionalLocale: 'de',
    promotionalActive: true,
    promotionalAccepted: false,
    promotionalHide: false,
    promotionalReviewedAt: null,
    featuredLocale: null,
  };
  const tracks = Array.from({ length: 30 }, (_, i) => ({ artist: `A${i}`, name: `S${i}`, year: 1980 + i }));

  function setup(over: Partial<ReviewDeps> = {}, row: any = waiting) {
    const update = vi.fn(async () => ({}));
    const deps: ReviewDeps = {
      prisma: {
        playlist: { findUnique: vi.fn(async () => row), update, findMany: vi.fn(async () => []) },
        $queryRaw: vi.fn(async () => tracks),
      },
      cache: { acquireLock: vi.fn(async () => true), releaseLock: vi.fn(async () => {}) },
      logger: { log: vi.fn() },
      ask: vi.fn(async () => answer({ languages: ['ru'] })),
      probe: vi.fn(async () => ({ verdict: 'available' as const, reason: 'ok' })),
      accept: vi.fn(async () => ({ success: true })),
      decline: vi.fn(async () => ({ success: true })),
      notify: vi.fn(async () => {}),
      mode: () => 'apply',
      ...over,
    };
    return { deps, update, review: new PromotionalReview(deps) };
  }

  it('approves: stores the verdict and languages first, then approves (which mails the customer)', async () => {
    const { deps, update, review } = setup();
    const out = await review.review('sp-7');
    expect(out?.done).toBe('accepted');
    expect(update).toHaveBeenCalledWith({
      where: { playlistId: 'sp-7' },
      data: expect.objectContaining({
        promotionalReviewVerdict: 'approve',
        featuredLocale: 'ru,de',
        promotionalReviewedAt: expect.any(Date),
      }),
    });
    expect(deps.accept).toHaveBeenCalledWith('sp-7');
    expect(deps.decline).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith({
      title: 'Submitted playlist approved',
      message: 'Russische Lieder (30 songs, ru,de): A coherent mix.',
    });
    expect(deps.cache.releaseLock).toHaveBeenCalled();
  });

  it('declines a playlist the service says is gone, without asking the model', async () => {
    const { deps, review } = setup({
      probe: vi.fn(async () => ({ verdict: 'gone' as const, reason: 'Not found: 404' })),
    });
    const out = await review.review('sp-7');
    expect(out?.done).toBe('declined');
    expect(deps.ask).not.toHaveBeenCalled();
    expect(deps.decline).toHaveBeenCalledWith('sp-7');
  });

  it('a refusal that could be our own access (needsControl) is not gone', async () => {
    const { deps, review } = setup({
      probe: vi.fn(async () => ({ verdict: 'gone' as const, reason: 'Private?', needsControl: true })),
    });
    expect((await review.review('sp-7'))?.done).toBe('accepted');
    expect(deps.ask).toHaveBeenCalled();
  });

  it('suggest mode stores the verdict and languages but approves nothing', async () => {
    const { deps, update, review } = setup({ mode: () => 'suggest' });
    const out = await review.review('sp-7');
    expect(out?.done).toBe('suggested');
    expect(update).toHaveBeenCalled();
    expect(deps.accept).not.toHaveBeenCalled();
  });

  it('leaves it to the admin when the model gives no usable answer, stored so the sweep does not ask again', async () => {
    const { deps, update, review } = setup({ ask: vi.fn(async () => null) });
    const out = await review.review('sp-7');
    expect(out?.done).toBe('skipped');
    expect(update).toHaveBeenCalledWith({
      where: { playlistId: 'sp-7' },
      data: {
        promotionalReviewVerdict: 'review',
        promotionalReviewReason: 'The model gave no usable answer.',
        promotionalReviewedAt: expect.any(Date),
      },
    });
    expect(deps.accept).not.toHaveBeenCalled();
    expect(deps.decline).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith(expect.objectContaining({ title: 'Submitted playlist needs you' }));
  });

  it('an outage throws, stores nothing and is tried again by the next sweep', async () => {
    const { deps, update, review } = setup({ ask: vi.fn(async () => { throw new Error('overloaded'); }) });
    await expect(review.review('sp-7')).rejects.toThrow('overloaded');
    expect(update).not.toHaveBeenCalled();
    expect(deps.cache.releaseLock).toHaveBeenCalled();
  });

  it('does nothing for a submission already decided or reviewed, or while another review runs', async () => {
    expect(await setup({}, { ...waiting, promotionalAccepted: true }).review.review('sp-7')).toBeNull();
    expect(await setup({}, { ...waiting, promotionalHide: true }).review.review('sp-7')).toBeNull();
    expect(await setup({}, { ...waiting, promotionalReviewedAt: new Date() }).review.review('sp-7')).toBeNull();
    const locked = setup({ cache: { acquireLock: vi.fn(async () => false), releaseLock: vi.fn(async () => {}) } });
    expect(await locked.review.review('sp-7')).toBeNull();
    expect(locked.deps.ask).not.toHaveBeenCalled();
    // `force` reviews one that was reviewed before.
    const again = setup({}, { ...waiting, promotionalReviewedAt: new Date() });
    expect((await again.review.review('sp-7', { force: true }))?.done).toBe('accepted');
  });

  it('off does nothing at all', async () => {
    const { deps, review } = setup({ mode: () => 'off' });
    expect(await review.review('sp-7')).toBeNull();
    expect(await review.sweep()).toEqual([]);
    expect(deps.prisma.playlist.findUnique).not.toHaveBeenCalled();
  });

  it('the sweep takes waiting submissions never reviewed, saved a few minutes ago', async () => {
    const { deps, review } = setup();
    deps.prisma.playlist.findMany = vi.fn(async () => [{ playlistId: 'sp-7' }]);
    const out = await review.sweep();
    expect(out.map((o) => o.done)).toEqual(['accepted']);
    const where = (deps.prisma.playlist.findMany as any).mock.calls[0][0].where;
    expect(where).toMatchObject({
      promotionalActive: true,
      promotionalAccepted: false,
      promotionalHide: false,
      promotionalReviewedAt: null,
    });
    expect(where.updatedAt.lt).toBeInstanceOf(Date);
  });
});
