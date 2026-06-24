/**
 * Unit tests for src/mail.ts (the REAL module — the global recording mock
 * from test/setup.ts is removed via vi.unmock below).
 *
 * Outbound transports are mocked at the module boundary:
 *  - @aws-sdk/client-ses  → SESClient.send captured (raw MIME inspected)
 *  - openai               → chat.completions.create stubbed
 *  - axios                → Mail Octopus uploads stubbed
 *  - ../../src/prisma     → in-memory prisma stub (no DB)
 *  - ../../src/utils      → captcha/spam/trust/main-server stubs
 *  - cron                 → constructor recorded (no real timers)
 * Pushover stays on the global recording proxy (asserted via `outbound`).
 * Templates (Handlebars) and locale files are the real ones from src/.
 */
import {
  describe,
  it,
  expect,
  vi,
  beforeAll,
  beforeEach,
  afterEach,
} from 'vitest';
import fs from 'fs';
import path from 'path';
import { outbound } from '../helpers/recording-mock';

vi.unmock('../../src/mail');

// ---------------------------------------------------------------------------
// Module-boundary mocks (hoisted)
// ---------------------------------------------------------------------------
const sesSend = vi.hoisted(() => vi.fn(async () => ({ MessageId: 'msg-1' })));
vi.mock('@aws-sdk/client-ses', () => {
  class SendRawEmailCommand {
    constructor(public input: any) {}
  }
  class SESClient {
    send = sesSend;
  }
  return { SESClient, SendRawEmailCommand };
});

