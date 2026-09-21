import { describe, it, expect } from 'vitest';
import { extractPrintErrorMessage } from '../../../src/printers/printErrorMessage';

describe('extractPrintErrorMessage()', () => {
  it('returns null for empty, unparsable or non-object input', () => {
    expect(extractPrintErrorMessage(null)).toBeNull();
    expect(extractPrintErrorMessage('')).toBeNull();
    expect(extractPrintErrorMessage('not json')).toBeNull();
    expect(extractPrintErrorMessage('"a string"')).toBeNull();
  });

  it('reads a legacy API refusal, which comes back as HTTP 200 with result false', () => {
    const response = JSON.stringify({
      apiCalls: [
        {
          method: 'POST',
          url: 'https://www.printenbind.nl/api/v1/orders/articles',
          statusCode: 200,
          responseBody: {
            error: 'You are not allowed to use the API.',
            statuscode: '403',
            result: false,
          },
        },
      ],
    });
    expect(extractPrintErrorMessage(response)).toBe(
      'You are not allowed to use the API.'
    );
  });

  it('skips successful calls and reads the first REST API error', () => {
    const response = JSON.stringify({
      apiCalls: [
        { statusCode: 201, responseBody: { id: 1 } },
        { statusCode: 422, responseBody: { message: 'Invalid postal code' } },
        { statusCode: 500, responseBody: { message: 'Later error' } },
      ],
    });
    expect(extractPrintErrorMessage(response)).toBe('Invalid postal code');
  });

  it('falls back to the status code when the error body has no text', () => {
    const response = JSON.stringify({
      apiCalls: [{ statusCode: 502, responseBody: {} }],
    });
    expect(extractPrintErrorMessage(response)).toBe('HTTP 502');
  });

  it('reads a plain-text error body', () => {
    const response = JSON.stringify({
      apiCalls: [{ statusCode: 503, responseBody: 'Service unavailable' }],
    });
    expect(extractPrintErrorMessage(response)).toBe('Service unavailable');
  });

  it('uses the top-level error when no call failed', () => {
    const response = JSON.stringify({
      apiCalls: [],
      error: 'No order items to send',
    });
    expect(extractPrintErrorMessage(response)).toBe('No order items to send');
  });

  it('returns null for a successful order', () => {
    const response = JSON.stringify({
      apiCalls: [{ statusCode: 201, responseBody: { id: 9 } }],
      id: 9,
    });
    expect(extractPrintErrorMessage(response)).toBeNull();
  });
});
