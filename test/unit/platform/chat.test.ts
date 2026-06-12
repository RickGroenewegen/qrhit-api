/**
 * Unit tests for src/chat.ts (ChatService).
 *
 * All collaborators are mocked at the module boundary (no DB, no Redis,
 * no network):
 *  - openai              → chat.completions.create captured/stubbed
 *  - ../../../src/prisma → in-memory prisma stub
 *  - ../../../src/cache  → Map-backed get/set/del
 *  - ../../../src/translation → static LOCALE_NAMES stub
 *  - ../../../src/shipping    → getInstance() stub
 *  - ../../../src/logger      → no-op
 *  - cron                → constructor recorded (no real timers)
 *
 * Knowledge is loaded from a fixture chat.json: APP_ROOT is temporarily
 * pointed at a scratch dir while the ChatService under test is constructed.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Module-boundary mocks (hoisted)
// ---------------------------------------------------------------------------

const {
  createMock,
  prismaMock,
  cacheStore,
  cacheMock,
  shippingMock,
  cronCtor,
} = vi.hoisted(() => {
  const store = new Map<string, string>();
  return {
    createMock: vi.fn(),
    prismaMock: {
      chat: {
        create: vi.fn(),
        findUnique: vi.fn(),
        update: vi.fn(),
        deleteMany: vi.fn(),
      },
      chatMessage: {
        create: vi.fn(),
        update: vi.fn(),
        findMany: vi.fn(),
        count: vi.fn(),
        updateMany: vi.fn(),
      },
      payment: {
        findFirst: vi.fn(),
        findUnique: vi.fn(),
      },
    },
    cacheStore: store,
    cacheMock: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, value: string, _ttl?: number) => {
        store.set(key, value);
      }),
      del: vi.fn(async (key: string) => {
        store.delete(key);
      }),
    },
    shippingMock: {
      getTrackingInfo: vi.fn(),
      getShippingInfoByCountry: vi.fn(),
    },
    cronCtor: vi.fn(),
  };
});

vi.mock('openai', () => ({
  default: class OpenAIMock {
    chat = { completions: { create: createMock } };
    constructor(_opts: any) {}
  },
}));

vi.mock('../../../src/prisma', () => ({
  default: { getInstance: () => prismaMock },
}));

vi.mock('../../../src/logger', () => ({
  default: class {
    log() {}
    logDev() {}
  },
}));

vi.mock('../../../src/cache', () => ({
  default: { getInstance: () => cacheMock },
}));

vi.mock('../../../src/translation', () => ({
  default: class TranslationMock {
    static LOCALE_NAMES: Record<string, string> = {
      en: 'English',
      nl: 'Dutch',
      de: 'German',
    };
  },
}));

vi.mock('../../../src/shipping', () => ({
  default: { getInstance: () => shippingMock },
}));

vi.mock('cron', () => ({ CronJob: cronCtor }));

import { ChatService } from '../../../src/chat';

// ---------------------------------------------------------------------------
// Knowledge fixture + service construction
// ---------------------------------------------------------------------------

const KNOWLEDGE = [
  {
    slug: 'shipping-status',
    title: 'Where is my order?',
    description: 'Track your order.',
    tags: ['shipping', 'tracking'],
    tools: [
      {
        name: 'getShippingStatus',
        requiredData: [
          {
            name: 'orderNumber',
            description: 'the order number',
            userPrompt: 'your order number',
          },
          { name: 'email', description: 'the email used' },
        ],
      },
    ],
  },
  {
    slug: 'shipping-times',
    title: 'Shipping times',
    description: 'Delivery estimates.',
    tags: ['delivery'],
    tools: [
      {
        name: 'getShippingTimes',
        requiredData: [
          { name: 'countryCode', description: 'two-letter country code' },
        ],
      },
    ],
  },
  {
    slug: 'pricing',
    title: 'Pricing',
    description: 'Cards cost money.',
    tags: ['price'],
  },
];

let service: ChatService;
let cronExpression: string;
let cronBody: () => Promise<void>;

beforeAll(() => {
  // Write the knowledge fixture and construct the service with APP_ROOT
  // pointing at it (chat.ts reads APP_ROOT/_data/chat.json in the ctor).
  const appRoot = path.join(process.env['PRIVATE_DIR']!, 'chat-test-approot');
  fs.mkdirSync(path.join(appRoot, '_data'), { recursive: true });
  fs.writeFileSync(
    path.join(appRoot, '_data', 'chat.json'),
    JSON.stringify({ knowledge: KNOWLEDGE })
  );

  const prevAppRoot = process.env['APP_ROOT'];
  process.env['APP_ROOT'] = appRoot;
  try {
    service = new ChatService();
  } finally {
    process.env['APP_ROOT'] = prevAppRoot;
  }

  // Capture the cron registration before any mock resets.
  expect(cronCtor).toHaveBeenCalledTimes(1);
  cronExpression = cronCtor.mock.calls[0][0];
  cronBody = cronCtor.mock.calls[0][1];
});

beforeEach(() => {
  createMock.mockReset();
  prismaMock.chat.create.mockReset();
  prismaMock.chat.findUnique.mockReset();
  prismaMock.chat.update.mockReset();
  prismaMock.chat.deleteMany.mockReset();
  prismaMock.chatMessage.create.mockReset();
  prismaMock.chatMessage.update.mockReset();
  prismaMock.chatMessage.findMany.mockReset();
  prismaMock.chatMessage.count.mockReset();
  prismaMock.chatMessage.updateMany.mockReset();
  prismaMock.payment.findFirst.mockReset();
  prismaMock.payment.findUnique.mockReset();
  shippingMock.getTrackingInfo.mockReset();
  shippingMock.getShippingInfoByCountry.mockReset();
  cacheMock.get.mockClear();
  cacheMock.set.mockClear();
  cacheMock.del.mockClear();
  cacheStore.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Chat completion response with a plain text message. */