const prismaMock = vi.hoisted(() => ({
  contactEmail: { create: vi.fn(), update: vi.fn() },
  user: {
    findUnique: vi.fn(),
    findMany: vi.fn(),
    findFirst: vi.fn(),
    update: vi.fn(),
    updateMany: vi.fn(),
    create: vi.fn(),
  },
  payment: { findFirst: vi.fn(), update: vi.fn() },
  paymentHasPlaylist: { findUnique: vi.fn() },
}));
vi.mock('../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

const utilsMock = vi.hoisted(() => ({
  isMainServer: vi.fn(async () => false),
  verifyRecaptcha: vi.fn(async () => ({ isHuman: true, score: 0.9 })),
  isSpam: vi.fn(() => ({ isSpam: false, reason: null })),
  isTrustedEmail: vi.fn(() => false),
}));
vi.mock('../../src/utils', () => ({
  default: class {
    isMainServer = utilsMock.isMainServer;
    verifyRecaptcha = utilsMock.verifyRecaptcha;
    isSpam = utilsMock.isSpam;
    isTrustedEmail = utilsMock.isTrustedEmail;
  },
}));

const openaiCreate = vi.hoisted(() => vi.fn());
vi.mock('openai', () => ({
  default: class {
    chat = { completions: { create: openaiCreate } };
    constructor(_opts: any) {}
  },
}));

const chatMock = vi.hoisted(() => ({
  getTopics: vi.fn(async () => ['shipping']),
  processToolsForContext: vi.fn(async () => ({
    toolContext: '',
    knowledgeContext: '',
  })),
}));
vi.mock('../../src/chat', () => ({
  ChatService: class {
    getTopics = chatMock.getTopics;
    processToolsForContext = chatMock.processToolsForContext;
  },
}));

const cronCtor = vi.hoisted(() => vi.fn());
vi.mock('cron', () => ({ CronJob: cronCtor }));

vi.mock('axios');
import axios from 'axios';
const axiosPut = vi.mocked(axios.put);

import Mail from '../../src/mail';

// ---------------------------------------------------------------------------
// Fixtures / helpers
// ---------------------------------------------------------------------------
const ASSETS = process.env['ASSETS_DIR']!;
const PUBLIC = process.env['PUBLIC_DIR']!;
const BOGUS_ASSETS = path.join(PUBLIC, 'does-not-exist-assets');

function lastRaw(): string {
  const call = sesSend.mock.calls.at(-1)! as any[];
  return Buffer.from(call[0].input.RawMessage.Data).toString('utf-8');
}

function makePayment(overrides: Record<string, any> = {}): any {
  return {
    id: 1,
    paymentId: 'pay_123',
    orderId: 'QR123456',
    email: 'buyer@example.com',
    fullname: 'Jane Buyer',
    locale: 'en',
    userId: 7,
    address: 'Mainstreet',
    housenumber: '1',
    city: 'Amsterdam',
    zipcode: '1234AB',
    countrycode: 'nl',
    invoiceAddress: null,
    invoiceHousenumber: null,
    invoiceCity: null,
    invoiceZipcode: null,
    invoiceCountrycode: null,
    differentInvoiceAddress: false,
    createdAt: new Date('2026-01-15T10:00:00Z'),
    user: { hash: 'userhash123' },
    ...overrides,
  };
}

function makePlaylist(overrides: Record<string, any> = {}): any {
  return {
    playlistId: 'pl_abc',
    name: 'Road Trip Hits',
    numberOfTracks: 42,
    featured: false,
    boxEnabled: false,
    boxQuantity: 0,
    tracks: [],
    ...overrides,
  };
}

let mail: Mail;

beforeAll(() => {
  // Deterministic env for headers/links (read at call time by mail.ts).
  process.env['PRODUCT_NAME'] = 'QRSong!';
  process.env['FROM_EMAIL'] = 'noreply@qrsong.io';
  process.env['INFO_EMAIL'] = 'info@qrsong.io';
  process.env['REPLY_TO_EMAIL'] = 'reply@qrsong.io';
  process.env['UNSUBSCRIBE_EMAIL'] = 'unsubscribe@qrsong.io';
  process.env['FRONTEND_VOTING_URI'] = 'http://localhost:4300';
  process.env['BCC_EMAIL'] = '';
  delete process.env['BUSINESS_CONTACT_EMAIL'];
  delete process.env['MAIL_OCTOPUS_LIST_ID'];
  delete process.env['MAIL_OCTOPUS_API_KEY'];

  // Fixture files in the scratch dirs (created by test/setup.ts).
  fs.mkdirSync(path.join(ASSETS, 'images'), { recursive: true });
  fs.writeFileSync(path.join(ASSETS, 'images', 'logo.png'), 'fake-logo-png');
  fs.writeFileSync(
    path.join(ASSETS, 'images', 'onzevibe_logo.png'),
    'fake-onzevibe-logo'
  );
  fs.mkdirSync(path.join(PUBLIC, 'pdf'), { recursive: true });
  fs.writeFileSync(path.join(PUBLIC, 'pdf', 'voucher-digital.pdf'), 'pdf-d');
  fs.writeFileSync(path.join(PUBLIC, 'pdf', 'voucher-printer.pdf'), 'pdf-p');
  fs.writeFileSync(path.join(PUBLIC, 'invoice-test.pdf'), 'pdf-invoice');

  mail = Mail.getInstance();
});

beforeEach(() => {
  sesSend.mockClear();
  openaiCreate.mockReset();
  axiosPut.mockReset();
  outbound.reset();
  for (const model of Object.values(prismaMock)) {
    for (const fn of Object.values(model)) (fn as any).mockReset();
  }
  utilsMock.verifyRecaptcha.mockResolvedValue({ isHuman: true, score: 0.9 });
  utilsMock.isSpam.mockReturnValue({ isSpam: false, reason: null });
  utilsMock.isTrustedEmail.mockReturnValue(false);
});

afterEach(() => {
  process.env['ASSETS_DIR'] = ASSETS;
  process.env['BCC_EMAIL'] = '';
  delete process.env['BUSINESS_CONTACT_EMAIL'];
  delete process.env['MAIL_OCTOPUS_LIST_ID'];
  delete process.env['MAIL_OCTOPUS_API_KEY'];
});

// ---------------------------------------------------------------------------
// Sanity: we are testing the real module, not the recording proxy
// ---------------------------------------------------------------------------
describe('module identity', () => {
  it('loads the real Mail implementation (not the global recording proxy)', async () => {
    expect(Mail.getInstance()).toBe(mail);
    const raw = await mail.renderRaw({
      from: 'A <a@x.io>',
      to: 'b@x.io',
      subject: 'Hi',
      html: '<p>Hi</p>',
      text: 'Hi',
      attachments: [],
      unsubscribe: 'u@x.io',
    });
    // The recording proxy resolves every call to undefined; the real
    // implementation returns a MIME string.
    expect(typeof raw).toBe('string');
    expect(raw).toContain('boundary="MixedBoundaryString"');
    expect(outbound.calls('Mail')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// renderRaw
// ---------------------------------------------------------------------------
describe('renderRaw', () => {
  const base = {
    from: 'QRSong! <noreply@qrsong.io>',
    to: 'user@example.com',
    subject: 'Test subject',
    html: '<b>html-body</b>',
    text: 'text-body',
    unsubscribe: 'unsubscribe@qrsong.io',
  };

  it('builds a multipart MIME message with text + html alternatives', async () => {
    const raw = await mail.renderRaw({ ...base, attachments: [] });
    expect(raw).toContain('From: QRSong! <noreply@qrsong.io>');
    expect(raw).toContain('To: user@example.com');
    expect(raw).toContain('Subject: Test subject');
    expect(raw).toContain('List-Unsubscribe: <unsubscribe@qrsong.io>');
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(raw).toContain('Content-Type: text/html; charset="UTF-8"');
    expect(raw).toContain('text-body');
    expect(raw).toContain('<b>html-body</b>');
    expect(raw).not.toContain('Bcc:');
    expect(raw).not.toContain('Reply-To:');
  });

  it('adds Reply-To, BCC (outside development) and renders both attachment dispositions', async () => {
    process.env['BCC_EMAIL'] = 'archive@qrsong.io';
    const raw = await mail.renderRaw({
      ...base,
      replyTo: 'reply@qrsong.io',
      attachments: [
        {
          contentType: 'image/png',
          filename: 'logo.png',
          data: 'AAAA',
          isInline: true,
          cid: 'logo',
        },
        { contentType: 'application/pdf', filename: 'file.pdf', data: 'BBBB' },
      ],
    });
    expect(raw).toContain('Bcc: archive@qrsong.io');
    expect(raw).toContain('Reply-To: reply@qrsong.io');
    expect(raw).toContain(
      'Content-Disposition: inline; filename="logo.png"\nContent-ID: <logo>'
    );
    expect(raw).toContain(
      'Content-Disposition: attachment; filename="file.pdf"'
    );
    expect(raw).toContain('Content-Type: application/pdf');
  });

  it('omits the BCC header when sendBCC is false', async () => {
    process.env['BCC_EMAIL'] = 'archive@qrsong.io';
    const raw = await mail.renderRaw({ ...base, attachments: [] }, false);
    expect(raw).not.toContain('Bcc:');
  });
});

// ---------------------------------------------------------------------------
// Simple transactional mails (logo attachment + locale translations)
// ---------------------------------------------------------------------------
describe('account & verification mails', () => {
  it('sendPasswordResetMail sends the reset link with the en subject', async () => {
    await mail.sendPasswordResetMail('user@example.com', 'John', 'tok-123');
    expect(sesSend).toHaveBeenCalledTimes(1);
    const raw = lastRaw();
    expect(raw).toContain('To: user@example.com');
    expect(raw).toContain('Subject: Reset Your Password');
    expect(raw).toContain('Reply-To: reply@qrsong.io');
    expect(raw).toContain(
      'http://localhost:4200/en/account/reset-password/tok-123'
    );
    // Inline logo got swapped to the CID reference
    expect(raw).toContain('<img src="cid:logo"');
    expect(raw).not.toContain('Bcc:');
  });

  it('sendPasswordResetMail falls back to the email local-part when fullname is empty', async () => {
    await mail.sendPasswordResetMail('jdoe@example.com', '', 'tok-1', 'en');
    expect(lastRaw()).toContain('jdoe');
  });

  it('sendPasswordResetMail swallows errors (missing logo) without sending', async () => {
    process.env['ASSETS_DIR'] = BOGUS_ASSETS;
    await expect(
      mail.sendPasswordResetMail('user@example.com', 'John', 'tok-123')
    ).resolves.toBeUndefined();
    expect(sesSend).not.toHaveBeenCalled();
  });

  it('sendQRSongVerificationMail sends the verification link', async () => {
    await mail.sendQRSongVerificationMail(
      'new@example.com',
      'Newbie',
      'verhash',
      'en'
    );
    const raw = lastRaw();
    expect(raw).toContain('To: new@example.com');
    expect(raw).toContain('Subject: Verify Your QRSong Account');
    expect(raw).toContain('http://localhost:4200/en/account/verify/verhash');
  });

  it('sendCustomerRegistrationPincode includes the pincode', async () => {
    await mail.sendCustomerRegistrationPincode(
      'pin@example.com',
      'Pin User',
      '654321',
      'en'
    );
    const raw = lastRaw();
    expect(raw).toContain('Subject: Your QRSong! Verification Code');
    expect(raw).toContain('654321');
    expect(raw).toContain('To: pin@example.com');
  });

  it('sendForgotPasswordPincode includes the pincode and subject', async () => {
    await mail.sendForgotPasswordPincode(
      'forgot@example.com',
      'Forgetful',
      '111222',
      'en'
    );
    const raw = lastRaw();
    expect(raw).toContain('Subject: Reset your QRSong! password');
    expect(raw).toContain('111222');
  });

  it('sendQRSongActivationMail includes deep link and activation code', async () => {
    await mail.sendQRSongActivationMail(
      'act@example.com',
      'Activator',
      'hash-9',
      'en',
      '424242'
    );
    const raw = lastRaw();
    expect(raw).toContain('Subject: Your QRGames! Activation Code');
    expect(raw).toContain('424242');
  });

  it('sendVerificationEmail (qrvote brand) uses the qrsong logo and brand suffix', async () => {
    await mail.sendVerificationEmail(
      'vote@example.com',
      'Voter',
      'ACME',
      'vhash',
      'en',
      'acme-list',
      true
    );
    const raw = lastRaw();
    expect(raw).toContain('From: QRSong! <noreply@qrsong.io>');
    expect(raw).toContain(
      'Subject: Verify Your Hitlist Submission - QRSong!'
    );
    expect(raw).toContain(
      'http://localhost:4300/hitlist/acme-list/verify/vhash'
    );
    expect(raw).toContain('filename="qrsong_logo.png"');
  });

  it('sendVerificationEmail (OnzeVibe brand) uses the onzevibe logo', async () => {
    await mail.sendVerificationEmail(
      'vote2@example.com',
      'Voter2',
      'ACME',
      'vhash2',
      'en',
      'acme-list',
      false
    );
    const raw = lastRaw();
    expect(raw).toContain('From: OnzeVibe <noreply@qrsong.io>');
    expect(raw).toContain('- OnzeVibe');
    expect(raw).toContain('filename="onzevibe_logo.png"');
  });

  it('sendQRVoteWelcomeEmail sends a fixed subject with the verify url', async () => {
    await mail.sendQRVoteWelcomeEmail(
      'w@example.com',
      'Wendy',
      'ACME Corp',
      'en',
      'vw-hash'
    );
    const raw = lastRaw();
    expect(raw).toContain('Subject: Welcome to QRVote!');
    expect(raw).toContain('ACME Corp');
    expect(raw).toContain('http://localhost:4200/en/account/verify/vw-hash');
  });

  it('sendPortalWelcomeEmail sends credentials from the OnzeVibe sender', async () => {
    await mail.sendPortalWelcomeEmail(
      'p@example.com',
      'Piet',
      'ACME',
      'https://portal.example.com',
      'piet-user',
      's3cret',
      'nl',
      'https://admin.example.com'
    );
    const raw = lastRaw();
    expect(raw).toContain('From: OnzeVibe <noreply@qrsong.io>');
    expect(raw).toContain('Subject: Welkom bij je OnzeVibe portal!');
    expect(raw).toContain('piet-user');
    expect(raw).toContain('s3cret');
    expect(raw).toContain('https://portal.example.com');
    expect(raw).toContain('filename="onzevibe_logo.png"');
  });

  it('sendDesignAlterMail (hitster) sends from the info address with the brand reason', async () => {
    await mail.sendDesignAlterMail(
      'designer@example.com',
      'Des',
      'en',
      'pay_1',
      'uhash',
      'pl_1',
      'hitster'
    );
    const raw = lastRaw();
    expect(raw).toContain('From: QRSong! <info@qrsong.io>');
    expect(raw).toContain('Reply-To: info@qrsong.io');
    expect(raw).toContain(
      'Subject: Action required: please update your card design'
    );
    expect(raw).toContain('third-party brand');
    expect(raw).toContain(
      'http://localhost:4200/en/usersuggestions/pay_1/uhash/pl_1/0'
    );
  });

  it('sendDesignAlterMail (hitster) attaches each flagged page inline and lists its name', async () => {
    await mail.sendDesignAlterMail(
      'designer@example.com',
      'Des',
      'en',
      'pay_1',
      'uhash',
      'pl_1',
      'hitster',
      [
        {
          key: 'cardFront',
          filename: 'card-front.png',
          buffer: Buffer.from('cardfront-png'),
        },
        {
          key: 'boxFront',
          filename: 'box-front.png',
          buffer: Buffer.from('boxfront-png'),
        },
      ]
    );
    const raw = lastRaw();
    // Intro + per-image labels rendered in the HTML body
    expect(raw).toContain('triggered this');
    expect(raw).toContain('Card front');
    expect(raw).toContain('Box inlay (front)');
    // Both flagged pages referenced inline and attached with matching cids
    expect(raw).toContain('src="cid:flag0"');
    expect(raw).toContain('src="cid:flag1"');
    expect(raw).toContain('Content-ID: <flag0>');
    expect(raw).toContain('Content-ID: <flag1>');
    expect(raw).toContain('filename="card-front.png"');
    expect(raw).toContain('filename="box-front.png"');
  });

  it('sendDesignAlterMail (hitster) without flagged images omits the image block', async () => {
    await mail.sendDesignAlterMail(
      'designer@example.com',
      'Des',
      'en',
      'pay_1',
      'uhash',
      'pl_1',
      'hitster'
    );
    const raw = lastRaw();
    expect(raw).not.toContain('triggered this');
    expect(raw).not.toContain('Content-ID: <flag0>');
    // The generic reason text is still present
    expect(raw).toContain('third-party brand');
  });

  it('sendDesignAlterMail (inappropriate) uses the inappropriate reason', async () => {
    await mail.sendDesignAlterMail(
      'designer@example.com',
      'Des',
      'en',
      'pay_1',
      'uhash',
      'pl_1',
      'inappropriate'
    );
    const raw = lastRaw();
    expect(raw).not.toContain('third-party brand');
    expect(raw).toContain('Subject: Action required');
  });
});

// ---------------------------------------------------------------------------
// Order mails (sendEmail) — order types, subjects and attachments
// ---------------------------------------------------------------------------
describe('sendEmail (order confirmation)', () => {
  it('digital order: playlist subject, download links, no physical link for untrusted email', async () => {
    await mail.sendEmail('digital', makePayment(), [makePlaylist()]);
    expect(sesSend).toHaveBeenCalledTimes(1);
    const raw = lastRaw();
    expect(raw).toContain("Subject: Here is your PDF for 'Road Trip Hits'!");
    expect(raw).toContain('To: buyer@example.com');
    expect(raw).toContain(
      'http://localhost:3004/download/pay_123/userhash123/pl_abc/digital'
    );
    // only the inline logo, no pdf attachments
    expect(raw).not.toContain('filename="voucher.pdf"');
    expect(raw).not.toContain('filename="invoice.pdf"');
  });

  it('digital order for a trusted email exposes the physical (printer) link', async () => {
    utilsMock.isTrustedEmail.mockReturnValue(true);
    await mail.sendEmail(
      'digital',
      makePayment(),
      [makePlaylist()],
      'printer-file.pdf'
    );
    const raw = lastRaw();
    expect(raw).toContain(
      'http://localhost:3004/download/pay_123/userhash123/pl_abc/printer'
    );
  });

  it('physical order with one playlist uses the order-received subject and address block', async () => {
    await mail.sendEmail(
      'main_physical',
      makePayment(),
      [makePlaylist()],
      '',
      '',
      path.join(PUBLIC, 'invoice-test.pdf')
    );
    const raw = lastRaw();
    expect(raw).toContain('Subject: We have received order QR123456!');
    expect(raw).toContain('Mainstreet');
    expect(raw).toContain('Amsterdam');
    expect(raw).toContain('filename="invoice.pdf"');
  });

  it('physical order with multiple playlists sums the track counts', async () => {
    await mail.sendEmail('main_physical', makePayment(), [
      makePlaylist(),
      makePlaylist({ playlistId: 'pl_2', name: 'Second', numberOfTracks: 8 }),
    ]);
    const raw = lastRaw();
    expect(raw).toContain('Subject: We have received order QR123456!');
    expect(raw).toContain('50'); // 42 + 8 tracks
  });

  it('voucher_digital attaches the voucher PDF', async () => {
    await mail.sendEmail(
      'voucher_digital',
      makePayment(),
      [makePlaylist()],
      '',
      'voucher-digital.pdf'
    );
    const raw = lastRaw();
    expect(raw).toContain('Subject: Here is your gift voucher!');
    expect(raw).toContain('filename="voucher.pdf"');
    expect(raw).not.toContain('filename="voucher_printer.pdf"');
  });

  it('voucher_physical for a trusted email also attaches the printer voucher', async () => {
    utilsMock.isTrustedEmail.mockReturnValue(true);
    await mail.sendEmail(
      'voucher_physical',
      makePayment(),
      [makePlaylist()],
      'voucher-printer.pdf',
      'voucher-digital.pdf'
    );
    const raw = lastRaw();
    expect(raw).toContain('Subject: Thank you for ordering a gift voucher!');
    expect(raw).toContain('filename="voucher.pdf"');
    expect(raw).toContain('filename="voucher_printer.pdf"');
  });

  it('swallows template/file errors without sending', async () => {
    process.env['ASSETS_DIR'] = BOGUS_ASSETS;
    await expect(
      mail.sendEmail('digital', makePayment(), [makePlaylist()])
    ).resolves.toBeUndefined();
    expect(sesSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Lifecycle mails around an order
// ---------------------------------------------------------------------------
describe('order lifecycle mails', () => {
  it('sendTrackingEmail includes tracking link and invoice attachment', async () => {
    await mail.sendTrackingEmail(
      makePayment(),
      'https://track.example.com/T123',
      path.join(PUBLIC, 'invoice-test.pdf')
    );
    const raw = lastRaw();
    expect(raw).toContain(
      'Subject: Your QRSong! order QR123456 has been shipped!'
    );
    expect(raw).toContain('https://track.example.com/T123');
    expect(raw).toContain('filename="invoice.pdf"');
  });

  it('sendTrackingEmail without invoice only attaches the logo', async () => {
    await mail.sendTrackingEmail(makePayment(), 'https://t.example.com', '');
    const raw = lastRaw();
    expect(raw).not.toContain('filename="invoice.pdf"');
    expect(raw).toContain('filename="logo.png"');
  });

  it('sendBoxInstructionsEmail links the folding video and gift-box page', async () => {
    await mail.sendBoxInstructionsEmail(makePayment());
    const raw = lastRaw();
    expect(raw).toContain("Subject: Your gift box: here's how to fold it!");
    // Handlebars escapes "=" as &#x3D; inside {{ }} interpolations
    expect(raw).toContain('https://www.youtube.com/watch?v&#x3D;OE3DsOM81Qo');
    expect(raw).toContain('https://img.youtube.com/vi/OE3DsOM81Qo');
    expect(raw).toContain('http://localhost:4200/en/gift-box');
  });

  it('sendFinalizedMail invites a review with the playlist subject', async () => {
    await mail.sendFinalizedMail(
      makePayment(),
      'http://localhost:4200/en/review/pay_123',
      makePlaylist()
    );
    const raw = lastRaw();
    expect(raw).toContain(
      "Subject: We invite you to review playlist 'Road Trip Hits'"
    );
    expect(raw).toContain('http://localhost:4200/en/review/pay_123');
    expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(0);
  });

  it('sendFinalizedMail notifies pushover when sending fails', async () => {
    process.env['ASSETS_DIR'] = BOGUS_ASSETS;
    await mail.sendFinalizedMail(
      makePayment(),
      'http://x.example.com',
      makePlaylist()
    );
    expect(sesSend).not.toHaveBeenCalled();
    const calls = outbound.calls('PushoverClient', 'sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].title).toBe('Finalized mail failed');
    expect(calls[0].args[0].message).toContain('QR123456');
    expect(calls[0].args[0].message).toContain('buyer@example.com');
  });

  it('sendToPrinterMail interpolates the playlist into the printing notice', async () => {
    await mail.sendToPrinterMail(makePayment(), makePlaylist());
    const raw = lastRaw();
    expect(raw).toContain(
      "Subject: Your playlist 'Road Trip Hits' is scheduled for production!"
    );
    expect(raw).toContain('are scheduled for production');
    expect(raw).toContain(
      'http://localhost:3004/download/pay_123/userhash123/pl_abc/digital'
    );
  });

  it('sendReviewEmail sends review links and flags reviewMailSent', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ hash: 'uhash-77' });
    prismaMock.payment.update.mockResolvedValue({});
    await mail.sendReviewEmail(makePayment());
    const raw = lastRaw();
    expect(raw).toContain(
      'Subject: Happy with your QRSong! purchase? Leave a review!'
    );
    expect(raw).toContain('https://www.trustpilot.com/evaluate/qrsong.io');
    expect(raw).toContain('http://localhost:4200/en/unsubscribe/uhash-77');
    expect(prismaMock.payment.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { reviewMailSent: true },
    });
  });

  it('sendBoxUpgradeConfirmationEmail renders prices from the paymentHasPlaylist row', async () => {
    prismaMock.paymentHasPlaylist.findUnique.mockResolvedValue({
      id: 5,
      payment: makePayment(),
      playlist: makePlaylist(),
    });
    await mail.sendBoxUpgradeConfirmationEmail(5, 6.99, 3.5, 2);
    expect(prismaMock.paymentHasPlaylist.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 5 } })
    );
    const raw = lastRaw();
    expect(raw).toContain(
      "Subject: Your Gift Box for 'Road Trip Hits' is on its way!"
    );
    expect(raw).toContain('6.99');
    expect(raw).toContain('3.50');
    expect(raw).toContain('10.49');
  });

  it('sendBoxUpgradeConfirmationEmail does nothing when the row is missing', async () => {
    prismaMock.paymentHasPlaylist.findUnique.mockResolvedValue(null);
    await mail.sendBoxUpgradeConfirmationEmail(999);
    expect(sesSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Promotional mails
// ---------------------------------------------------------------------------
describe('promotional mails', () => {
  it('sendPromotionalSaleEmail credits the creator and includes the discount code', async () => {
    await mail.sendPromotionalSaleEmail(
      'creator@example.com',
      'Creator',
      'Road Trip Hits',
      2.5,
      7.5,
      'PROMO-CODE-1',
      'https://qrsong.io/share/pl_abc',
      'https://qrsong.io/setup/pl_abc',
      'en',
      3
    );
    const raw = lastRaw();
    expect(raw).toContain('To: creator@example.com');
    expect(raw).toContain('Subject: Someone bought your featured playlist!');
    expect(raw).toContain('PROMO-CODE-1');
    expect(raw).toContain('2.50');
    expect(raw).toContain('7.50');
  });

  it('sendPromotionalApprovedEmail includes social share links built from the en share text', async () => {
    await mail.sendPromotionalApprovedEmail(
      'creator@example.com',
      'Creator',
      'Road Trip Hits',
      'PROMO-CODE-2',
      'https://qrsong.io/share/pl_abc',
      'https://qrsong.io/setup/pl_abc',
      'en'
    );
    const raw = lastRaw();
    expect(raw).toContain('Subject: Your playlist is now live!');
    expect(raw).toContain('PROMO-CODE-2');
    // Handlebars escapes "=" as &#x3D; inside {{ }} interpolations
    expect(raw).toContain('https://wa.me/?text');
    expect(raw).toContain('https://www.facebook.com/sharer/sharer.php?u');
    expect(raw).toContain(
      encodeURIComponent('I created QR Music Quiz cards')
    );
  });
});

// ---------------------------------------------------------------------------
// Custom mail + AI translation helper
// ---------------------------------------------------------------------------
describe('sendCustomMail / translateToLocale', () => {
  it('sendCustomMail converts newlines for html and keeps them in text', async () => {
    await mail.sendCustomMail(
      'cust@example.com',
      'Cust',
      'A custom subject',
      'line one\nline two',
      'en'
    );
    const raw = lastRaw();
    expect(raw).toContain('From: QRSong! <info@qrsong.io>');
    expect(raw).toContain('Subject: A custom subject');
    expect(raw).toContain('line one<br>line two');
    expect(raw).toContain('line one\nline two');
    expect(raw).toContain('Hello'); // en greeting
  });

  it('translateToLocale returns the model output', async () => {
    openaiCreate.mockResolvedValue({
      choices: [{ message: { content: 'Bonjour le monde' } }],
    });
    const out = await mail.translateToLocale('Hallo wereld', 'fr');
    expect(out).toBe('Bonjour le monde');
    expect(openaiCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            role: 'system',
            content: expect.stringContaining('French'),
          }),
        ]),
      })
    );
  });

  it('translateToLocale falls back to the original content on error', async () => {
    openaiCreate.mockRejectedValue(new Error('api down'));
    const out = await mail.translateToLocale('Hallo wereld', 'de');
    expect(out).toBe('Hallo wereld');
  });
});

// ---------------------------------------------------------------------------
// Contact form
// ---------------------------------------------------------------------------
describe('sendContactForm', () => {
  const formData = {
    captchaToken: 'tok',
    honeypot: '',
    name: 'John Doe',
    email: 'john@example.com',
    subject: 'Where is my order?',
    message: 'Hi, where is my order QR123?',
    inquiryType: 'private',
  };

  function stubOpenAiContactCalls() {
    openaiCreate.mockImplementation(async (req: any) => {
      if (req.functions) {
        return {
          choices: [
            {
              message: {
                function_call: {
                  arguments: JSON.stringify({
                    detectedLocale: 'en',
                    dutchTranslation: 'Hoi, waar is mijn bestelling QR123?',
                  }),
                },
              },
            },
          ],
        };
      }
      return { choices: [{ message: { content: 'Beste John, ...' } }] };
    });
  }

  it('rejects when reCAPTCHA fails', async () => {
    utilsMock.verifyRecaptcha.mockResolvedValue({ isHuman: false, score: 0.1 });
    const res = await mail.sendContactForm(formData, '1.2.3.4');
    expect(res).toEqual({
      success: false,
      error: 'reCAPTCHA verification failed',
    });
    expect(prismaMock.contactEmail.create).not.toHaveBeenCalled();
    expect(sesSend).not.toHaveBeenCalled();
  });

  it('rejects messages classified as spam', async () => {
    utilsMock.isSpam.mockReturnValue({
      isSpam: true,
      reason: 'Honeypot field filled',
    });
    const res = await mail.sendContactForm(formData, '1.2.3.4');
    expect(res).toEqual({ success: false, error: 'Message detected as spam' });
    expect(prismaMock.contactEmail.create).not.toHaveBeenCalled();
  });

  it('stores the message, notifies info@, translates and drafts a reply', async () => {
    stubOpenAiContactCalls();
    prismaMock.contactEmail.create.mockResolvedValue({ id: 55 });
    prismaMock.contactEmail.update.mockResolvedValue({});

    const res = await mail.sendContactForm(formData, '1.2.3.4');
    expect(res).toEqual({ success: true });

    expect(prismaMock.contactEmail.create).toHaveBeenCalledWith({
      data: {
        name: 'John Doe',
        email: 'john@example.com',
        subject: 'Where is my order?',
        message: 'Hi, where is my order QR123?',
        locale: null,
        ip: '1.2.3.4',
      },
    });

    // Background processing: SES notification + pushover + 2 DB updates
    await vi.waitFor(() => expect(sesSend).toHaveBeenCalledTimes(1));
    const raw = lastRaw();
    expect(raw).toContain('To: info@qrsong.io');
    expect(raw).toContain('Subject: QRSong! Contact form');
    expect(raw).not.toContain('(Business)');
    expect(raw).toContain('Reply-To: john@example.com');
    expect(raw).toContain('Hi, where is my order QR123?');

    await vi.waitFor(() =>
      expect(prismaMock.contactEmail.update).toHaveBeenCalledTimes(2)
    );
    expect(prismaMock.contactEmail.update).toHaveBeenCalledWith({
      where: { id: 55 },
      data: {
        locale: 'en',
        translatedMessage: 'Hoi, waar is mijn bestelling QR123?',
      },
    });
    expect(prismaMock.contactEmail.update).toHaveBeenCalledWith({
      where: { id: 55 },
      data: { draftReply: 'Beste John, ...' },
    });
    expect(chatMock.processToolsForContext).toHaveBeenCalledWith(
      formData.message,
      ['shipping'],
      [],
      { email: 'john@example.com' }
    );

    await vi.waitFor(() =>
      expect(outbound.calls('PushoverClient', 'sendMessage')).toHaveLength(1)
    );
    expect(
      outbound.calls('PushoverClient', 'sendMessage')[0].args[0].message
    ).toContain('john@example.com');
  });

  it('routes business inquiries to BUSINESS_CONTACT_EMAIL with a Business subject', async () => {
    process.env['BUSINESS_CONTACT_EMAIL'] = 'biz@qrsong.io';
    stubOpenAiContactCalls();
    prismaMock.contactEmail.create.mockResolvedValue({ id: 56 });
    prismaMock.contactEmail.update.mockResolvedValue({});

    const res = await mail.sendContactForm(
      { ...formData, inquiryType: 'business' },
      '1.2.3.4'
    );
    expect(res).toEqual({ success: true });
    await vi.waitFor(() => expect(sesSend).toHaveBeenCalledTimes(1));
    const raw = lastRaw();
    expect(raw).toContain('To: biz@qrsong.io');
    expect(raw).toContain('Subject: QRSong! Contact form (Business)');
  });

  it('returns a generic error when the database write fails', async () => {
    stubOpenAiContactCalls();
    prismaMock.contactEmail.create.mockRejectedValue(new Error('db down'));
    const res = await mail.sendContactForm(formData, '1.2.3.4');
    expect(res).toEqual({
      success: false,
      error: 'Failed to process contact form',
    });
    expect(sesSend).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Newsletter subscribe / unsubscribe
// ---------------------------------------------------------------------------
describe('newsletter', () => {
  it('subscribeToNewsletter throws when captcha fails', async () => {
    utilsMock.verifyRecaptcha.mockResolvedValue({ isHuman: false, score: 0 });
    await expect(
      mail.subscribeToNewsletter('x@example.com', 'tok')
    ).rejects.toThrow('Verification failed');
  });

  it('subscribeToNewsletter re-subscribes an existing user', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 3 });
    prismaMock.user.update.mockResolvedValue({});
    const ok = await mail.subscribeToNewsletter('x@example.com', 'tok');
    expect(ok).toBe(true);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { email: 'x@example.com' },
      data: { marketingEmails: true, sync: true },
    });
    expect(prismaMock.user.create).not.toHaveBeenCalled();
  });

  it('subscribeToNewsletter creates a new user with a 16-char hash', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.user.create.mockResolvedValue({});
    const ok = await mail.subscribeToNewsletter('new@example.com', 'tok');
    expect(ok).toBe(true);
    const arg = prismaMock.user.create.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      email: 'new@example.com',
      userId: 'new@example.com',
      displayName: 'new',
      marketingEmails: true,
      sync: true,
    });
    expect(arg.data.hash).toMatch(/^[0-9a-f]{16}$/);
  });

  it('subscribeToNewsletter returns false on database errors', async () => {
    prismaMock.user.findUnique.mockRejectedValue(new Error('db down'));
    const ok = await mail.subscribeToNewsletter('x@example.com', 'tok');
    expect(ok).toBe(false);
  });

  it('unsubscribe disables marketing mails for a known hash', async () => {
    prismaMock.user.findUnique.mockResolvedValue({ id: 12 });
    prismaMock.user.update.mockResolvedValue({});
    expect(await mail.unsubscribe('hash-12')).toBe(true);
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 12 },
      data: { marketingEmails: false, sync: true },
    });
  });

  it('unsubscribe returns false for unknown hashes and on errors', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    expect(await mail.unsubscribe('nope')).toBe(false);
    prismaMock.user.findUnique.mockRejectedValue(new Error('db down'));
    expect(await mail.unsubscribe('boom')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Mail Octopus sync
// ---------------------------------------------------------------------------
describe('Mail Octopus contact sync', () => {
  it('uploadContacts skips when MAIL_OCTOPUS_LIST_ID is not configured', async () => {
    prismaMock.user.findMany.mockResolvedValue([]); // completeUserInformation
    await mail.uploadContacts();
    expect(axiosPut).not.toHaveBeenCalled();
  });

  it('uploadContacts uploads tagged contacts, backfills locale/country and clears sync', async () => {
    process.env['MAIL_OCTOPUS_LIST_ID'] = 'list-1';
    process.env['MAIL_OCTOPUS_API_KEY'] = 'octo-key';

    prismaMock.user.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.country === null) {
        // completeUserInformation: users missing a country
        return [{ id: 9, email: 'old@example.com' }];
      }
      // sync=true export batch
      return [
        {
          id: 1,
          email: 'a@example.com',
          displayName: 'Alice',
          createdAt: new Date('2026-01-01T00:00:00Z'),
          marketingEmails: true,
          locale: '',
          country: 'NL',
        },
        {
          id: 2,
          email: 'invalid@example.com',
          displayName: 'Bob',
          createdAt: new Date('2026-01-02T00:00:00Z'),
          marketingEmails: false,
          locale: 'de',
          country: '',
        },
        {
          id: 3,
          email: 'err@example.com',
          displayName: 'Carol',
          createdAt: new Date('2026-01-03T00:00:00Z'),
          marketingEmails: true,
          locale: 'en',
          country: 'US',
        },
      ];
    });
    prismaMock.payment.findFirst.mockImplementation(async (args: any) => {
      if (args?.where?.countrycode) return { countrycode: 'NL' };
      return { locale: 'nl' };
    });
    prismaMock.user.update.mockResolvedValue({});
    prismaMock.user.updateMany.mockResolvedValue({ count: 2 });

    axiosPut
      .mockResolvedValueOnce({ data: {} })
      .mockRejectedValueOnce({
        response: { status: 422, data: { detail: 'Invalid email address' } },
      })
      .mockRejectedValueOnce(new Error('network down'));

    await mail.uploadContacts();

    // completeUserInformation backfilled the country from the last payment
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 9 },
      data: { country: 'NL', sync: true },
    });
    // Alice's missing locale got backfilled from her last payment
    expect(prismaMock.user.update).toHaveBeenCalledWith({
      where: { id: 1 },
      data: { locale: 'nl' },
    });

    expect(axiosPut).toHaveBeenCalledTimes(3);
    const [url, payload, opts] = axiosPut.mock.calls[0] as any[];
    expect(url).toBe('https://api.emailoctopus.com/lists/list-1/contacts');
    expect(opts.headers.Authorization).toBe('Bearer octo-key');
    expect(payload).toMatchObject({
      email_address: 'a@example.com',
      status: 'subscribed',
      fields: { FirstName: 'Alice', Locale: 'nl', Country: 'NL' },
    });
    expect(payload.tags['locale-nl']).toBe(true);
    expect(payload.tags['locale-en']).toBe(false);
    expect(payload.tags['country-nl']).toBe(true);

    const second = axiosPut.mock.calls[1][1] as any;
    expect(second.status).toBe('unsubscribed');
    expect(second.tags['locale-de']).toBe(true);
    expect(
      Object.keys(second.tags).some((k: string) => k.startsWith('country-'))
    ).toBe(false);

    // Success + 422 are marked processed (sync=false); hard error is retried
    expect(prismaMock.user.updateMany).toHaveBeenCalledWith({
      where: { email: { in: ['a@example.com', 'invalid@example.com'] } },
      data: { sync: false },
    });
  }, 30000);

  it('uploadContacts alerts via pushover when the batch blows up', async () => {
    process.env['MAIL_OCTOPUS_LIST_ID'] = 'list-1';
    prismaMock.user.findMany.mockRejectedValue(new Error('db exploded'));
    await mail.uploadContacts();
    const calls = outbound.calls('PushoverClient', 'sendMessage');
    expect(calls).toHaveLength(1);
    expect(calls[0].args[0].title).toContain('Contact Upload Error');
    expect(calls[0].args[0].message).toContain('db exploded');
  });

  it('resyncMailOctopusContacts with a limit flags only candidate users', async () => {
    prismaMock.user.findMany.mockImplementation(async (args: any) => {
      if (args?.where?.sync === false) return [{ id: 1 }, { id: 2 }];
      return []; // completeUserInformation inside background uploadContacts
    });
    prismaMock.user.updateMany.mockResolvedValue({ count: 2 });
    const res = await mail.resyncMailOctopusContacts(2);
    expect(res).toEqual({ flagged: 2 });
    expect(prismaMock.user.updateMany).toHaveBeenCalledWith({
      where: { id: { in: [1, 2] } },
      data: { sync: true },
    });
  });

  it('resyncMailOctopusContacts without a limit flags everyone', async () => {
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.user.updateMany.mockResolvedValue({ count: 7 });
    const res = await mail.resyncMailOctopusContacts();
    expect(res).toEqual({ flagged: 7 });
    expect(prismaMock.user.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: { sync: true } })
    );
  });
});

