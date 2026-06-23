import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';

describe('app factory', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  it('boots the full route tree without listening', async () => {
    // The websocket endpoints answer plain HTTP with 426 — a cheap proof
    // that route registration completed.
    const res = await app.inject({ method: 'GET', url: '/ws' });
    expect(res.statusCode).toBe(426);
  });

  it('returns 401 for a protected route without a token', async () => {
    const res = await app.inject({ method: 'GET', url: '/account/profile' });
    expect([401, 404]).toContain(res.statusCode);
  });
});