function textResponse(content: string | null) {
  return { choices: [{ message: { content } }] };
}

/** Chat completion response carrying a legacy function_call. */
function functionCallResponse(args: unknown, rawArgs?: string) {
  return {
    choices: [
      {
        message: {
          function_call: {
            name: 'selectTopics',
            arguments: rawArgs ?? JSON.stringify(args),
          },
        },
      },
    ],
  };
}

/** Async-iterable stream of completion chunks (plus one empty delta). */
async function* streamOf(...chunks: string[]) {
  for (const c of chunks) {
    yield { choices: [{ delta: { content: c } }] };
  }
  yield { choices: [{ delta: {} }] };
}

// ---------------------------------------------------------------------------
// Construction / knowledge loading / cron registration
// ---------------------------------------------------------------------------

describe('ChatService constructor', () => {
  it('registers the cleanup cron to run every 6 hours, autostarted', () => {
    expect(cronExpression).toBe('0 */6 * * *');
    expect(typeof cronBody).toBe('function');
    // (expr, onTick, onComplete=null, start=true)
    expect(cronCtor.mock.calls[0][2]).toBeNull();
    expect(cronCtor.mock.calls[0][3]).toBe(true);
  });

  it('loads the knowledge items from APP_ROOT/_data/chat.json', () => {
    expect(service.getKnowledgeBySlug(['pricing'])).toEqual([KNOWLEDGE[2]]);
  });

  it('falls back to empty knowledge when chat.json cannot be read', () => {
    const prevAppRoot = process.env['APP_ROOT'];
    process.env['APP_ROOT'] = path.join(
      process.env['PRIVATE_DIR']!,
      'does-not-exist'
    );
    let broken: ChatService;
    try {
      broken = new ChatService();
    } finally {
      process.env['APP_ROOT'] = prevAppRoot;
    }
    expect(broken.getKnowledgeBySlug(['pricing'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// cleanupOldEmptyChats (cron body, called directly)
// ---------------------------------------------------------------------------

describe('cleanupOldEmptyChats (cron body)', () => {
  it('deletes chats older than 24h that have no messages', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-06-11T12:00:00.000Z'));
    prismaMock.chat.deleteMany.mockResolvedValueOnce({ count: 2 });

    await cronBody();

    expect(prismaMock.chat.deleteMany).toHaveBeenCalledExactlyOnceWith({
      where: {
        createdAt: { lt: new Date('2026-06-10T12:00:00.000Z') },
        messages: { none: {} },
      },
    });
  });

  it('swallows database errors (cron must not throw)', async () => {
    prismaMock.chat.deleteMany.mockRejectedValueOnce(new Error('db down'));
    await expect(cronBody()).resolves.toBeUndefined();
  });

  it('handles a zero-delete run without error', async () => {
    prismaMock.chat.deleteMany.mockResolvedValueOnce({ count: 0 });
    await expect(cronBody()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Simple prisma-backed accessors
// ---------------------------------------------------------------------------

describe('createChat', () => {
  it('derives the username from the email and returns the new chat id', async () => {
    prismaMock.chat.create.mockResolvedValueOnce({ id: 7 });

    const id = await service.createChat('john.doe@example.com');

    expect(id).toBe(7);
    expect(prismaMock.chat.create).toHaveBeenCalledExactlyOnceWith({
      data: { email: 'john.doe@example.com', username: 'john.doe' },
    });
  });
});

describe('getChat', () => {
  it('selects the chat metadata fields by id', async () => {
    const chat = {
      id: 5,
      email: 'a@b.com',
      username: 'a',
      locale: 'de',
      supportNeeded: false,
      hijacked: true,
    };
    prismaMock.chat.findUnique.mockResolvedValueOnce(chat);

    expect(await service.getChat(5)).toEqual(chat);
    expect(prismaMock.chat.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { id: 5 },
      select: {
        id: true,
        email: true,
        username: true,
        locale: true,
        supportNeeded: true,
        hijacked: true,
      },
    });
  });

  it('returns null for an unknown chat', async () => {
    prismaMock.chat.findUnique.mockResolvedValueOnce(null);
    expect(await service.getChat(999)).toBeNull();
  });
});

describe('flag updates', () => {
  it('updateChatLocale writes the locale', async () => {
    prismaMock.chat.update.mockResolvedValueOnce({});
    await service.updateChatLocale(3, 'de');
    expect(prismaMock.chat.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 3 },
      data: { locale: 'de' },
    });
  });

  it('toggleHijack writes the hijacked flag', async () => {
    prismaMock.chat.update.mockResolvedValueOnce({});
    await service.toggleHijack(3, true);
    expect(prismaMock.chat.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 3 },
      data: { hijacked: true },
    });
  });

  it('markSupportNeeded sets supportNeeded true', async () => {
    prismaMock.chat.update.mockResolvedValueOnce({});
    await service.markSupportNeeded(4);
    expect(prismaMock.chat.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 4 },
      data: { supportNeeded: true },
    });
  });

  it('toggleSupportNeeded writes the given value', async () => {
    prismaMock.chat.update.mockResolvedValueOnce({});
    await service.toggleSupportNeeded(4, false);
    expect(prismaMock.chat.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 4 },
      data: { supportNeeded: false },
    });
  });

  it('markChatAsSeen clears unseenMessages', async () => {
    prismaMock.chat.update.mockResolvedValueOnce({});
    await service.markChatAsSeen(4);
    expect(prismaMock.chat.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 4 },
      data: { unseenMessages: false },
    });
  });
});