// ---------------------------------------------------------------------------
// Guard + error paths shared by all senders
// ---------------------------------------------------------------------------
describe('sender guard and error paths', () => {
  it('every sender bails out silently when SES is not initialized', async () => {
    const realSes = (mail as any).ses;
    (mail as any).ses = null;
    try {
      await mail.sendPasswordResetMail('a@x.io', 'A', 't');
      await mail.sendDesignAlterMail('a@x.io', 'A', 'en', 'p', 'h', 'pl', 'hitster');
      await mail.sendQRSongActivationMail('a@x.io', 'A', 'h');
      await mail.sendCustomerRegistrationPincode('a@x.io', 'A', '1');
      await mail.sendForgotPasswordPincode('a@x.io', 'A', '1');
      await mail.sendQRSongVerificationMail('a@x.io', 'A', 'h');
      await mail.sendQRVoteWelcomeEmail('a@x.io', 'A', 'C', 'en', 'h');
      await mail.sendPortalWelcomeEmail('a@x.io', 'A', 'C', 'u', 'us', 'pw');
      await mail.sendEmail('digital', makePayment(), [makePlaylist()]);
      await mail.sendTrackingEmail(makePayment(), 't', '');
      await mail.sendBoxInstructionsEmail(makePayment());
      await mail.sendFinalizedMail(makePayment(), 'r', makePlaylist());
      await mail.sendToPrinterMail(makePayment(), makePlaylist());
      await mail.sendBoxUpgradeConfirmationEmail(1);
      await mail.sendReviewEmail(makePayment());
      await mail.sendVerificationEmail('a@x.io', 'A', 'C', 'h', 'en');
      await mail.sendCustomMail('a@x.io', 'A', 's', 'm');
      await mail.sendPromotionalSaleEmail('a@x.io', 'A', 'P', 1, 2, 'C', 's', null);
      await mail.sendPromotionalApprovedEmail('a@x.io', 'A', 'P', 'C', 's', 'su');
    } finally {
      (mail as any).ses = realSes;
    }
    expect(sesSend).not.toHaveBeenCalled();
    expect(prismaMock.paymentHasPlaylist.findUnique).not.toHaveBeenCalled();
  });

  it('every sender swallows render/IO errors (missing assets) without sending', async () => {
    process.env['ASSETS_DIR'] = BOGUS_ASSETS;
    prismaMock.paymentHasPlaylist.findUnique.mockResolvedValue({
      id: 5,
      payment: makePayment(),
      playlist: makePlaylist(),
    });
    prismaMock.user.findUnique.mockResolvedValue({ hash: 'h' });

    await mail.sendDesignAlterMail('a@x.io', 'A', 'en', 'p', 'h', 'pl', 'hitster');
    await mail.sendQRSongActivationMail('a@x.io', 'A', 'h');
    await mail.sendCustomerRegistrationPincode('a@x.io', 'A', '1');
    await mail.sendForgotPasswordPincode('a@x.io', 'A', '1');
    await mail.sendQRSongVerificationMail('a@x.io', 'A', 'h');
    await mail.sendQRVoteWelcomeEmail('a@x.io', 'A', 'C', 'en', 'h');
    await mail.sendPortalWelcomeEmail('a@x.io', 'A', 'C', 'u', 'us', 'pw');
    await mail.sendTrackingEmail(makePayment(), 't', '');
    await mail.sendBoxInstructionsEmail(makePayment());
    await mail.sendToPrinterMail(makePayment(), makePlaylist());
    await mail.sendBoxUpgradeConfirmationEmail(5);
    await mail.sendReviewEmail(makePayment());
    await mail.sendVerificationEmail('a@x.io', 'A', 'C', 'h', 'en');
    await mail.sendCustomMail('a@x.io', 'A', 's', 'm');
    await mail.sendPromotionalSaleEmail('a@x.io', 'A', 'P', 1, 2, 'C', 's', null);
    await mail.sendPromotionalApprovedEmail('a@x.io', 'A', 'P', 'C', 's', 'su');

    expect(sesSend).not.toHaveBeenCalled();
    // review flag is only set after a successful send
    expect(prismaMock.payment.update).not.toHaveBeenCalled();
  });

  it('contact form background AI failures do not block the notification mail', async () => {
    openaiCreate.mockRejectedValue(new Error('openai down'));
    prismaMock.contactEmail.create.mockResolvedValue({ id: 77 });

    const res = await mail.sendContactForm(
      {
        captchaToken: 'tok',
        honeypot: '',
        name: 'Jane',
        email: 'jane@example.com',
        message: 'Help',
      },
      '9.9.9.9'
    );
    expect(res).toEqual({ success: true });
    await vi.waitFor(() => expect(sesSend).toHaveBeenCalledTimes(1));
    // Both AI tasks failed → no contactEmail updates were written
    await new Promise((r) => setTimeout(r, 20));
    expect(prismaMock.contactEmail.update).not.toHaveBeenCalled();
  });

  it('uploadContacts returns early when there are no flagged users', async () => {
    process.env['MAIL_OCTOPUS_LIST_ID'] = 'list-1';
    prismaMock.user.findMany.mockResolvedValue([]);
    await mail.uploadContacts();
    expect(axiosPut).not.toHaveBeenCalled();
    expect(prismaMock.user.updateMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Cron
// ---------------------------------------------------------------------------
describe('startCron', () => {
  it('schedules the daily contact upload at 3 AM', async () => {
    cronCtor.mockClear();
    prismaMock.user.findMany.mockResolvedValue([]);
    mail.startCron();
    expect(cronCtor).toHaveBeenCalledTimes(1);
    const [schedule, callback, onComplete, start] = cronCtor.mock
      .calls[0] as any[];
    expect(schedule).toBe('0 3 * * *');
    expect(onComplete).toBeNull();
    expect(start).toBe(true);
    // The tick runs uploadContacts (no list configured → early return)
    callback();
    await vi.waitFor(() =>
      expect(prismaMock.user.findMany).toHaveBeenCalled()
    );
    expect(axiosPut).not.toHaveBeenCalled();
  });
});
