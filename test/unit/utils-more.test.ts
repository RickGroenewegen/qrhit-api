import {
  describe,
  it,
  expect,
  vi,
  beforeEach,
  afterEach,
} from 'vitest';
import fs from 'fs/promises';
import path from 'path';

// Extends test/unit/utils.test.ts with the parts that need mocked
// boundaries: axios (recaptcha + EC2 metadata), the EC2 SDK, maxmind and the
// Redis cache (lookupIp).

const { cacheMock, maxmindOpen, ec2Send } = vi.hoisted(() => ({
  cacheMock: {
    get: vi.fn(),
    set: vi.fn().mockResolvedValue(undefined),
    executeCommand: vi.fn().mockResolvedValue(undefined),
  },
  maxmindOpen: vi.fn(),
  ec2Send: vi.fn(),
}));

vi.mock('../../src/cache', () => ({
  default: { getInstance: () => cacheMock },
}));
vi.mock('maxmind', () => ({
  default: { open: maxmindOpen },
}));
vi.mock('@aws-sdk/client-ec2', () => {
  class EC2Client {
    send = ec2Send;
  }
  class DescribeInstancesCommand {
    input: any;
    constructor(input: any) {
      this.input = input;
    }
  }
  return { EC2Client, DescribeInstancesCommand };
});
vi.mock('axios');

import axios from 'axios';
import Utils from '../../src/utils';

const axiosGet = vi.mocked(axios.get);
const axiosPut = vi.mocked(axios.put);
const axiosPost = vi.mocked(axios.post);

const utils = new Utils();

beforeEach(() => {
  axiosGet.mockReset();
  axiosPut.mockReset();
  axiosPost.mockReset();
  cacheMock.get.mockReset();
  cacheMock.set.mockReset().mockResolvedValue(undefined);
  cacheMock.executeCommand.mockReset().mockResolvedValue(undefined);
  maxmindOpen.mockReset();
  ec2Send.mockReset();
});

describe('getRandomSample', () => {
  it('returns a copy of the whole array when sampleSize >= length', () => {
    const arr = [1, 2, 3];
    const sample = utils.getRandomSample(arr, 5);
    expect(sample).toEqual(arr);
    expect(sample).not.toBe(arr);
  });

  it('returns the requested number of distinct elements from the array', () => {
    const arr = Array.from({ length: 20 }, (_, i) => i);
    const sample = utils.getRandomSample(arr, 7);
    expect(sample).toHaveLength(7);
    expect(new Set(sample).size).toBe(7);
    for (const item of sample) {
      expect(arr).toContain(item);
    }
  });
});

describe('parseBoolean', () => {
  it('handles null/undefined as false', () => {
    expect(utils.parseBoolean(null)).toBe(false);
    expect(utils.parseBoolean(undefined)).toBe(false);
  });

  it('passes booleans through', () => {
    expect(utils.parseBoolean(true)).toBe(true);
    expect(utils.parseBoolean(false)).toBe(false);
  });

  it('treats nonzero numbers as true', () => {
    expect(utils.parseBoolean(1)).toBe(true);
    expect(utils.parseBoolean(-3)).toBe(true);
    expect(utils.parseBoolean(0)).toBe(false);
  });

  it('parses common string forms (trimmed, case-insensitive)', () => {
    expect(utils.parseBoolean(' TRUE ')).toBe(true);
    expect(utils.parseBoolean('yes')).toBe(true);
    expect(utils.parseBoolean('1')).toBe(true);
    expect(utils.parseBoolean('false')).toBe(false);
    expect(utils.parseBoolean('No')).toBe(false);
    expect(utils.parseBoolean('0')).toBe(false);
    expect(utils.parseBoolean('whatever')).toBe(false);
  });

  it('throws for unparseable types', () => {
    expect(() => utils.parseBoolean({})).toThrow(
      'Cannot parse type object to boolean'
    );
  });
});

describe('stripLocale', () => {
  it('keeps matching-locale keys (suffix stripped) and non-locale keys', () => {
    const result = utils.stripLocale(
      { title_en: 'Hi', title_nl: 'Hoi', id: 7, internal_key: 'x' },
      'en'
    );
    expect(result).toEqual({ title: 'Hi', id: 7 });
  });
});