describe('chatHasMessages', () => {
  it('returns true when at least one message exists', async () => {
    prismaMock.chatMessage.count.mockResolvedValueOnce(3);
    expect(await service.chatHasMessages(8)).toBe(true);
    expect(prismaMock.chatMessage.count).toHaveBeenCalledExactlyOnceWith({
      where: { chatId: 8 },
    });
  });

  it('returns false for an empty chat', async () => {
    prismaMock.chatMessage.count.mockResolvedValueOnce(0);
    expect(await service.chatHasMessages(8)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// saveMessage / cache invalidation
// ---------------------------------------------------------------------------

describe('saveMessage', () => {
  it('persists the message, bumps lastActivityAt and invalidates the history cache', async () => {
    prismaMock.chatMessage.create.mockResolvedValueOnce({ id: 11 });
    prismaMock.chat.update.mockResolvedValueOnce({});
    cacheStore.set('chat:history:5', '[]');

    const id = await service.saveMessage(5, 'user', 'hello');

    expect(id).toBe(11);
    expect(prismaMock.chatMessage.create).toHaveBeenCalledExactlyOnceWith({
      data: { chatId: 5, role: 'user', content: 'hello' },
    });
    expect(prismaMock.chat.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 5 },
      data: { lastActivityAt: expect.any(Date) },
    });
    expect(cacheMock.del).toHaveBeenCalledExactlyOnceWith('chat:history:5');
    expect(cacheStore.has('chat:history:5')).toBe(false);
  });
});

describe('invalidateChatCache', () => {
  it('deletes the chat:history:<id> key', async () => {
    await service.invalidateChatCache(42);
    expect(cacheMock.del).toHaveBeenCalledExactlyOnceWith('chat:history:42');
  });
});

// ---------------------------------------------------------------------------
// saveUserMessage (+ Dutch translation)
// ---------------------------------------------------------------------------

describe('saveUserMessage', () => {
  it('saves the message and stores the Dutch translation on it', async () => {
    prismaMock.chatMessage.create.mockResolvedValueOnce({ id: 21 });
    prismaMock.chat.update.mockResolvedValue({});
    prismaMock.chatMessage.update.mockResolvedValueOnce({});
    createMock.mockResolvedValueOnce(textResponse('Hallo daar'));

    const result = await service.saveUserMessage(9, 'Hello there');

    expect(result).toEqual({ id: 21, translatedContent: 'Hallo daar' });
    expect(prismaMock.chatMessage.create).toHaveBeenCalledExactlyOnceWith({
      data: { chatId: 9, role: 'user', content: 'Hello there' },
    });
    expect(prismaMock.chatMessage.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 21 },
      data: { translatedContent: 'Hallo daar' },
    });

    // Exact translation request
    expect(createMock).toHaveBeenCalledExactlyOnceWith({
      model: 'gpt-4o-mini',
      temperature: 0.3,
      messages: [
        {
          role: 'system',
          content:
            'Translate the following text to Dutch. Return only the translation, nothing else.',
        },
        { role: 'user', content: 'Hello there' },
      ],
    });
  });

  it('returns a null translation (and skips the update) when OpenAI fails', async () => {
    prismaMock.chatMessage.create.mockResolvedValueOnce({ id: 22 });
    prismaMock.chat.update.mockResolvedValue({});
    createMock.mockRejectedValueOnce(new Error('rate limit'));

    const result = await service.saveUserMessage(9, 'Hi');

    expect(result).toEqual({ id: 22, translatedContent: null });
    expect(prismaMock.chatMessage.update).not.toHaveBeenCalled();
  });

  it('returns a null translation when the model answers with empty content', async () => {
    prismaMock.chatMessage.create.mockResolvedValueOnce({ id: 23 });
    prismaMock.chat.update.mockResolvedValue({});
    createMock.mockResolvedValueOnce(textResponse(null));

    const result = await service.saveUserMessage(9, 'Hi');
    expect(result).toEqual({ id: 23, translatedContent: null });
    expect(prismaMock.chatMessage.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// saveAdminMessage / translateToLocale
// ---------------------------------------------------------------------------

describe('saveAdminMessage', () => {
  it('stores Dutch content twice, bumps activity, invalidates cache and translates for the user', async () => {
    prismaMock.chatMessage.create.mockResolvedValueOnce({ id: 31 });
    prismaMock.chat.update.mockResolvedValueOnce({});
    createMock.mockResolvedValueOnce(textResponse('German text'));

    const result = await service.saveAdminMessage(6, 'Nederlandse tekst', 'de');

    expect(result).toEqual({ id: 31, translatedContent: 'German text' });
    expect(prismaMock.chatMessage.create).toHaveBeenCalledExactlyOnceWith({
      data: {
        chatId: 6,
        role: 'admin',
        content: 'Nederlandse tekst',
        translatedContent: 'Nederlandse tekst',
      },
    });
    expect(prismaMock.chat.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 6 },
      data: { lastActivityAt: expect.any(Date) },
    });
    expect(cacheMock.del).toHaveBeenCalledExactlyOnceWith('chat:history:6');

    const payload = createMock.mock.calls[0][0];
    expect(payload.model).toBe('gpt-4o-mini');
    expect(payload.messages[0].content).toBe(
      'Translate the following Dutch text to German. Keep any markdown formatting intact. Only return the translation, nothing else.'
    );
    expect(payload.messages[1]).toEqual({
      role: 'user',
      content: 'Nederlandse tekst',
    });
  });

  it('skips translation entirely for Dutch users', async () => {
    prismaMock.chatMessage.create.mockResolvedValueOnce({ id: 32 });
    prismaMock.chat.update.mockResolvedValueOnce({});

    const result = await service.saveAdminMessage(6, 'Hallo', 'nl');

    expect(result).toEqual({ id: 32, translatedContent: 'Hallo' });
    expect(createMock).not.toHaveBeenCalled();
  });
});

describe('translateToLocale', () => {
  it('falls back to English for an unknown locale', async () => {
    createMock.mockResolvedValueOnce(textResponse('English text'));
    expect(await service.translateToLocale('tekst', 'xx')).toBe('English text');
    expect(createMock.mock.calls[0][0].messages[0].content).toContain(
      'Dutch text to English'
    );
  });

  it('returns the original content when the API throws', async () => {
    createMock.mockRejectedValueOnce(new Error('down'));
    expect(await service.translateToLocale('tekst', 'de')).toBe('tekst');
  });

  it('returns the original content when the model answers empty', async () => {
    createMock.mockResolvedValueOnce(textResponse(null));
    expect(await service.translateToLocale('tekst', 'de')).toBe('tekst');
  });
});

// ---------------------------------------------------------------------------
// translateToDutch (background message translation)
// ---------------------------------------------------------------------------

describe('translateToDutch', () => {
  it('writes the translation onto the message', async () => {
    createMock.mockResolvedValueOnce(textResponse('Vertaald'));
    prismaMock.chatMessage.update.mockResolvedValueOnce({});

    await service.translateToDutch(77, 'Translated');

    expect(prismaMock.chatMessage.update).toHaveBeenCalledExactlyOnceWith({
      where: { id: 77 },
      data: { translatedContent: 'Vertaald' },
    });
    expect(createMock.mock.calls[0][0].messages[0].content).toBe(
      'Translate the following text to Dutch. Keep any markdown formatting intact. Only return the translation, nothing else.'
    );
  });

  it('does not write when the model returns no content', async () => {
    createMock.mockResolvedValueOnce(textResponse(null));
    await service.translateToDutch(77, 'x');
    expect(prismaMock.chatMessage.update).not.toHaveBeenCalled();
  });

  it('swallows API errors', async () => {
    createMock.mockRejectedValueOnce(new Error('down'));
    await expect(service.translateToDutch(77, 'x')).resolves.toBeUndefined();
    expect(prismaMock.chatMessage.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getChatHistory / clearChatForUser
// ---------------------------------------------------------------------------

describe('getChatHistory', () => {
  it('loads visible messages, maps admin → assistant and caches the result for 1h', async () => {
    prismaMock.chatMessage.findMany.mockResolvedValueOnce([
      { role: 'user', content: 'Q1' },
      { role: 'admin', content: 'A1 (admin)' },
      { role: 'assistant', content: 'A2' },
    ]);

    const history = await service.getChatHistory(5);

    expect(history).toEqual([
      { role: 'user', content: 'Q1' },
      { role: 'assistant', content: 'A1 (admin)' },
      { role: 'assistant', content: 'A2' },
    ]);
    expect(prismaMock.chatMessage.findMany).toHaveBeenCalledExactlyOnceWith({
      where: { chatId: 5, visibleToUser: true },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });
    expect(cacheMock.set).toHaveBeenCalledExactlyOnceWith(
      'chat:history:5',
      JSON.stringify(history),
      3600
    );

    // Second call is served from the cache: prisma is not hit again.
    expect(await service.getChatHistory(5)).toEqual(history);
    expect(prismaMock.chatMessage.findMany).toHaveBeenCalledTimes(1);
  });

  it('returns the cached history without touching prisma', async () => {
    cacheStore.set(
      'chat:history:5',
      JSON.stringify([{ role: 'user', content: 'cached' }])
    );

    expect(await service.getChatHistory(5)).toEqual([
      { role: 'user', content: 'cached' },
    ]);
    expect(prismaMock.chatMessage.findMany).not.toHaveBeenCalled();
    expect(cacheMock.set).not.toHaveBeenCalled();
  });
});

describe('clearChatForUser', () => {
  it('soft-hides all messages and invalidates the cache', async () => {
    prismaMock.chatMessage.updateMany.mockResolvedValueOnce({});
    await service.clearChatForUser(5);
    expect(prismaMock.chatMessage.updateMany).toHaveBeenCalledExactlyOnceWith({
      where: { chatId: 5 },
      data: { visibleToUser: false },
    });
    expect(cacheMock.del).toHaveBeenCalledExactlyOnceWith('chat:history:5');
  });
});

// ---------------------------------------------------------------------------
// getTopics (legacy function_call)
// ---------------------------------------------------------------------------

describe('getTopics', () => {
  it('sends the knowledge summary + history and returns the selected slugs', async () => {
    createMock.mockResolvedValueOnce(
      functionCallResponse({ slugs: ['pricing'], reasoning: 'price question' })
    );

    const topics = await service.getTopics('How much does it cost?', [
      { role: 'user', content: 'Hi' },
      { role: 'assistant', content: 'Hello!' },
    ]);

    expect(topics).toEqual(['pricing']);

    const payload = createMock.mock.calls[0][0];
    expect(payload.model).toBe('gpt-4o-mini');
    expect(payload.temperature).toBe(0.3);
    expect(payload.function_call).toEqual({ name: 'selectTopics' });
    expect(payload.functions).toHaveLength(1);
    expect(payload.functions[0].name).toBe('selectTopics');
    expect(payload.functions[0].parameters.required).toEqual(['slugs']);
    expect(payload.messages[0].role).toBe('system');
    expect(payload.messages[0].content).toContain('Select 1-5 topics maximum');

    // User message: topic summary (slug/title/joined tags), then history, then question
    const expectedSummary = KNOWLEDGE.map((k) => ({
      slug: k.slug,
      title: k.title,
      tags: k.tags.join(', '),
    }));
    expect(payload.messages[1]).toEqual({
      role: 'user',
      content: `Available topics:\n${JSON.stringify(expectedSummary, null, 2)}\n\nPrevious conversation:\nuser: Hi\nassistant: Hello!\n\nUser question: How much does it cost?`,
    });
  });

  it('omits the history block when there is no history', async () => {
    createMock.mockResolvedValueOnce(functionCallResponse({ slugs: [] }));
    await service.getTopics('Hi', []);
    const content = createMock.mock.calls[0][0].messages[1].content;
    expect(content).not.toContain('Previous conversation');
    expect(content).toContain('\n\nUser question: Hi');
  });

  it('returns [] when the arguments JSON is unparseable', async () => {
    createMock.mockResolvedValueOnce(functionCallResponse(null, 'not-json{'));
    expect(await service.getTopics('Q', [])).toEqual([]);
  });

  it('returns [] when the arguments lack a slugs property', async () => {
    createMock.mockResolvedValueOnce(functionCallResponse({ reasoning: 'x' }));
    expect(await service.getTopics('Q', [])).toEqual([]);
  });

  it('returns [] when the model produces no function call', async () => {
    createMock.mockResolvedValueOnce(textResponse('just chatting'));
    expect(await service.getTopics('Q', [])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// getKnowledgeBySlug
// ---------------------------------------------------------------------------

describe('getKnowledgeBySlug', () => {
  it('returns only the knowledge items matching the slugs', () => {
    const items = service.getKnowledgeBySlug(['pricing', 'shipping-times', 'nope']);
    expect(items.map((i) => i.slug)).toEqual(['shipping-times', 'pricing']);
  });

  it('returns [] for no matches', () => {
    expect(service.getKnowledgeBySlug(['unknown'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// extractRequiredData
// ---------------------------------------------------------------------------

describe('extractRequiredData', () => {
  const requiredData = [
    { name: 'orderNumber', description: 'the order number' },
    { name: 'email', description: 'the email used' },
  ];

  it('asks for a JSON object and returns the parsed extraction', async () => {
    createMock.mockResolvedValueOnce(
      textResponse('{"orderNumber":"100123","email":null}')
    );

    const data = await service.extractRequiredData(
      requiredData,
      [{ role: 'user', content: 'My order is 100123' }],
      'Where is it?'
    );

    expect(data).toEqual({ orderNumber: '100123', email: null });

    const payload = createMock.mock.calls[0][0];
    expect(payload.model).toBe('gpt-4o-mini');
    expect(payload.temperature).toBe(0);
    expect(payload.response_format).toEqual({ type: 'json_object' });
    expect(payload.messages[0].content).toContain(
      'Data to extract: orderNumber (the order number), email (the email used)'
    );
    expect(payload.messages[1]).toEqual({
      role: 'user',
      content:
        'Conversation:\nuser: My order is 100123\nuser: Where is it?\n\nExtract: orderNumber, email',
    });
  });

  it('returns {} when the response is not valid JSON', async () => {
    createMock.mockResolvedValueOnce(textResponse('not json'));
    expect(await service.extractRequiredData(requiredData, [], 'Q')).toEqual({});
  });

  it('returns {} when the response has no content', async () => {
    createMock.mockResolvedValueOnce(textResponse(null));
    expect(await service.extractRequiredData(requiredData, [], 'Q')).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// getShippingStatus
// ---------------------------------------------------------------------------

describe('getShippingStatus', () => {
  const basePayment = {
    paymentId: 'pay_1',
    email: 'user@test.com',
    shippingStatus: 'in_transit',
    shippingMessage: 'On its way',
    shippingStartDateTime: null,
    shippingDeliveryDateTime: null,
    shippingCode: 'TRACK123',
    printApiStatus: 'Shipped',
    printApiShipped: true,
  };

  it('reports an unknown order number', async () => {
    prismaMock.payment.findFirst.mockResolvedValueOnce(null);
    expect(await service.getShippingStatus('100999', 'a@b.com')).toBe(
      'Order 100999 was not found. Please check if the order number is correct.'
    );
    expect(prismaMock.payment.findFirst).toHaveBeenCalledExactlyOnceWith({
      where: { orderId: '100999' },
      select: {
        paymentId: true,
        email: true,
        shippingStatus: true,
        shippingMessage: true,
        shippingStartDateTime: true,
        shippingDeliveryDateTime: true,
        shippingCode: true,
        printApiStatus: true,
        printApiShipped: true,
      },
    });
  });

  it('rejects a mismatched email', async () => {
    prismaMock.payment.findFirst.mockResolvedValueOnce(basePayment);
    expect(await service.getShippingStatus('100001', 'other@test.com')).toBe(
      'The email address provided does not match the order. Please verify both the order number and email address.'
    );
    expect(shippingMock.getTrackingInfo).not.toHaveBeenCalled();
  });

  it('matches the email case-insensitively', async () => {
    prismaMock.payment.findFirst.mockResolvedValueOnce({
      ...basePayment,
      shippingCode: null,
      printApiStatus: 'Created',
    });
    expect(await service.getShippingStatus('100001', 'USER@Test.com')).toBe(
      'Order 100001 is currently being prepared for shipping. It has not been shipped yet.'
    );
  });

  it('reports "no tracking yet" when unshipped and not in production', async () => {
    prismaMock.payment.findFirst.mockResolvedValueOnce({
      ...basePayment,
      shippingCode: null,
      printApiStatus: 'Done',
    });
    expect(await service.getShippingStatus('100001', 'user@test.com')).toBe(
      'Order 100001 does not have tracking information available yet.'
    );
  });

  it('refreshes tracking info and reports the delivered status', async () => {
    const delivered = '2026-06-01T10:00:00.000Z';
    prismaMock.payment.findFirst.mockResolvedValueOnce(basePayment);
    shippingMock.getTrackingInfo.mockResolvedValueOnce({});
    prismaMock.payment.findUnique.mockResolvedValueOnce({
      shippingStatus: 'delivered',
      shippingMessage: 'Left at door',
      shippingStartDateTime: '2026-05-28T08:00:00.000Z',
      shippingDeliveryDateTime: delivered,
    });

    const status = await service.getShippingStatus('100001', 'user@test.com');

    expect(status).toBe(
      `Order 100001 status: delivered\nLatest update: Left at door\nDelivered on: ${new Date(delivered).toLocaleDateString()}`
    );
    expect(shippingMock.getTrackingInfo).toHaveBeenCalledExactlyOnceWith('pay_1');
    expect(prismaMock.payment.findUnique).toHaveBeenCalledExactlyOnceWith({
      where: { paymentId: 'pay_1' },
      select: {
        shippingStatus: true,
        shippingMessage: true,
        shippingStartDateTime: true,
        shippingDeliveryDateTime: true,
      },
    });
  });

  it('reports the shipped date when not yet delivered', async () => {
    const shipped = '2026-05-28T08:00:00.000Z';
    prismaMock.payment.findFirst.mockResolvedValueOnce(basePayment);
    shippingMock.getTrackingInfo.mockResolvedValueOnce({});
    prismaMock.payment.findUnique.mockResolvedValueOnce({
      shippingStatus: 'in_transit',
      shippingMessage: null,
      shippingStartDateTime: shipped,
      shippingDeliveryDateTime: null,
    });

    expect(await service.getShippingStatus('100001', 'user@test.com')).toBe(
      `Order 100001 status: in_transit\nShipped on: ${new Date(shipped).toLocaleDateString()}`
    );
  });

  it('falls back to cached data when the tracking API fails', async () => {
    prismaMock.payment.findFirst.mockResolvedValueOnce(basePayment);
    shippingMock.getTrackingInfo.mockRejectedValueOnce(new Error('api down'));

    expect(await service.getShippingStatus('100001', 'user@test.com')).toBe(
      'Order 100001 status: in_transit\nLatest update: On its way'
    );
    expect(prismaMock.payment.findUnique).not.toHaveBeenCalled();
  });

  it('falls back to cached data when the refetch returns null', async () => {
    prismaMock.payment.findFirst.mockResolvedValueOnce({
      ...basePayment,
      shippingStatus: null,
      shippingMessage: null,
    });
    shippingMock.getTrackingInfo.mockResolvedValueOnce({});
    prismaMock.payment.findUnique.mockResolvedValueOnce(null);

    expect(await service.getShippingStatus('100001', 'user@test.com')).toBe(
      'Order 100001 status: Shipped'
    );
  });

  it('returns a generic failure message when the lookup itself throws', async () => {
    prismaMock.payment.findFirst.mockRejectedValueOnce(new Error('db down'));
    expect(await service.getShippingStatus('100001', 'user@test.com')).toBe(
      'Unable to retrieve shipping status for order 100001. Please try again later or contact support.'
    );
  });
});

// ---------------------------------------------------------------------------
// getShippingTimes
// ---------------------------------------------------------------------------

describe('getShippingTimes', () => {
  it('builds the full estimate (production + delivery + total) for a known country', async () => {
    shippingMock.getShippingInfoByCountry.mockResolvedValueOnce({
      productionDays: 3,
      productionMessage: 'Orders ship within 3 days',
      countries: [
        {
          countryCode: 'nl',
          orderCount: 12,
          minDays: 1,
          maxDays: 4,
          averageDays: 2,
        },
      ],
    });

    // lowercase input is normalized to uppercase and matched
    expect(await service.getShippingTimes('nl')).toBe(
      '**Shipping estimate for NL:**\n\n' +
        '**Production:** 3 business days\n' +
        '_Orders ship within 3 days_\n\n' +
        '**Delivery:** 1-4 days after shipment\n' +
        '_(Based on 12 recent deliveries)_\n\n' +
        '**Total estimated time:** approximately 5 days from order placement to delivery'
    );
  });

  it('omits the production message line when absent and handles zero delivery data', async () => {
    shippingMock.getShippingInfoByCountry.mockResolvedValueOnce({
      productionDays: 2,
      productionMessage: null,
      countries: [
        { countryCode: 'BE', orderCount: 0, minDays: 0, maxDays: 0, averageDays: 0 },
      ],
    });

    expect(await service.getShippingTimes('BE')).toBe(
      '**Shipping estimate for BE:**\n\n' +
        '**Production:** 2 business days\n\n' +
        "We don't have enough delivery data for BE yet. Delivery times will vary based on your location and local postal service."
    );
  });

  it('reports missing historical data for an unknown country', async () => {
    shippingMock.getShippingInfoByCountry.mockResolvedValueOnce({
      productionDays: 2,
      productionMessage: null,
      countries: [],
    });

    expect(await service.getShippingTimes('jp')).toBe(
      "We don't have historical shipping data for JP yet. Shipping times typically vary by country. For more specific information about shipping to JP, please contact our support team at info@qrsong.io."
    );
  });

  it('returns a fallback message when the shipping service throws', async () => {
    shippingMock.getShippingInfoByCountry.mockRejectedValueOnce(
      new Error('boom')
    );
    expect(await service.getShippingTimes('NL')).toBe(
      'Unable to retrieve shipping time estimates at the moment. Please try again later or contact our support team.'
    );
  });
});

// ---------------------------------------------------------------------------
// executeTool
// ---------------------------------------------------------------------------

describe('executeTool', () => {
  it('dispatches getShippingStatus with orderNumber and email', async () => {
    prismaMock.payment.findFirst.mockResolvedValueOnce(null);
    const result = await service.executeTool('getShippingStatus', {
      orderNumber: '100123',
      email: 'a@b.com',
    });
    expect(result).toBe(
      'Order 100123 was not found. Please check if the order number is correct.'
    );
  });

  it('dispatches getShippingTimes with the country code', async () => {
    shippingMock.getShippingInfoByCountry.mockResolvedValueOnce({
      productionDays: 2,
      productionMessage: null,
      countries: [],
    });
    const result = await service.executeTool('getShippingTimes', {
      countryCode: 'de',
    });
    expect(result).toContain("We don't have historical shipping data for DE");
  });

  it('reports unknown tools', async () => {
    expect(await service.executeTool('teleport', {})).toBe(
      'Unknown tool: teleport'
    );
  });
});

// ---------------------------------------------------------------------------
// processToolsForContext
// ---------------------------------------------------------------------------

describe('processToolsForContext', () => {
  it('returns empty context when no topics match', async () => {
    const result = await service.processToolsForContext('Q', ['unknown']);
    expect(result).toEqual({
      toolContext: '',
      knowledgeContext: '',
      missingData: [],
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('builds the knowledge context for tool-less topics without calling OpenAI', async () => {
    const result = await service.processToolsForContext('Q', ['pricing']);
    expect(result).toEqual({
      toolContext: '',
      knowledgeContext: '\n\nRelevant information:\n**Pricing**\nCards cost money.',
      missingData: [],
    });
    expect(createMock).not.toHaveBeenCalled();
  });

  it('asks for missing required data using the userPrompt (or description fallback)', async () => {
    // extraction returns nothing usable
    createMock.mockResolvedValueOnce(textResponse('{}'));

    const result = await service.processToolsForContext(
      'Where is my order?',
      ['shipping-status']
    );

    expect(result.missingData).toEqual(['your order number', 'the email used']);
    expect(result.toolContext).toBe(
      "\n\nIMPORTANT: To help the user, you need the following information that they haven't provided yet:\n" +
        '- your order number\n' +
        '- the email used\n\n' +
        'Politely ask the user to provide this information in a natural, friendly way.'
    );
    expect(result.knowledgeContext).toBe(
      '\n\nRelevant information:\n**Where is my order?**\nTrack your order.'
    );
    // Only the extraction call went out; the tool itself never ran.
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled();
  });

  it('executes the tool when extraction plus additionalData cover all required fields', async () => {
    // extraction only finds the order number; email comes from additionalData
    createMock.mockResolvedValueOnce(textResponse('{"orderNumber":"100123"}'));
    prismaMock.payment.findFirst.mockResolvedValueOnce(null);

    const result = await service.processToolsForContext(
      'Where is my order 100123?',
      ['shipping-status'],
      [{ role: 'user', content: 'hi' }],
      { email: 'user@test.com' }
    );

    expect(result.missingData).toEqual([]);
    expect(result.toolContext).toBe(
      '\n\nTOOL RESULT (use this information to answer the user):\n' +
        'Order 100123 was not found. Please check if the order number is correct.'
    );
    expect(prismaMock.payment.findFirst).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ where: { orderId: '100123' } })
    );
  });

  it('treats empty-string extractions as missing data', async () => {
    createMock.mockResolvedValueOnce(
      textResponse('{"orderNumber":"","email":"a@b.com"}')
    );

    const result = await service.processToolsForContext('Q', ['shipping-status']);
    expect(result.missingData).toEqual(['your order number']);
    expect(prismaMock.payment.findFirst).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// answerQuestion (streaming)
// ---------------------------------------------------------------------------

describe('answerQuestion', () => {
  it('streams the answer with the system prompt, knowledge context and history', async () => {
    createMock.mockResolvedValueOnce(streamOf('Hello', ' world'));

    const tokens: string[] = [];
    const answer = await service.answerQuestion(
      'How much?',
      ['pricing'],
      [
        { role: 'user', content: 'earlier question' },
        { role: 'assistant', content: 'earlier answer' },
      ],
      (t) => tokens.push(t)
    );

    expect(answer).toBe('Hello world');
    expect(tokens).toEqual(['Hello', ' world']);

    expect(createMock).toHaveBeenCalledTimes(1);
    const payload = createMock.mock.calls[0][0];
    expect(payload.model).toBe('gpt-4o-mini');
    expect(payload.temperature).toBe(0.3);
    expect(payload.stream).toBe(true);

    expect(payload.messages).toHaveLength(4);
    const system = payload.messages[0];
    expect(system.role).toBe('system');
    expect(system.content).toContain(
      'You are a friendly and helpful customer support assistant for QRSong!'
    );
    expect(system.content).toContain('[SHOW_SUPPORT_BUTTON]');
    expect(system.content).toContain(
      'Relevant information:\n**Pricing**\nCards cost money.'
    );
    expect(payload.messages[1]).toEqual({
      role: 'user',
      content: 'earlier question',
    });
    expect(payload.messages[2]).toEqual({
      role: 'assistant',
      content: 'earlier answer',
    });
    expect(payload.messages[3]).toEqual({ role: 'user', content: 'How much?' });
  });

  it('injects tool results into the system prompt before streaming', async () => {
    shippingMock.getShippingInfoByCountry.mockResolvedValueOnce({
      productionDays: 2,
      productionMessage: null,
      countries: [
        { countryCode: 'DE', orderCount: 5, minDays: 2, maxDays: 6, averageDays: 4 },
      ],
    });
    createMock
      // 1st call: extractRequiredData
      .mockResolvedValueOnce(textResponse('{"countryCode":"DE"}'))
      // 2nd call: the streamed answer
      .mockResolvedValueOnce(streamOf('It takes a while.'));

    const answer = await service.answerQuestion(
      'How long to Germany?',
      ['shipping-times'],
      [],
      () => {}
    );

    expect(answer).toBe('It takes a while.');
    expect(createMock).toHaveBeenCalledTimes(2);

    const system = createMock.mock.calls[1][0].messages[0].content;
    expect(system).toContain(
      'TOOL RESULT (use this information to answer the user):'
    );
    expect(system).toContain('**Shipping estimate for DE:**');
    expect(system).toContain(
      'Relevant information:\n**Shipping times**\nDelivery estimates.'
    );
  });
});

// ---------------------------------------------------------------------------
// processQuestion (full pipeline)
// ---------------------------------------------------------------------------

describe('processQuestion', () => {
  it('saves the question, selects topics from prior history, streams and persists the answer', async () => {
    const question = 'Where is my package?';

    prismaMock.chatMessage.create
      .mockResolvedValueOnce({ id: 101 }) // user message
      .mockResolvedValueOnce({ id: 102 }); // assistant message
    prismaMock.chat.update.mockResolvedValue({});
    prismaMock.chatMessage.update.mockResolvedValue({});
    // History as persisted AFTER saving the user message
    prismaMock.chatMessage.findMany.mockResolvedValueOnce([
      { role: 'user', content: 'earlier q' },
      { role: 'admin', content: 'earlier a' },
      { role: 'user', content: question },
    ]);

    createMock.mockImplementation(async (payload: any) => {
      if (payload.stream) {
        return streamOf('Your package ', 'is on its way.');
      }
      if (payload.function_call?.name === 'selectTopics') {
        return functionCallResponse({ slugs: ['pricing'] });
      }
      // background Dutch translations
      return textResponse(`NL:${payload.messages[1].content}`);
    });

    const tokens: string[] = [];
    let searching = 0;
    await service.processQuestion(
      5,
      question,
      (t) => tokens.push(t),
      () => searching++
    );

    expect(searching).toBe(1);
    expect(tokens).toEqual(['Your package ', 'is on its way.']);

    // user + assistant messages persisted
    expect(prismaMock.chatMessage.create).toHaveBeenNthCalledWith(1, {
      data: { chatId: 5, role: 'user', content: question },
    });
    expect(prismaMock.chatMessage.create).toHaveBeenNthCalledWith(2, {
      data: {
        chatId: 5,
        role: 'assistant',
        content: 'Your package is on its way.',
      },
    });

    // Topic selection received the history WITHOUT the just-saved question
    const topicsCall = createMock.mock.calls.find(
      (c) => c[0].function_call?.name === 'selectTopics'
    )![0];
    expect(topicsCall.messages[1].content).toContain(
      'Previous conversation:\nuser: earlier q\nassistant: earlier a'
    );
    expect(topicsCall.messages[1].content).not.toContain(
      `user: ${question}`
    );
    expect(topicsCall.messages[1].content).toContain(
      `User question: ${question}`
    );

    // The streamed completion got system + 2 history items + question
    const streamCall = createMock.mock.calls.find((c) => c[0].stream)![0];
    expect(streamCall.messages.map((m: any) => m.role)).toEqual([
      'system',
      'user',
      'assistant',
      'user',
    ]);
    expect(streamCall.messages[3]).toEqual({ role: 'user', content: question });
    expect(streamCall.messages[0].content).toContain(
      'Relevant information:\n**Pricing**\nCards cost money.'
    );

    // Background Dutch translations land on both messages
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(prismaMock.chatMessage.update).toHaveBeenCalledWith({
      where: { id: 101 },
      data: { translatedContent: `NL:${question}` },
    });
    expect(prismaMock.chatMessage.update).toHaveBeenCalledWith({
      where: { id: 102 },
      data: { translatedContent: 'NL:Your package is on its way.' },
    });
  });
});
