/**
 * Shared mock holder + vi.mock module factories for the src/vibe.ts unit
 * suites. The RDS test database is unavailable, so src/prisma is replaced
 * with a configurable fake (vi.fn per model method) and every collaborator
 * with I/O (cache, spotify, generator, mollie, discount, fs, sharp, ...)
 * is stubbed at the module boundary. Mail/Pushover stay on the global
 * recording proxies from test/setup.ts.
 *
 * Each test file registers the mocks itself (vi.mock is hoisted per test
 * file) by delegating to the *Module() factories exported here, e.g.:
 *
 *   vi.mock('../../../src/prisma', async () =>
 *     (await import('./vibe-mocks')).prismaModule()
 *   );
 */
import { vi } from 'vitest';

function model(...methods: string[]): Record<string, ReturnType<typeof vi.fn>> {
  const m: Record<string, ReturnType<typeof vi.fn>> = {};
  for (const name of methods) m[name] = vi.fn();
  return m;
}

export const h = {
  prisma: {
    company: model('findUnique', 'findFirst', 'findMany', 'create', 'update', 'delete'),
    user: model('findUnique', 'findMany', 'create', 'update'),
    userGroup: model('findUnique', 'create'),
    userInGroup: model('findFirst', 'create'),
    companyList: model(
      'findUnique',
      'findFirst',
      'findMany',
      'create',
      'update',
      'updateMany',
      'delete'
    ),
    companyListSubmission: model('findUnique', 'findMany', 'update', 'delete'),
    companyListSubmissionTrack: model('findMany', 'updateMany'),
    companyListQuestion: model('findMany'),
    track: model('findMany'),
    trackExtraInfo: model('create'),
    playlist: model('findUnique', 'update', 'delete'),
    playlistHasTrack: model('count'),
    payment: model('delete'),
    companyEvent: model('findMany', 'findFirst', 'create', 'update', 'delete'),
    quotation: model('create', 'findUnique'),
  } as Record<string, Record<string, ReturnType<typeof vi.fn>>>,

  utils: {
    verifyRecaptcha: vi.fn(),
    isSpam: vi.fn(),
    parseBoolean: vi.fn(),
    generateRandomString: vi.fn(),
  },

  auth: {
    generateSalt: vi.fn(),
    hashPassword: vi.fn(),
    createOrUpdateAdminUser: vi.fn(),
  },

  mollie: { getPaymentUri: vi.fn(), getPayment: vi.fn() },
  discount: { createDiscountCode: vi.fn() },
  spotify: { createOrUpdatePlaylist: vi.fn() },
  generator: { queueGenerate: vi.fn() },

  cacheStore: new Map<string, string>(),
  cacheDel: vi.fn(),

  // fs/promises stubs (only used by files that mock 'fs/promises')
  fs: {
    mkdir: vi.fn(),
    writeFile: vi.fn(),
    readFile: vi.fn(),
    copyFile: vi.fn(),
    access: vi.fn(),
    unlink: vi.fn(),
  },

  // sharp chainable stub
  sharpCalls: [] as any[],
  sharpComposite: vi.fn(),
  sharpToBuffer: vi.fn(),

  loggerLog: vi.fn(),
};

export const TEST_LOCALES = ['en', 'nl', 'de'];

/** Reset every vi.fn above and restore sensible defaults. */
export function resetAll(): void {
  for (const methods of Object.values(h.prisma)) {
    for (const fn of Object.values(methods)) fn.mockReset();
  }
  for (const group of [h.utils, h.auth, h.mollie, h.discount, h.spotify, h.generator, h.fs]) {
    for (const fn of Object.values(group)) (fn as any).mockReset();
  }
  h.cacheDel.mockReset();
  h.cacheStore.clear();
  h.sharpCalls.length = 0;
  h.sharpComposite.mockReset();
  h.sharpToBuffer.mockReset();
  h.loggerLog.mockReset();

  // Defaults mirroring the real implementations closely enough for vibe.ts
  h.utils.verifyRecaptcha.mockResolvedValue({ isHuman: true, score: 0.9 });
  h.utils.isSpam.mockReturnValue({ isSpam: false, reason: null });
  h.utils.parseBoolean.mockImplementation((value: any) => {
    if (value === null || value === undefined) return false;
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value !== 0;
    if (typeof value === 'string') {
      return ['true', '1', 'yes', 'y', 'on'].includes(value.trim().toLowerCase());
    }
    return false;
  });
  h.utils.generateRandomString.mockReturnValue('RANDOM32');
  h.auth.generateSalt.mockReturnValue('salt-1');
  h.auth.hashPassword.mockReturnValue('hash-1');
  h.auth.createOrUpdateAdminUser.mockResolvedValue(undefined);
  h.sharpToBuffer.mockResolvedValue(Buffer.from('processed-png'));
}

// ---------------------------------------------------------------------------
// vi.mock module factories
// ---------------------------------------------------------------------------

export function prismaModule() {
  return { default: { getInstance: () => h.prisma } };
}

export function cacheModule() {
  return {
    default: {
      getInstance: () => ({
        get: async (key: string) => h.cacheStore.get(key) ?? null,
        set: async (key: string, value: string) => {
          h.cacheStore.set(key, value);
        },
        del: async (key: string) => {
          h.cacheDel(key);
          h.cacheStore.delete(key);
        },
      }),
    },
  };
}

export function utilsModule() {
  return {
    default: class {
      verifyRecaptcha = h.utils.verifyRecaptcha;
      isSpam = h.utils.isSpam;
      parseBoolean = h.utils.parseBoolean;
      generateRandomString = h.utils.generateRandomString;
    },
  };
}

export function authModule() {
  return {
    generateSalt: h.auth.generateSalt,
    hashPassword: h.auth.hashPassword,
    createOrUpdateAdminUser: h.auth.createOrUpdateAdminUser,
  };
}

export function mollieModule() {
  return {
    default: class {
      getPaymentUri = h.mollie.getPaymentUri;
      getPayment = h.mollie.getPayment;
    },
  };
}

export function discountModule() {
  return {
    default: class {
      createDiscountCode = h.discount.createDiscountCode;
    },
  };
}

export function dataModule() {
  return { default: { getInstance: () => ({}) } };
}

export function spotifyModule() {
  return {
    default: {
      getInstance: () => ({ createOrUpdatePlaylist: h.spotify.createOrUpdatePlaylist }),
    },
  };
}

export function generatorModule() {
  return {
    default: { getInstance: () => ({ queueGenerate: h.generator.queueGenerate }) },
  };
}

export function translationModule() {
  return {
    default: class {
      allLocales = TEST_LOCALES;
    },
  };
}

export function loggerModule() {
  return {
    default: class {
      log = h.loggerLog;
    },
  };
}

export function fsModule() {
  return {
    default: h.fs,
    ...h.fs,
  };
}

export function sharpModule() {
  const sharpFn = (input: any) => {
    h.sharpCalls.push(input);
    const chain: any = {
      resize: (...args: any[]) => chain,
      composite: (...args: any[]) => {
        h.sharpComposite(...args);
        return chain;
      },
      png: () => chain,
      toBuffer: h.sharpToBuffer,
    };
    return chain;
  };
  return { default: sharpFn };
}