describe('stripHtml', () => {
  it('removes all tags and attributes', () => {
    expect(
      utils.stripHtml('<p onclick="x()">Hello <b>World</b></p><script>bad()</script>')
    ).toBe('Hello World');
  });
});

describe('reviveDates', () => {
  it('revives ISO timestamp strings into Date objects', () => {
    const value = utils.reviveDates('createdAt', '2026-06-11T10:20:30.123Z');
    expect(value).toBeInstanceOf(Date);
    expect(value.toISOString()).toBe('2026-06-11T10:20:30.123Z');
  });

  it('leaves non-ISO values untouched', () => {
    expect(utils.reviveDates('k', '2026-06-11')).toBe('2026-06-11');
    expect(utils.reviveDates('k', 42)).toBe(42);
    expect(utils.reviveDates('k', null)).toBeNull();
  });
});

describe('shuffleArray', () => {
  it('returns a new array with the same elements', async () => {
    const arr = [1, 2, 3, 4, 5, 6, 7, 8];
    const shuffled = await utils.shuffleArray(arr);
    expect(shuffled).not.toBe(arr);
    expect(shuffled).toHaveLength(arr.length);
    expect([...shuffled].sort((a, b) => a - b)).toEqual(arr);
    expect(arr).toEqual([1, 2, 3, 4, 5, 6, 7, 8]); // original untouched
  });
});

describe('small helpers', () => {
  it('sleep waits roughly the requested duration', async () => {
    const start = Date.now();
    await utils.sleep(25);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });

  it('generateRandomNumber stays within the inclusive range', async () => {
    for (let i = 0; i < 100; i++) {
      const n = await utils.generateRandomNumber(3, 5);
      expect(n).toBeGreaterThanOrEqual(3);
      expect(n).toBeLessThanOrEqual(5);
      expect(Number.isInteger(n)).toBe(true);
    }
  });

  it('generateFilename slugifies to lowercase underscore form', () => {
    expect(utils.generateFilename('Héllo World! (2024)')).toBe(
      'h_llo_world_2024_'
    );
    expect(utils.generateFilename('already_ok')).toBe('already_ok');
  });

  it('generateRandomString produces alphanumerics of the right length', () => {
    expect(utils.generateRandomString()).toMatch(/^[A-Za-z0-9]{10}$/);
    expect(utils.generateRandomString(32)).toMatch(/^[A-Za-z0-9]{32}$/);
    expect(utils.generateRandomString(0)).toBe('');
  });

  it('isValidEmail accepts normal addresses and rejects malformed ones', () => {
    expect(utils.isValidEmail('a.b+c@example.co.uk')).toBe(true);
    expect(utils.isValidEmail('not-an-email')).toBe(false);
    expect(utils.isValidEmail('missing@tld')).toBe(false);
    expect(utils.isValidEmail('@example.com')).toBe(false);
  });

  it('createDir creates nested directories and swallows errors', async () => {
    const dir = path.resolve('test/.tmp/utils-more/nested/dir');
    await utils.createDir(dir);
    await expect(fs.access(dir)).resolves.toBeUndefined();
    // Invalid path: error is caught and logged, never thrown
    await expect(utils.createDir('\0bad')).resolves.toBeUndefined();
  });
});

describe('lightenColor', () => {
  it('falls back to #d8d8d8 when no color is given', () => {
    expect(utils.lightenColor(undefined, 0.5)).toBe('#d8d8d8');
    expect(utils.lightenColor('', 0.5)).toBe('#d8d8d8');
  });

  it('blends towards white by the given amount', () => {
    expect(utils.lightenColor('#000000', 0.5)).toBe('#808080');
    expect(utils.lightenColor('#000000', 1)).toBe('#ffffff');
    expect(utils.lightenColor('#ffffff', 0.3)).toBe('#ffffff');
  });

  it('accepts colors without the # prefix and pads single hex digits', () => {
    expect(utils.lightenColor('0a0b0c', 0)).toBe('#0a0b0c');
  });
});

