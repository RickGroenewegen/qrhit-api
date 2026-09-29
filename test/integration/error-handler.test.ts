import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { FastifyInstance } from 'fastify';
import { buildTestApp, closeTestApp } from '../helpers/app';

describe('global error handler', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildTestApp();
  });

  afterAll(async () => {
    await closeTestApp(app);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('answers a static-file 403 with 403 and logs one line, not a stack trace', async () => {
    // @fastify/static refuses non-canonical paths (`//`, `..`, `/./`);
    // this used to come back as a 500 with the full error printed.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.inject({ method: 'GET', url: '/public//x.png' });

    expect(res.statusCode).toBe(403);
    expect(res.json()).toEqual({ error: 'Forbidden' });
    expect(error).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith('403 GET /public//x.png: Forbidden');
  });

  it('answers malformed JSON with 400 instead of 500', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await app.inject({
      method: 'POST',
      url: '/contact',
      headers: { 'content-type': 'application/json' },
      payload: '{not json',
    });

    expect(res.statusCode).toBe(400);
    expect(error).not.toHaveBeenCalled();
  });
});
