/**
 * Shared fake-deps harness for the Generator unit suites.
 *
 * Generator is a singleton wired to a dozen other singletons at
 * construction time, so every dependency lives here as a stable object of
 * vi.fn()s that the test files hand to vi.mock() factories. The objects
 * themselves never change identity; `resetGeneratorMocks()` re-arms default
 * implementations between tests.
 *
 * NOTE: this file is NOT a test file (no .test.ts suffix) — vitest only
 * loads it through the suites in this directory.
 */
import { vi } from 'vitest';

export const h = {
  prisma: {
    payment: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    userSuggestion: {
      count: vi.fn(),
    },
    paymentHasPlaylist: {
      update: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
    },
    paymentHasPlaylistItem: {
      findMany: vi.fn(),
      createMany: vi.fn(),
      update: vi.fn(),
    },
    playlistHasTrack: {
      count: vi.fn(),
    },
    playlist: {
      update: vi.fn(),
    },
  },
  data: {
    getUserByUserId: vi.fn(),
    getPlaylistsByPaymentId: vi.fn(),
    getTracks: vi.fn(),
    areAllTracksManuallyChecked: vi.fn(),
    storeTracks: vi.fn(),
    resetJudgedStatus: vi.fn(),
  },
  provider: {
    getTracks: vi.fn(),
    getStorefrontForLocale: vi.fn(),
  },
  getProvider: vi.fn(),
  utils: {
    isMainServer: vi.fn(async () => false),
    createDir: vi.fn(async () => undefined),
  },
  qr: {
    generateQR: vi.fn(),
    generateQRLambda: vi.fn(),
  },
  pdf: {
    generatePDF: vi.fn(),
    generateGiftcardPDF: vi.fn(),
    countPDFPages: vi.fn(),
    generateFromUrl: vi.fn(),
    addBleed: vi.fn(),
  },
  order: {
    createInvoice: vi.fn(),
    createOrder: vi.fn(),
    orderInlayCard: vi.fn(),
  },
  analytics: {
    increaseCounter: vi.fn(),
  },
  discount: {
    createDiscountCode: vi.fn(),
  },
  cache: {
    acquireLock: vi.fn(),
    releaseLock: vi.fn(),
  },
  queue: {
    addGenerateJob: vi.fn(),
  },
  appleStorefront: {
    setStorefront: vi.fn(),
  },
  finalCheck: {
    runCheck: vi.fn(),
  },
  suggestion: {
    checkIfReadyForPrinter: vi.fn(),
  },
  musicfetch: {
    processPlaylistTracks: vi.fn(),
  },
  /** Constructor args of every CronJob created through the mocked 'cron'. */
  cronJobs: [] as any[][],
};