describe('verifyRecaptcha', () => {
  it('accepts a successful verification above the score threshold', async () => {
    axiosPost.mockResolvedValue({ data: { success: true, score: 0.9 } });
    expect(await utils.verifyRecaptcha('tok')).toEqual({
      isHuman: true,
      score: 0.9,
    });
    expect(axiosPost).toHaveBeenCalledWith(
      expect.stringContaining('response=tok')
    );
  });

  it('rejects when the score is below the (custom) threshold', async () => {
    axiosPost.mockResolvedValue({ data: { success: true, score: 0.4 } });
    expect(await utils.verifyRecaptcha('tok')).toEqual({
      isHuman: false,
      score: 0.4,
    });
    expect(await utils.verifyRecaptcha('tok', 0.3)).toEqual({
      isHuman: true,
      score: 0.4,
    });
  });

  it('rejects when Google says success=false (score null)', async () => {
    axiosPost.mockResolvedValue({ data: { success: false } });
    expect(await utils.verifyRecaptcha('tok')).toEqual({
      isHuman: false,
      score: null,
    });
  });

  it('fails closed when the verify call throws', async () => {
    axiosPost.mockRejectedValue(new Error('network'));
    expect(await utils.verifyRecaptcha('tok')).toEqual({
      isHuman: false,
      score: null,
    });
  });
});

describe('isSpam', () => {
  it('flags a filled honeypot field', () => {
    expect(utils.isSpam({ honeypot: 'bot was here' })).toEqual({
      isSpam: true,
      reason: 'Honeypot field filled',
    });
  });

  it('flags random-string names with a low vowel ratio', () => {
    const result = utils.isSpam({ name: 'vSCqxLSfwSyYpRClYfd' });
    expect(result.isSpam).toBe(true);
    expect(result.reason).toContain('low vowel ratio');
  });

  it('flags names with suspicious alternating case', () => {
    const result = utils.isSpam({ name: 'aBaBaBaBe' });
    expect(result.isSpam).toBe(true);
    expect(result.reason).toBe('Name has suspicious case pattern');
  });

  it('flags names made only of digits/special characters', () => {
    expect(utils.isSpam({ name: '12345' })).toEqual({
      isSpam: true,
      reason: 'Name contains only numbers/special characters',
    });
  });

  it('flags high-entropy gibberish messages', () => {
    const result = utils.isSpam({
      name: 'John Doe',
      message: 'qwertzuiopasdfghjklyxcvbnm1234',
    });
    expect(result.isSpam).toBe(true);
    expect(result.reason).toBe('Message appears to be random gibberish');
  });

  it('flags messages with repeated patterns', () => {
    const result = utils.isSpam({
      name: 'John Doe',
      message: 'buy nowbuy nowbuy now today',
    });
    expect(result.isSpam).toBe(true);
    expect(result.reason).toBe('Message contains repeated patterns');
  });

  it('passes a normal submission', () => {
    expect(
      utils.isSpam({
        name: 'Maria Janssen',
        email: 'maria@example.com',
        message: 'Hello, I would like to know when my order will arrive.',
      })
    ).toEqual({ isSpam: false, reason: null });
  });
});

describe('replaceBrandTerms', () => {
  it('returns an empty string for null/undefined input', () => {
    expect(utils.replaceBrandTerms(null)).toBe('');
    expect(utils.replaceBrandTerms(undefined)).toBe('');
  });

  it('replaces the default brand terms case-insensitively', () => {
    expect(
      utils.replaceBrandTerms('I love hitster, HITSTAR and disney songs')
    ).toBe('I love QRSong!, QRSong! and Cartoon songs');
  });

  it('accepts a custom replacement mapping', () => {
    expect(utils.replaceBrandTerms('Foo bar FOO', { foo: 'baz' })).toBe(
      'baz bar baz'
    );
  });
});

