import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  vi,
} from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';
import { resetDb, seedBaseline, prisma } from '../helpers/db';
import { flushTestRedis } from '../helpers/redis';
import { createTestUser, authHeader } from '../helpers/auth';
import Utils from '../../src/utils';

/**
 * Support chat (public + admin).
 */
describe('chat routes', () => {
  let app: FastifyInstance;
  let adminHeaders: Record<string, string>;
  let chatId: number;

  beforeAll(async () => {
    vi.spyOn(Utils.prototype, 'verifyRecaptcha').mockResolvedValue({
      isHuman: true,
      score: 0.9,
    } as any);
    app = await buildTestApp();
    await resetDb();
    await seedBaseline();
    await flushTestRedis();
    const admin = await createTestUser({ groups: ['admin'] });
    adminHeaders = authHeader(admin.token);
  });

  afterAll(async () => {
    await closeTestApp(app);
    vi.restoreAllMocks();
  });

  describe('public chat endpoints', () => {
    it('rejects an invalid email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/chat/init',
        payload: { email: 'nope', recaptchaToken: 'tok' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('rejects when the captcha fails', async () => {
      (Utils.prototype.verifyRecaptcha as any).mockResolvedValueOnce({
        isHuman: false,
        score: 0,
      });
      const res = await app.inject({
        method: 'POST',
        url: '/chat/init',
        payload: { email: 'chatter@test.qrsong.io', recaptchaToken: 'tok' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('creates a chat session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/chat/init',
        payload: { email: 'chatter@test.qrsong.io', recaptchaToken: 'tok' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.success).toBe(true);
      expect(body.username).toBe('chatter');
      expect(body.hasMessages).toBe(false);
      chatId = body.chatId;
    });

    it('resumes an existing chat session', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/chat/init',
        payload: {
          email: 'chatter@test.qrsong.io',
          recaptchaToken: 'tok',
          existingChatId: chatId,
        },
      });
      const body = res.json();
      expect(body.chatId).toBe(chatId);
      expect(body.hijacked).toBe(false);
    });

    it('signals a deleted chat on resume', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/chat/init',
        payload: {
          email: 'chatter@test.qrsong.io',
          recaptchaToken: 'tok',
          existingChatId: 999999,
        },
      });
      expect(res.json().chatDeleted).toBe(true);
    });

    it('marks a chat as needing support (pushover mocked)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/chat/support-needed',
        payload: { chatId },
      });
      expect(res.statusCode).toBe(200);
      const chat = await prisma().chat.findUnique({ where: { id: chatId } });
      expect(chat!.supportNeeded).toBe(true);
    });

    it('requires a chat id to clear', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/chat/clear',
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('admin chat endpoints', () => {
    beforeAll(async () => {
      await prisma().chatMessage.create({
        data: { chatId, role: 'user', content: 'Waar blijft mijn bestelling?' },
      });
    });

    it('lists chats that have messages', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/chats',
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data).toHaveLength(1);
      expect(data[0].id).toBe(chatId);
      expect(data[0].messageCount).toBe(1);
    });

    it('counts chats with unseen messages', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/chats/support-count',
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      expect(res.json().count).toBe(1);
    });

    it('returns the messages of a chat', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/chats/${chatId}/messages`,
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      const { data } = res.json();
      expect(data.messages).toHaveLength(1);
      expect(data.messages[0].content).toBe('Waar blijft mijn bestelling?');
    });

    it('404s messages of an unknown chat', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/chats/999999/messages',
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(404);
    });

    it('marks a chat as seen and drops it from the unseen count', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/chats/${chatId}/mark-seen`,
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      const count = await app.inject({
        method: 'GET',
        url: '/admin/chats/support-count',
        headers: adminHeaders,
      });
      expect(count.json().count).toBe(0);
    });

    it('validates the hijack flag', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/chats/${chatId}/hijack`,
        headers: adminHeaders,
        payload: { hijacked: 'yes' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('toggles hijack', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/chats/${chatId}/hijack`,
        headers: adminHeaders,
        payload: { hijacked: true },
      });
      expect(res.statusCode).toBe(200);
      const chat = await prisma().chat.findUnique({ where: { id: chatId } });
      expect(chat!.hijacked).toBe(true);
    });

    it('toggles support-needed off', async () => {
      const res = await app.inject({
        method: 'POST',
        url: `/admin/chats/${chatId}/support-needed`,
        headers: adminHeaders,
        payload: { supportNeeded: false },
      });
      expect(res.statusCode).toBe(200);
      const chat = await prisma().chat.findUnique({ where: { id: chatId } });
      expect(chat!.supportNeeded).toBe(false);
    });

    it('clears the chat for the user (soft delete)', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/chat/clear',
        payload: { chatId },
      });
      expect(res.statusCode).toBe(200);
      const messages = await prisma().chatMessage.findMany({
        where: { chatId },
      });
      expect(messages.every((m) => m.visibleToUser === false)).toBe(true);
    });

    it('deletes a chat with its messages', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/admin/chats/${chatId}`,
        headers: adminHeaders,
      });
      expect(res.statusCode).toBe(200);
      const chat = await prisma().chat.findUnique({ where: { id: chatId } });
      expect(chat).toBeNull();
    });
  });
});
