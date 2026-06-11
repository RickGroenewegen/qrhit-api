import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import Templates from '../../src/templates';

// Templates reads from `${APP_ROOT}/templates`, so point APP_ROOT at a
// scratch root with our own fixture templates + partials.
const SCRATCH_ROOT = path.resolve('test/.tmp/templates-fixture');
const EMPTY_ROOT = path.resolve('test/.tmp/templates-empty');
const origAppRoot = process.env['APP_ROOT'];

const templates = new Templates();

beforeAll(async () => {
  const partialsDir = path.join(SCRATCH_ROOT, 'templates', 'mails', 'partials');
  await fs.mkdir(partialsDir, { recursive: true });
  await fs.mkdir(path.join(EMPTY_ROOT, 'templates'), { recursive: true });

  await fs.writeFile(
    path.join(partialsDir, 'greeting.hbs'),
    'Welcome, {{name}}.'
  );
  // Non-.hbs files in the partials dir must be ignored
  await fs.writeFile(path.join(partialsDir, 'notes.txt'), 'not a partial');

  await fs.writeFile(
    path.join(SCRATCH_ROOT, 'templates', 'fixture.hbs'),
    [
      '{{> greeting}}',
      'Date: {{formatDate date}}',
      'Amount: {{formatCurrency amount}}',
      'Decimal: {{formatDecimal num 3}}',
      '{{#if (gt a b)}}BIG{{else}}SMALL{{/if}}',
    ].join('\n')
  );
});

afterAll(() => {
  process.env['APP_ROOT'] = origAppRoot;
});

describe('Templates.render', () => {
  it('rejects when the template file does not exist (and tolerates a missing partials dir)', async () => {
    // EMPTY_ROOT has no mails/partials directory: registerPartials must
    // swallow that, and the missing template itself must reject.
    process.env['APP_ROOT'] = EMPTY_ROOT;
    await expect(templates.render('does-not-exist', {})).rejects.toThrow();
  });

  it('renders a template with partials and all registered helpers', async () => {
    process.env['APP_ROOT'] = SCRATCH_ROOT;
    const html = await templates.render('fixture', {
      name: 'Rick',
      date: '2026-03-05T12:00:00',
      amount: '12.5',
      num: '3.14159',
      a: 2,
      b: 1,
    });
    expect(html).toContain('Welcome, Rick.');
    expect(html).toContain('Date: March 5, 2026');
    // formatCurrency: two decimals, comma separator
    expect(html).toContain('Amount: 12,50');
    // formatDecimal: fixed number of decimals
    expect(html).toContain('Decimal: 3.142');
    // gt helper: 2 > 1
    expect(html).toContain('BIG');
    expect(html).not.toContain('SMALL');
  });

  it('gt helper returns false for equal values', async () => {
    process.env['APP_ROOT'] = SCRATCH_ROOT;
    const html = await templates.render('fixture', {
      name: 'x',
      date: '2026-01-01T12:00:00',
      amount: '0',
      num: '1',
      a: 1,
      b: 1,
    });
    expect(html).toContain('SMALL');
    expect(html).toContain('January 1, 2026');
    expect(html).toContain('Amount: 0,00');
  });
});