describe('lookupIp', () => {
  beforeEach(() => {
    // Reset the static maxmind reader between tests
    (Utils as any).maxmindReader = null;
  });

  it('returns the cached lookup without touching maxmind', async () => {
    cacheMock.get.mockResolvedValue(JSON.stringify({ ip: '1.2.3.4', city: 'X' }));
    expect(await utils.lookupIp('1.2.3.4')).toEqual({ ip: '1.2.3.4', city: 'X' });
    expect(maxmindOpen).not.toHaveBeenCalled();
  });

  it('transforms a maxmind hit into the ipapi.co shape and caches it', async () => {
    cacheMock.get.mockResolvedValue(null);
    const geo = {
      city: { names: { en: 'Amsterdam' } },
      subdivisions: [{ names: { en: 'North Holland' }, iso_code: 'NH' }],
      country: { names: { en: 'Netherlands' }, iso_code: 'NL', is_in_european_union: true },
      continent: { code: 'EU' },
      postal: { code: '1011' },
      location: { latitude: 52.37, longitude: 4.89, time_zone: 'Europe/Amsterdam' },
    };
    maxmindOpen.mockResolvedValue({ get: vi.fn().mockReturnValue(geo) });

    const data = await utils.lookupIp('85.85.85.85');
    expect(data).toEqual({
      ip: '85.85.85.85',
      city: 'Amsterdam',
      region: 'North Holland',
      region_code: 'NH',
      country: 'Netherlands',
      country_code: 'NL',
      country_name: 'Netherlands',
      continent_code: 'EU',
      postal: '1011',
      latitude: 52.37,
      longitude: 4.89,
      timezone: 'Europe/Amsterdam',
      in_eu: true,
    });
    expect(cacheMock.set).toHaveBeenCalledWith(
      'ipLookup:85.85.85.85',
      JSON.stringify(data),
      86400
    );
    expect(cacheMock.executeCommand).toHaveBeenCalledWith(
      'lpush',
      'ipInfoList',
      JSON.stringify(data)
    );
    expect(cacheMock.executeCommand).toHaveBeenCalledWith(
      'ltrim',
      'ipInfoList',
      0,
      99
    );
  });

  it('returns null fields when maxmind has no data for the IP', async () => {
    cacheMock.get.mockResolvedValue(null);
    maxmindOpen.mockResolvedValue({ get: vi.fn().mockReturnValue(null) });
    const data = await utils.lookupIp('10.0.0.1');
    expect(data).toMatchObject({
      ip: '10.0.0.1',
      city: null,
      country_code: null,
      in_eu: false,
    });
  });

  it('reuses the static reader on subsequent lookups', async () => {
    cacheMock.get.mockResolvedValue(null);
    maxmindOpen.mockResolvedValue({ get: vi.fn().mockReturnValue(null) });
    await utils.lookupIp('10.0.0.1');
    await utils.lookupIp('10.0.0.2');
    expect(maxmindOpen).toHaveBeenCalledTimes(1);
  });

  it('returns null when the maxmind database cannot be opened', async () => {
    cacheMock.get.mockResolvedValue(null);
    maxmindOpen.mockRejectedValue(new Error('mmdb missing'));
    expect(await utils.lookupIp('10.0.0.1')).toBeNull();
  });
});

