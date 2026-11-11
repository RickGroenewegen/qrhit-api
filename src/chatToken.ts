import crypto from 'crypto';

/**
 * The secret that goes with a chat id.
 *
 * Chat ids are counted, so the id alone must open nothing: anyone could
 * join another visitor's chat by counting, read the support replies as
 * they arrived and write into it. The visitor's browser gets this token
 * once, when /chat/init makes the chat, and the socket and the chat's HTTP
 * routes ask for it. It is derived from the id, so nothing is stored.
 */
export function chatToken(chatId: number): string {
  const secret = process.env['JWT_SECRET'];
  if (!secret) throw new Error('JWT_SECRET is not set');
  return crypto.createHmac('sha256', secret).update(`chat:${chatId}`).digest('hex');
}

/** A chat id as a request may carry it: a positive whole number, or null. */
export function parseChatId(value: unknown): number | null {
  const id =
    typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

/** True when `token` is this chat's token. */
export function isChatToken(chatId: number, token: unknown): boolean {
  if (typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) return false;
  return crypto.timingSafeEqual(Buffer.from(token, 'hex'), Buffer.from(chatToken(chatId), 'hex'));
}
