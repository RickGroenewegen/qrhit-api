/**
 * Unit tests for src/business.ts — createCompany.
 *
 * DB is fully mocked (fake prisma vi.fn()s, see ./business-mocks).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { h, resetAll } from './business-mocks';

vi.mock('../../../src/prisma', async () => (await import('./business-mocks')).prismaModule());
vi.mock('../../../src/cache', async () => (await import('./business-mocks')).cacheModule());
vi.mock('../../../src/utils', async () => (await import('./business-mocks')).utilsModule());
vi.mock('../../../src/auth', async () => (await import('./business-mocks')).authModule());
vi.mock('../../../src/mollie', async () => (await import('./business-mocks')).mollieModule());
vi.mock('../../../src/discount', async () => (await import('./business-mocks')).discountModule());
vi.mock('../../../src/data', async () => (await import('./business-mocks')).dataModule());
vi.mock('../../../src/spotify', async () => (await import('./business-mocks')).spotifyModule());
vi.mock('../../../src/generator', async () => (await import('./business-mocks')).generatorModule());
vi.mock('../../../src/translation', async () => (await import('./business-mocks')).translationModule());
vi.mock('../../../src/logger', async () => (await import('./business-mocks')).loggerModule());
vi.mock('sharp', async () => (await import('./business-mocks')).sharpModule());
vi.mock('fs/promises', async () => (await import('./business-mocks')).fsModule());

import Business from '../../../src/business';

const business = Business.getInstance();

beforeEach(() => {
  resetAll();
});

describe('createCompany', () => {
  it('rejects an empty name', async () => {
    const res = await business.createCompany({ name: '   ' });
    expect(res).toMatchObject({ success: false, error: 'Company name cannot be empty' });
  });

  it('rejects duplicates (trimmed name match)', async () => {
    h.prisma.company.findFirst.mockResolvedValue({ id: 1, name: 'Dup' });
    const res = await business.createCompany({ name: '  Dup  ' });
    expect(res).toMatchObject({
      success: false,
      error: 'Company with this name already exists',
    });
    expect(h.prisma.company.findFirst).toHaveBeenCalledWith({
      where: { name: { equals: 'Dup' } },
    });
  });

  it('creates the company with defaults and no contact user when no contactemail', async () => {
    h.prisma.company.findFirst.mockResolvedValue(null);
    h.prisma.company.create.mockResolvedValue({ id: 12, name: 'Solo' });
    const res = await business.createCompany({ name: ' Solo ' });
    expect(res.success).toBe(true);
    expect(res.data.company.id).toBe(12);
    expect(h.prisma.company.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        name: 'Solo',
        followUp: false,
        onlyForAdmin: false,
      }),
    });
    expect(h.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(h.auth.createOrUpdateAdminUser).not.toHaveBeenCalled();
  });

  it('auto-creates a companyadmin contact user for a new contact email', async () => {
    h.prisma.company.findFirst.mockResolvedValue(null);
    h.prisma.company.create.mockResolvedValue({ id: 12, name: 'WithContact' });
    h.prisma.user.findUnique.mockResolvedValue(null);

    const res = await business.createCompany({
      name: 'WithContact',
      contact: ' Jane Doe ',
      contactemail: 'jane@x.test',
      contactphone: ' 0612 ',
    });
    expect(res.success).toBe(true);
    expect(h.auth.createOrUpdateAdminUser).toHaveBeenCalledWith(
      'jane@x.test',
      expect.stringMatching(/^[0-9a-f]{32}$/), // random hex password
      'Jane Doe',
      12,
      'companyadmin',
      undefined,
      undefined,
      '0612'
    );
  });

  it('skips contact user creation when the user already exists', async () => {
    h.prisma.company.findFirst.mockResolvedValue(null);
    h.prisma.company.create.mockResolvedValue({ id: 12, name: 'X' });
    h.prisma.user.findUnique.mockResolvedValue({ id: 4, email: 'jane@x.test' } as any);
    const res = await business.createCompany({ name: 'X', contactemail: 'jane@x.test' });
    expect(res.success).toBe(true);
    expect(h.auth.createOrUpdateAdminUser).not.toHaveBeenCalled();
  });

  it('still succeeds when contact user creation fails', async () => {
    h.prisma.company.findFirst.mockResolvedValue(null);
    h.prisma.company.create.mockResolvedValue({ id: 12, name: 'X' });
    h.prisma.user.findUnique.mockResolvedValue(null);
    h.auth.createOrUpdateAdminUser.mockRejectedValue(new Error('boom'));
    const res = await business.createCompany({ name: 'X', contactemail: 'jane@x.test' });
    expect(res.success).toBe(true);
  });

  it('maps prisma failures to a generic error', async () => {
    h.prisma.company.findFirst.mockResolvedValue(null);
    h.prisma.company.create.mockRejectedValue(new Error('db down'));
    const res = await business.createCompany({ name: 'X' });
    expect(res).toMatchObject({ success: false, error: 'Error creating company' });
  });
});