describe('EC2 metadata helpers', () => {
  const ENV_KEYS = ['AWS_EC2_DESCRIBE_KEY_ID', 'AWS_EC2_DESCRIBE_SECRET_ID'];
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function mockImds({ instanceId = 'i-abc123', az = 'eu-west-1a' } = {}) {
    axiosPut.mockResolvedValue({ data: 'imds-token' });
    axiosGet.mockImplementation(async (url: string) => {
      if (url.includes('instance-id')) return { data: instanceId };
      if (url.includes('availability-zone')) return { data: az };
      throw new Error(`unexpected url ${url}`);
    });
  }

  it('isMainServer is false when the EC2 describe keys are not configured', async () => {
    expect(await utils.isMainServer()).toBe(false);
    expect(axiosPut).not.toHaveBeenCalled();
  });

  it('getInstanceId fetches an IMDSv2 token and then the instance id', async () => {
    mockImds();
    expect(await utils.getInstanceId()).toBe('i-abc123');
    expect(axiosPut).toHaveBeenCalledWith(
      'http://169.254.169.254/latest/api/token',
      null,
      expect.objectContaining({
        headers: { 'X-aws-ec2-metadata-token-ttl-seconds': '21600' },
      })
    );
    expect(axiosGet).toHaveBeenCalledWith(
      'http://169.254.169.254/latest/meta-data/instance-id',
      expect.objectContaining({
        headers: { 'X-aws-ec2-metadata-token': 'imds-token' },
      })
    );
  });

  it('getInstanceId returns "" for 404/401 metadata responses', async () => {
    axiosPut.mockResolvedValue({ data: 'tok' });
    axiosGet.mockRejectedValue({ response: { status: 404 } });
    expect(await utils.getInstanceId()).toBe('');
    axiosGet.mockRejectedValue({ response: { status: 401 } });
    expect(await utils.getInstanceId()).toBe('');
  });

  it('getInstanceId rethrows unexpected errors', async () => {
    axiosPut.mockResolvedValue({ data: 'tok' });
    axiosGet.mockRejectedValue(new Error('boom'));
    await expect(utils.getInstanceId()).rejects.toThrow('boom');
  });

  it('getInstanceId rethrows token retrieval failures', async () => {
    axiosPut.mockRejectedValue(new Error('imds down'));
    await expect(utils.getInstanceId()).rejects.toThrow('imds down');
  });

  it('getRegion strips the AZ letter, and rethrows failures', async () => {
    mockImds({ az: 'us-east-2c' });
    expect(await utils.getRegion()).toBe('us-east-2');

    axiosGet.mockRejectedValue(new Error('no az'));
    await expect(utils.getRegion()).rejects.toThrow('no az');
  });

  it('getInstanceName returns undefined when there is no instance id', async () => {
    axiosPut.mockResolvedValue({ data: 'tok' });
    axiosGet.mockRejectedValue({ response: { status: 404 } });
    expect(await utils.getInstanceName()).toBeUndefined();
    expect(ec2Send).not.toHaveBeenCalled();
  });

  it('getInstanceName throws when describe credentials are missing', async () => {
    mockImds();
    await expect(utils.getInstanceName()).rejects.toThrow(
      'AWS credentials are not set in the environment variables'
    );
  });

  it('getInstanceName resolves the Name tag via DescribeInstances', async () => {
    process.env['AWS_EC2_DESCRIBE_KEY_ID'] = 'key';
    process.env['AWS_EC2_DESCRIBE_SECRET_ID'] = 'secret';
    mockImds();
    ec2Send.mockResolvedValue({
      Reservations: [
        {
          Instances: [
            { Tags: [{ Key: 'Env', Value: 'prod' }, { Key: 'Name', Value: 'WS1' }] },
          ],
        },
      ],
    });
    expect(await utils.getInstanceName()).toBe('WS1');
    expect(ec2Send.mock.calls[0][0].input).toEqual({
      InstanceIds: ['i-abc123'],
    });
  });

  it('getInstanceName returns undefined when no reservations/tags exist', async () => {
    process.env['AWS_EC2_DESCRIBE_KEY_ID'] = 'key';
    process.env['AWS_EC2_DESCRIBE_SECRET_ID'] = 'secret';
    mockImds();
    ec2Send.mockResolvedValue({ Reservations: [] });
    expect(await utils.getInstanceName()).toBeUndefined();
  });

  it('getInstanceName rethrows DescribeInstances errors', async () => {
    process.env['AWS_EC2_DESCRIBE_KEY_ID'] = 'key';
    process.env['AWS_EC2_DESCRIBE_SECRET_ID'] = 'secret';
    mockImds();
    ec2Send.mockRejectedValue(new Error('AccessDenied'));
    await expect(utils.getInstanceName()).rejects.toThrow('AccessDenied');
  });

  it('isMainServer is true only when the instance Name tag is WS1', async () => {
    process.env['AWS_EC2_DESCRIBE_KEY_ID'] = 'key';
    process.env['AWS_EC2_DESCRIBE_SECRET_ID'] = 'secret';
    mockImds();
    ec2Send.mockResolvedValue({
      Reservations: [{ Instances: [{ Tags: [{ Key: 'Name', Value: 'WS1' }] }] }],
    });
    expect(await utils.isMainServer()).toBe(true);

    ec2Send.mockResolvedValue({
      Reservations: [{ Instances: [{ Tags: [{ Key: 'Name', Value: 'WS2' }] }] }],
    });
    expect(await utils.isMainServer()).toBe(false);
  });
});
