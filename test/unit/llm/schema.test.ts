import { describe, it, expect } from 'vitest';
import { toAnthropicSchema } from '../../../src/llm/schema';
import { LlmRequestError } from '../../../src/llm/errors';

describe('toAnthropicSchema', () => {
  it('closes every object, nested ones and array items included', () => {
    const out: any = toAnthropicSchema({
      type: 'object',
      properties: {
        mistakes: {
          type: 'array',
          items: {
            type: 'object',
            properties: { artist: { type: 'string' }, year: { type: 'number' } },
            required: ['artist', 'year'],
          },
        },
        translations: {
          type: 'object',
          properties: { nl: { type: 'string' } },
          required: ['nl'],
        },
      },
      required: ['mistakes', 'translations'],
    });
    expect(out.additionalProperties).toBe(false);
    expect(out.properties.mistakes.items.additionalProperties).toBe(false);
    expect(out.properties.translations.additionalProperties).toBe(false);
  });

  it('turns a type list with null into anyOf, keeping the description on the wrapper', () => {
    const out: any = toAnthropicSchema({
      type: 'object',
      properties: {
        startYear: { type: ['integer', 'null'], description: 'Earliest year' },
      },
      required: ['startYear'],
    });
    expect(out.properties.startYear).toEqual({
      anyOf: [{ type: 'integer' }, { type: 'null' }],
      description: 'Earliest year',
    });
  });

  it('moves a null out of an enum into its own branch', () => {
    const out: any = toAnthropicSchema({
      type: 'object',
      properties: {
        musicMarket: { type: ['string', 'null'], enum: ['nl', 'de', 'other', null] },
      },
      required: ['musicMarket'],
    });
    expect(out.properties.musicMarket).toEqual({
      anyOf: [{ type: 'string', enum: ['nl', 'de', 'other'] }, { type: 'null' }],
    });
  });

  it('keeps integer enums and plain enums as they are', () => {
    const out: any = toAnthropicSchema({
      type: 'object',
      properties: { genreId: { type: 'integer', enum: [0, 5, 9] } },
      required: ['genreId'],
    });
    expect(out.properties.genreId).toEqual({ type: 'integer', enum: [0, 5, 9] });
  });

  it('drops length and range constraints the API rejects', () => {
    const out: any = toAnthropicSchema({
      type: 'object',
      properties: {
        segments: {
          type: 'array',
          minItems: 1,
          items: { type: 'string', maxLength: 20, description: 'max 20' },
        },
        score: { type: 'number', minimum: 0, maximum: 100 },
      },
      required: ['segments'],
    });
    expect(out.properties.segments).toEqual({
      type: 'array',
      items: { type: 'string', description: 'max 20' },
    });
    expect(out.properties.score).toEqual({ type: 'number' });
  });

  it('keeps optional properties optional', () => {
    const out: any = toAnthropicSchema({
      type: 'object',
      properties: { year: { type: 'number' }, certainty: { type: 'number' } },
      required: ['year'],
    });
    expect(out.required).toEqual(['year']);
    expect(Object.keys(out.properties)).toEqual(['year', 'certainty']);
  });

  it('puts the wrapper description on the root unless the root has one', () => {
    expect(
      (toAnthropicSchema({ type: 'object', properties: {} }, 'Split text') as any).description
    ).toBe('Split text');
    expect(
      (toAnthropicSchema({ type: 'object', description: 'own', properties: {} }, 'x') as any)
        .description
    ).toBe('own');
  });

  it('never changes its input', () => {
    const schema = {
      type: 'object',
      properties: { y: { type: ['integer', 'null'], maxLength: 3 } },
      required: ['y', 'y'],
    };
    const copy = JSON.parse(JSON.stringify(schema));
    toAnthropicSchema(schema);
    expect(schema).toEqual(copy);
  });

  it('de-duplicates required and rejects a required key that does not exist', () => {
    const out: any = toAnthropicSchema({
      type: 'object',
      properties: { a: { type: 'string' } },
      required: ['a', 'a'],
    });
    expect(out.required).toEqual(['a']);
    expect(() =>
      toAnthropicSchema({ type: 'object', properties: {}, required: ['missing'] })
    ).toThrow(LlmRequestError);
  });

  it('rejects an empty enum (a 400 at the API)', () => {
    expect(() =>
      toAnthropicSchema({
        type: 'object',
        properties: { keys: { type: 'array', items: { type: 'string', enum: [] } } },
      })
    ).toThrow(LlmRequestError);
  });

  it('is idempotent', () => {
    const once = toAnthropicSchema({
      type: 'object',
      properties: { m: { type: ['string', 'null'], enum: ['a', null] } },
      required: ['m'],
    });
    expect(toAnthropicSchema(once)).toEqual(once);
  });
});
