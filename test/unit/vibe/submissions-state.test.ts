/**
 * Unit tests for src/vibe.ts — submission CRUD, getUsersByCompany,
 * getState and company events. Fake prisma throughout (DB down).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, resetAll, TEST_LOCALES } from './vibe-mocks';

vi.mock('../../../src/prisma', async () => (await import('./vibe-mocks')).prismaModule());
vi.mock('../../../src/cache', async () => (await import('./vibe-mocks')).cacheModule());
vi.mock('../../../src/utils', async () => (await import('./vibe-mocks')).utilsModule());
vi.mock('../../../src/auth', async () => (await import('./vibe-mocks')).authModule());
vi.mock('../../../src/mollie', async () => (await import('./vibe-mocks')).mollieModule());
vi.mock('../../../src/discount', async () => (await import('./vibe-mocks')).discountModule());
vi.mock('../../../src/data', async () => (await import('./vibe-mocks')).dataModule());
vi.mock('../../../src/spotify', async () => (await import('./vibe-mocks')).spotifyModule());
vi.mock('../../../src/generator', async () => (await import('./vibe-mocks')).generatorModule());
vi.mock('../../../src/translation', async () => (await import('./vibe-mocks')).translationModule());
vi.mock('../../../src/logger', async () => (await import('./vibe-mocks')).loggerModule());
vi.mock('sharp', async () => (await import('./vibe-mocks')).sharpModule());
vi.mock('fs/promises', async () => (await import('./vibe-mocks')).fsModule());

import Vibe from '../../../src/vibe';

const vibe = Vibe.getInstance();

beforeEach(() => {
  resetAll();
});

describe('getUsersByCompany', () => {
  it('rejects an invalid company id', async () => {
    expect(await vibe.getUsersByCompany(NaN)).toMatchObject({
      success: false,
      error: 'Invalid company ID provided',
    });
    expect(await vibe.getUsersByCompany(0)).toMatchObject({ success: false });
    expect(h.prisma.company.findUnique).not.toHaveBeenCalled();
  });

  it('returns an error when the company does not exist', async () => {
    h.prisma.company.findUnique.mockResolvedValue(null);
    expect(await vibe.getUsersByCompany(3)).toMatchObject({
      success: false,
      error: 'Company not found',
    });
  });

  it('returns users sorted by displayName plus the company test flag', async () => {
    h.prisma.company.findUnique.mockResolvedValue({ id: 3, test: true });
    const users = [{ id: 1, email: 'a@b.c' }];
    h.prisma.user.findMany.mockResolvedValue(users);
    const res = await vibe.getUsersByCompany(3);
    expect(res).toEqual({ success: true, users, test: true });
    expect(h.prisma.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 3 },
        orderBy: { displayName: 'asc' },
      })
    );
  });

  it('maps prisma errors to a friendly error', async () => {
    h.prisma.company.findUnique.mockRejectedValue(new Error('boom'));
    expect(await vibe.getUsersByCompany(3)).toMatchObject({
      success: false,
      error: 'Error retrieving users for company',
    });
  });
});

describe('replaceTrackInSubmissions', () => {
  it('validates all three ids', async () => {
    expect(await vibe.replaceTrackInSubmissions(NaN, 1, 2)).toMatchObject({
      success: false,
      error: 'Invalid parameters provided',
    });
    expect(await vibe.replaceTrackInSubmissions(1, 0, 2)).toMatchObject({
      success: false,
    });
    expect(await vibe.replaceTrackInSubmissions(1, 2, NaN)).toMatchObject({
      success: false,
    });
  });

  it('moves votes between tracks and marks the list for Spotify reload', async () => {
    h.prisma.companyListSubmissionTrack.updateMany.mockResolvedValue({ count: 4 });
    h.prisma.companyList.update.mockResolvedValue({});
    const res = await vibe.replaceTrackInSubmissions(10, 100, 200);
    expect(res).toEqual({ success: true, updatedCount: 4 });
    expect(h.prisma.companyListSubmissionTrack.updateMany).toHaveBeenCalledWith({
      where: {
        trackId: 100,
        CompanyListSubmission: { companyListId: 10 },
      },
      data: { trackId: 200 },
    });
    expect(h.prisma.companyList.update).toHaveBeenCalledWith({
      where: { id: 10 },
      data: { spotifyRefreshRequired: true },
    });
  });

  it('maps prisma errors to a friendly error', async () => {
    h.prisma.companyListSubmissionTrack.updateMany.mockRejectedValue(new Error('x'));
    expect(await vibe.replaceTrackInSubmissions(10, 100, 200)).toMatchObject({
      success: false,
      error: 'Error replacing track in submissions',
    });
  });
});

describe('deleteSubmission', () => {
  it('validates the id', async () => {
    expect(await vibe.deleteSubmission(NaN)).toMatchObject({
      success: false,
      error: 'Invalid submission ID provided',
    });
  });

  it('returns not-found when the submission does not exist', async () => {
    h.prisma.companyListSubmission.findUnique.mockResolvedValue(null);
    expect(await vibe.deleteSubmission(8)).toMatchObject({
      success: false,
      error: 'Submission not found',
    });
    expect(h.prisma.companyListSubmission.delete).not.toHaveBeenCalled();
  });

  it('deletes and triggers a Spotify reload on the parent list', async () => {
    h.prisma.companyListSubmission.findUnique.mockResolvedValue({
      id: 8,
      companyListId: 33,
    });
    h.prisma.companyListSubmission.delete.mockResolvedValue({});
    h.prisma.companyList.update.mockResolvedValue({});
    expect(await vibe.deleteSubmission(8)).toEqual({ success: true });
    expect(h.prisma.companyListSubmission.delete).toHaveBeenCalledWith({
      where: { id: 8 },
    });
    expect(h.prisma.companyList.update).toHaveBeenCalledWith({
      where: { id: 33 },
      data: { spotifyRefreshRequired: true },
    });
  });

  it('maps prisma errors', async () => {
    h.prisma.companyListSubmission.findUnique.mockRejectedValue(new Error('x'));
    expect(await vibe.deleteSubmission(8)).toMatchObject({
      success: false,
      error: 'Error deleting submission',
    });
  });
});

describe('submissionBelongsToCompany', () => {
  it('returns false for invalid ids without querying', async () => {
    expect(await vibe.submissionBelongsToCompany(NaN, 1)).toBe(false);
    expect(await vibe.submissionBelongsToCompany(1, 0)).toBe(false);
    expect(h.prisma.companyListSubmission.findUnique).not.toHaveBeenCalled();
  });

  it('returns false when the submission or its list is missing', async () => {
    h.prisma.companyListSubmission.findUnique.mockResolvedValueOnce(null);
    expect(await vibe.submissionBelongsToCompany(1, 2)).toBe(false);
    h.prisma.companyListSubmission.findUnique.mockResolvedValueOnce({
      id: 1,
      CompanyList: null,
    });
    expect(await vibe.submissionBelongsToCompany(1, 2)).toBe(false);
  });

  it('compares the owning companyId', async () => {
    h.prisma.companyListSubmission.findUnique.mockResolvedValue({
      id: 1,
      CompanyList: { companyId: 2 },
    });
    expect(await vibe.submissionBelongsToCompany(1, 2)).toBe(true);
    expect(await vibe.submissionBelongsToCompany(1, 3)).toBe(false);
  });
});

describe('updateSubmission', () => {
  it('validates id and cardName', async () => {
    expect(await vibe.updateSubmission(NaN, { cardName: 'x' })).toMatchObject({
      success: false,
      error: 'Invalid submission ID provided',
    });
    expect(await vibe.updateSubmission(1, { cardName: '   ' })).toMatchObject({
      success: false,
      error: 'cardName is required and must be a non-empty string',
    });
    expect(await vibe.updateSubmission(1, { cardName: 5 as any })).toMatchObject({
      success: false,
    });
  });

  it('returns not-found for a missing submission', async () => {
    h.prisma.companyListSubmission.findUnique.mockResolvedValue(null);
    expect(await vibe.updateSubmission(1, { cardName: 'New' })).toMatchObject({
      success: false,
      error: 'Submission not found',
    });
  });

  it('updates the cardName and marks the list for reload', async () => {
    h.prisma.companyListSubmission.findUnique.mockResolvedValue({
      id: 1,
      companyListId: 44,
    });
    const updated = { id: 1, cardName: 'New' };
    h.prisma.companyListSubmission.update.mockResolvedValue(updated);
    h.prisma.companyList.update.mockResolvedValue({});
    const res = await vibe.updateSubmission(1, { cardName: 'New' });
    expect(res).toEqual({ success: true, data: updated });
    expect(h.prisma.companyListSubmission.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { cardName: 'New' },
    });
    expect(h.prisma.companyList.update).toHaveBeenCalledWith({
      where: { id: 44 },
      data: { spotifyRefreshRequired: true },
    });
  });

  it('maps prisma errors', async () => {
    h.prisma.companyListSubmission.findUnique.mockRejectedValue(new Error('x'));
    expect(await vibe.updateSubmission(1, { cardName: 'New' })).toMatchObject({
      success: false,
      error: 'Error updating submission',
    });
  });
});

describe('verifySubmission', () => {
  it('validates the id', async () => {
    expect(await vibe.verifySubmission(0)).toMatchObject({
      success: false,
      error: 'Invalid submission ID provided',
    });
  });

  it('returns not-found for a missing submission', async () => {
    h.prisma.companyListSubmission.findUnique.mockResolvedValue(null);
    expect(await vibe.verifySubmission(9)).toMatchObject({
      success: false,
      error: 'Submission not found',
    });
  });

  it('marks the submission verified+submitted and triggers a reload', async () => {
    h.prisma.companyListSubmission.findUnique.mockResolvedValue({
      id: 9,
      companyListId: 12,
    });
    const updated = { id: 9, verified: true };
    h.prisma.companyListSubmission.update.mockResolvedValue(updated);
    h.prisma.companyList.update.mockResolvedValue({});

    const res = await vibe.verifySubmission(9);
    expect(res).toEqual({ success: true, data: updated });

    const updateArgs = h.prisma.companyListSubmission.update.mock.calls[0][0];
    expect(updateArgs.where).toEqual({ id: 9 });
    expect(updateArgs.data.verified).toBe(true);
    expect(updateArgs.data.status).toBe('submitted');
    expect(updateArgs.data.verifiedAt).toBeInstanceOf(Date);
    expect(h.prisma.companyList.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: { spotifyRefreshRequired: true },
    });
  });
});

describe('getState', () => {
  it('returns an empty state when no listId is given', async () => {
    const res = await vibe.getState();
    expect(res.success).toBe(true);
    expect(res.data).toEqual({
      questions: [],
      list: null,
      ranking: [],
      availableLocales: TEST_LOCALES,
      submissions: [],
    });
    expect(h.prisma.companyList.findUnique).not.toHaveBeenCalled();
  });

  it('returns an error when the list does not exist', async () => {
    h.prisma.companyList.findUnique.mockResolvedValue(null);
    expect(await vibe.getState(5)).toMatchObject({
      success: false,
      error: 'Company list not found',
    });
  });

  it('assembles questions, submissions and locale descriptions', async () => {
    const stateList: any = {
      id: 5,
      name: 'List',
      slug: 'list',
      languages: ' nl, en,,de ',
      numberOfTracks: 0, // makes getRanking fail -> ranking stays []
      numberOfCards: 10,
    };
    // Two different findUnique shapes: the state select (has slug) and the
    // ranking select (numberOfTracks only).
    h.prisma.companyList.findUnique.mockImplementation(async ({ select }: any) =>
      select?.slug
        ? stateList
        : { id: 5, name: 'List', numberOfTracks: 0, numberOfCards: 10 }
    );
    h.prisma.companyListQuestion.findMany.mockResolvedValue([
      {
        id: 1,
        question: 'Fav genre?',
        CompanyListQuestionOptions: [{ id: 9, label: 'Rock' }],
      },
    ]);
    h.prisma.companyListSubmission.findMany.mockResolvedValue([
      {
        id: 70,
        firstname: 'A',
        _count: { CompanyListSubmissionTrack: 3 },
      },
      { id: 71, firstname: 'B', _count: undefined },
    ]);

    const res = await vibe.getState(5);
    expect(res.success).toBe(true);

    // Select includes the per-locale description columns
    const selectArg = h.prisma.companyList.findUnique.mock.calls[0][0].select;
    for (const locale of TEST_LOCALES) {
      expect(selectArg[`description_${locale}`]).toBe(true);
    }

    // Questions: options renamed
    expect(res.data.questions).toHaveLength(1);
    expect(res.data.questions[0].options).toEqual([{ id: 9, label: 'Rock' }]);
    expect(res.data.questions[0].CompanyListQuestionOptions).toBeUndefined();

    // Languages parsed into a trimmed array
    expect(res.data.list.languages).toEqual(['nl', 'en', 'de']);

    // Ranking failed (numberOfTracks 0) -> empty, not an error
    expect(res.data.ranking).toEqual([]);

    // Submissions: _count flattened into voteCount
    expect(res.data.submissions).toEqual([
      expect.objectContaining({ id: 70, voteCount: 3 }),
      expect.objectContaining({ id: 71, voteCount: 0 }),
    ]);
    expect(res.data.submissions[0]._count).toBeUndefined();
  });

  it('defaults languages to an empty array when unset', async () => {
    h.prisma.companyList.findUnique.mockImplementation(async ({ select }: any) =>
      select?.slug
        ? { id: 5, name: 'L', slug: 'l', languages: null }
        : { id: 5, name: 'L', numberOfTracks: 0, numberOfCards: 10 }
    );
    h.prisma.companyListQuestion.findMany.mockResolvedValue([]);
    h.prisma.companyListSubmission.findMany.mockResolvedValue([]);
    const res = await vibe.getState(5);
    expect(res.success).toBe(true);
    expect(res.data.list.languages).toEqual([]);
  });

  it('maps prisma errors to a friendly error', async () => {
    h.prisma.companyList.findUnique.mockRejectedValue(new Error('x'));
    expect(await vibe.getState(5)).toMatchObject({
      success: false,
      error: 'Error retrieving company state',
    });
  });
});

describe('company events', () => {
  it('getCompanyEvents returns events with their author', async () => {
    const events = [{ id: 1, content: 'hi', User: { id: 2 } }];
    h.prisma.companyEvent.findMany.mockResolvedValue(events);
    expect(await vibe.getCompanyEvents(7)).toEqual({ success: true, data: events });
    expect(h.prisma.companyEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { companyId: 7 },
        orderBy: { createdAt: 'desc' },
      })
    );
  });

  it('getCompanyEvents maps errors', async () => {
    h.prisma.companyEvent.findMany.mockRejectedValue(new Error('x'));
    expect(await vibe.getCompanyEvents(7)).toMatchObject({
      success: false,
      error: 'Failed to get company events',
    });
  });

  it('createCompanyEvent stores a comment with optional attachment', async () => {
    const created = { id: 3, content: 'note' };
    h.prisma.companyEvent.create.mockResolvedValue(created);
    const res = await vibe.createCompanyEvent(7, 2, 'note', '/a.png');
    expect(res).toEqual({ success: true, data: created });
    expect(h.prisma.companyEvent.create.mock.calls[0][0].data).toEqual({
      companyId: 7,
      userId: 2,
      type: 'comment',
      content: 'note',
      attachmentUrl: '/a.png',
    });
  });

  it('updateCompanyEvent refuses events outside the company and trims content', async () => {
    h.prisma.companyEvent.findFirst.mockResolvedValueOnce(null);
    expect(await vibe.updateCompanyEvent(7, 3, 'x')).toMatchObject({
      success: false,
      error: 'Event not found',
    });

    h.prisma.companyEvent.findFirst.mockResolvedValueOnce({ id: 3 });
    const updated = { id: 3, content: 'trimmed' };
    h.prisma.companyEvent.update.mockResolvedValue(updated);
    const res = await vibe.updateCompanyEvent(7, 3, '  trimmed  ');
    expect(res).toEqual({ success: true, data: updated });
    expect(h.prisma.companyEvent.update.mock.calls[0][0].data).toEqual({
      content: 'trimmed',
    });
    expect(h.prisma.companyEvent.findFirst).toHaveBeenCalledWith({
      where: { id: 3, companyId: 7 },
    });
  });

  it('deleteCompanyEvent removes the attachment file first (errors ignored)', async () => {
    h.prisma.companyEvent.findFirst.mockResolvedValue({
      id: 3,
      attachmentUrl: '/companydata/att.png',
    });
    h.fs.unlink.mockRejectedValue(new Error('ENOENT'));
    h.prisma.companyEvent.delete.mockResolvedValue({});
    expect(await vibe.deleteCompanyEvent(7, 3)).toEqual({ success: true });
    expect(h.fs.unlink).toHaveBeenCalledWith(
      `${process.env['PUBLIC_DIR']}/companydata/att.png`
    );
    expect(h.prisma.companyEvent.delete).toHaveBeenCalledWith({ where: { id: 3 } });
  });

  it('deleteCompanyEvent skips unlink when there is no attachment', async () => {
    h.prisma.companyEvent.findFirst.mockResolvedValue({ id: 3, attachmentUrl: null });
    h.prisma.companyEvent.delete.mockResolvedValue({});
    expect(await vibe.deleteCompanyEvent(7, 3)).toEqual({ success: true });
    expect(h.fs.unlink).not.toHaveBeenCalled();
  });

  it('deleteCompanyEvent returns not-found for foreign events', async () => {
    h.prisma.companyEvent.findFirst.mockResolvedValue(null);
    expect(await vibe.deleteCompanyEvent(7, 3)).toMatchObject({
      success: false,
      error: 'Event not found',
    });
  });
});