/** Re-arm every fake with its default behavior. Call from beforeEach. */
export function resetGeneratorMocks(): void {
  for (const model of Object.values(h.prisma)) {
    for (const fn of Object.values(model)) (fn as any).mockReset();
  }
  for (const group of [
    h.data,
    h.provider,
    h.utils,
    h.qr,
    h.pdf,
    h.order,
    h.analytics,
    h.discount,
    h.cache,
    h.queue,
    h.appleStorefront,
    h.finalCheck,
    h.suggestion,
    h.musicfetch,
  ]) {
    for (const fn of Object.values(group)) (fn as any).mockReset();
  }
  h.getProvider.mockReset();

  // prisma defaults
  h.prisma.payment.findMany.mockResolvedValue([]);
  h.prisma.payment.findFirst.mockResolvedValue(null);
  h.prisma.payment.update.mockResolvedValue({});
  h.prisma.userSuggestion.count.mockResolvedValue(0);
  h.prisma.paymentHasPlaylist.update.mockResolvedValue({});
  h.prisma.paymentHasPlaylist.findFirst.mockResolvedValue(null);
  h.prisma.paymentHasPlaylist.findUnique.mockResolvedValue(null);
  h.prisma.paymentHasPlaylistItem.findMany.mockResolvedValue([]);
  h.prisma.paymentHasPlaylistItem.createMany.mockResolvedValue({ count: 0 });
  h.prisma.paymentHasPlaylistItem.update.mockResolvedValue({});
  h.prisma.playlistHasTrack.count.mockResolvedValue(0);
  h.prisma.playlist.update.mockResolvedValue({});

  // data defaults
  h.data.getUserByUserId.mockResolvedValue({ userId: 'u1' });
  h.data.getPlaylistsByPaymentId.mockResolvedValue([]);
  h.data.getTracks.mockResolvedValue([]);
  h.data.areAllTracksManuallyChecked.mockResolvedValue(false);
  h.data.storeTracks.mockResolvedValue(undefined);
  h.data.resetJudgedStatus.mockResolvedValue(undefined);

  // music provider defaults
  h.getProvider.mockReturnValue(h.provider);
  h.provider.getTracks.mockResolvedValue({ success: true, data: { tracks: [] } });
  h.provider.getStorefrontForLocale.mockReturnValue('us');

  // misc service defaults
  h.utils.isMainServer.mockResolvedValue(false);
  h.utils.createDir.mockResolvedValue(undefined);
  h.qr.generateQR.mockResolvedValue(undefined);
  h.qr.generateQRLambda.mockResolvedValue(undefined);
  h.pdf.generatePDF.mockImplementation(async (filename: string) => filename);
  h.pdf.generateGiftcardPDF.mockImplementation(
    async (filename: string) => filename
  );
  h.pdf.countPDFPages.mockResolvedValue(0);
  h.pdf.generateFromUrl.mockResolvedValue(undefined);
  h.pdf.addBleed.mockResolvedValue(undefined);
  h.order.createInvoice.mockResolvedValue('/tmp/invoice-42.pdf');
  h.order.createOrder.mockResolvedValue({
    success: true,
    request: { items: 1 },
    response: { id: 'printapi-1' },
  });
  h.order.orderInlayCard.mockResolvedValue({
    success: true,
    request: { inlay: true },
    response: { id: 'inlay-1' },
  });
  h.analytics.increaseCounter.mockReturnValue(undefined);
  h.discount.createDiscountCode.mockResolvedValue({
    code: 'GIFT123',
    amount: 50,
  });
  h.cache.acquireLock.mockResolvedValue(true);
  h.cache.releaseLock.mockResolvedValue(undefined);
  h.queue.addGenerateJob.mockResolvedValue('job-77');
  h.appleStorefront.setStorefront.mockReturnValue(undefined);
  h.finalCheck.runCheck.mockResolvedValue({ ok: true });
  h.suggestion.checkIfReadyForPrinter.mockResolvedValue(undefined);
  h.musicfetch.processPlaylistTracks.mockResolvedValue(undefined);

  h.cronJobs.length = 0;

  // Keep the MusicFetch fire-and-forget branch quiet unless a test opts in.
  delete process.env['MUSICFETCH_API_KEY'];
  process.env['ENVIRONMENT'] = 'test';
}

// Arm defaults at load so Generator's constructor (setCron -> isMainServer)
// finds working fakes the moment the module under test is imported.
resetGeneratorMocks();

export function makePayment(over: Record<string, any> = {}): any {
  return {
    id: 11,
    paymentId: 'pay_1',
    userId: 7,
    isBusinessOrder: false,
    fullname: 'Rick Tester',
    email: 'rick@example.test',
    countrycode: 'NL',
    locale: 'en',
    profit: 5,
    totalPrice: 25,
    shipping: 0,
    vibe: false,
    finalized: false,
    qrSubDir: 'qsub',
    canBeSentToPrinter: true,
    sentToPrinter: false,
    printerHold: false,
    PaymentHasPlaylist: [{}],
    user: { hash: 'userhash' },
    ...over,
  };
}

export function makePlaylist(over: Record<string, any> = {}): any {
  return {
    id: 21,
    playlistId: 'pl1',
    paymentHasPlaylistId: 31,
    name: 'My List',
    orderType: 'digital',
    productType: 'cards',
    serviceType: 'spotify',
    numberOfTracks: 2,
    paymentHasPlaylistNumberOfTracks: 2,
    amount: 1,
    eco: 0,
    doubleSided: 0,
    template: null,
    printerType: 'printnbind',
    subType: 'none',
    boxEnabled: false,
    boxQuantity: 0,
    gamesEnabled: false,
    addHowToCard: false,
    ...over,
  };
}

/** Fake Mollie instance for the methods Generator actually calls. */
export function makeMollie(payment: any): any {
  return {
    checkPaymentStatus: vi.fn(async () => ({
      success: true,
      data: { payment: { user: { userId: 'u1' } } },
    })),
    getPayment: vi.fn(async () => payment),
    clearPDFs: vi.fn(async () => undefined),
  };
}

export const dbTracksFixture = [
  { id: 1, trackId: 't1', paymentHasPlaylistId: 31 },
  { id: 2, trackId: 't2', paymentHasPlaylistId: 31 },
];
