import sanitizeHtml from 'sanitize-html';
import { promises as fs } from 'fs';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import axios from 'axios';
import parser from 'accept-language-parser';
import Translation from './translation';
import Cache from './cache';
import maxmind, { CityResponse, Reader } from 'maxmind';
import path from 'path';

class Utils {
  private translation: Translation = new Translation();
  private static maxmindReader: Reader<CityResponse> | null = null;

  /**
   * Get a random sample of elements from an array
   * @param array The array to sample from
   * @param sampleSize The number of elements to sample
   * @returns A random sample of the specified size
   */
  public getRandomSample<T>(array: T[], sampleSize: number): T[] {
    if (sampleSize >= array.length) return [...array];

    const result = new Array<T>(sampleSize);
    const len = array.length;
    const taken = new Set<number>();

    while (result.filter(Boolean).length < sampleSize) {
      const randomIndex = Math.floor(Math.random() * len);
      if (!taken.has(randomIndex)) {
        result[result.filter(Boolean).length] = array[randomIndex];
        taken.add(randomIndex);
      }
    }

    return result;
  }

  public async isMainServer(): Promise<boolean> {
    const isAWS =
      process.env['AWS_EC2_DESCRIBE_KEY_ID'] &&
      process.env['AWS_EC2_DESCRIBE_SECRET_ID'];
    if (isAWS) {
      return (await this.getInstanceName()) == 'WS1';
    }
    return false;
  }

  public isTrustedIp(ip: string): boolean {
    if (
      process.env['TRUSTED_IPS'] &&
      process.env['TRUSTED_IPS'].split(',').includes(ip)
    ) {
      return true;
    } else {
      return false;
    }
  }

  public isTrustedEmail(email: string): boolean {
    if (
      process.env['TRUSTED_EMAILS'] &&
      process.env['TRUSTED_EMAILS'].split(',').includes(email)
    ) {
      return true;
    } else {
      return false;
    }
  }

  public cleanTrackName(name: string): string {
    let str = name;

    // Some titles are like "Track Name - Remastered". We want to remove the "- Remastered" part. If there is a " - " in the title, we remove everything after it.
    if (str.includes(' - ')) {
      str = str.split(' - ')[0];
    }

    // Remove "(feat. ...)" from the title
    str = str.replace(/\(feat\..*?\)/gi, '').trim();

    // Remove (Remastered) from the title
    str = str.replace(/\(Remastered\)/gi, '').trim();

    // Remove (Re-recorded) from the title
    str = str.replace(/\(Re-recorded\)/gi, '').trim();

    // Remove (Classic Version) from the title
    str = str.replace(/\(Classic Version\)/gi, '').trim();

    // Remove (From "...") from the title (e.g., From "Pretty Woman")
    str = str.replace(/\(From\s+[""].*?[""]\)/gi, '').trim();

    // Remove video-related tags (Official Video, Official Music Video, Official HD Video, Official 4K Video)
    str = str.replace(/\(Official\s*(Music\s*)?Video\)/gi, '').trim();
    str = str.replace(/\(Official\s*(HD|4K)\s*Video\)/gi, '').trim();

    // Title can be max. 70 characters. Add "..." if it's longer (do this last after all cleaning)
    if (str.length > 70) {
      str = str.substring(0, 67) + '...';
    }

    return str;
  }

  public async verifyRecaptcha(token: string, minScore: number = 0.5): Promise<{ isHuman: boolean; score: number | null }> {
    try {
      const secretKey = process.env['RECAPTCHA_SECRET_KEY'];
      const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${secretKey}&response=${token}`;
      const response = await axios.post(verifyUrl);
      const { success, score } = response.data;
      return { isHuman: success && score >= minScore, score: score ?? null };
    } catch (error) {
      return { isHuman: false, score: null };
    }
  }

  public parseAcceptLanguage(header: string) {
    const languages = parser.parse(header);
    let lang = 'en';
    // if no languages are found, return 'en'. Otherwise, return the first language
    if (languages?.length > 0) {
      lang = languages[0].code;
    }
    // Check if the language is supported
    if (this.translation.isValidLocale(lang)) {
      return lang;
    } else {
      return 'en';
    }
  }

  private async getIMDSToken(): Promise<string> {
    try {
      const tokenResponse = await axios.put(
        'http://169.254.169.254/latest/api/token',
        null,
        {
          headers: {
            'X-aws-ec2-metadata-token-ttl-seconds': '21600', // Token valid for 6 hours
          },
        }
      );

      return tokenResponse.data;
    } catch (error) {
      console.error('Unable to retrieve IMDSv2 token:', error);
      throw error;
    }
  }

  public async getInstanceId(): Promise<string> {
    try {
      const token = await this.getIMDSToken();
      const response = await axios.get(
        'http://169.254.169.254/latest/meta-data/instance-id',
        {
          headers: {
            'X-aws-ec2-metadata-token': token,
          },
        }
      );

      return response.data;
    } catch (error: any) {
      if (
        error.response &&
        (error.response.status === 404 || error.response.status === 401)
      ) {
        console.error(
          'Not running on AWS or unable to retrieve instance metadata:',
          error
        );
        return '';
      }
      throw error; // rethrow if it's a different error
    }
  }

  public async getRegion(): Promise<string> {
    try {
      const token = await this.getIMDSToken();
      const response = await axios.get(
        'http://169.254.169.254/latest/meta-data/placement/availability-zone',
        {
          headers: {
            'X-aws-ec2-metadata-token': token,
          },
        }
      );
      const availabilityZone = response.data;
      // The region is the availability zone without the last character
      return availabilityZone.slice(0, -1);
    } catch (error) {
      console.error('Unable to retrieve region from instance metadata:', error);
      throw error;
    }
  }

  public async getInstanceName(): Promise<string | undefined> {
    const instanceId = await this.getInstanceId();
    if (!instanceId) {
      return undefined;
    }
    const region = await this.getRegion();

    // Read custom environment variables
    const accessKeyId = process.env.AWS_EC2_DESCRIBE_KEY_ID;
    const secretAccessKey = process.env.AWS_EC2_DESCRIBE_SECRET_ID;

    if (!accessKeyId || !secretAccessKey) {
      throw new Error(
        'AWS credentials are not set in the environment variables'
      );
    }
    const client = new EC2Client({
      region,
      credentials: {
        accessKeyId,
        secretAccessKey,
      },
    });

    const command = new DescribeInstancesCommand({
      InstanceIds: [instanceId],
    });

    try {
      const response = await client.send(command);
      const reservations = response.Reservations;
      if (reservations && reservations.length > 0) {
        const instances = reservations[0].Instances;
        if (instances && instances.length > 0) {
          const tags = instances[0].Tags;
          if (tags) {
            const nameTag = tags.find((tag) => tag.Key === 'Name');
            return nameTag?.Value;
          }
        }
      }
    } catch (error) {
      console.error('Error retrieving instance name:', error);
      throw error;
    }
    return undefined;
  }

  public stripLocale(obj: any, locale: string): any {
    const result: any = {};
    const localeSuffix = `_${locale}`;

    // Iterate over the object keys
    for (const key of Object.keys(obj)) {
      // Check if the key ends with the locale suffix
      if (key.endsWith(localeSuffix)) {
        // Remove the locale part from the key and add it to the result object
        const newKey = key.replace(localeSuffix, '');
        result[newKey] = obj[key];
      } else if (!key.includes('_')) {
        // If the key doesn't contain '_', it's not locale-specific and should be copied as is
        result[key] = obj[key];
      }
      // Locale-specific keys that do not match the specified locale are ignored
    }

    return result;
  }

  public parseBoolean(value: any): boolean {
    if (value === null || value === undefined) {
      return false;
    }

    if (typeof value === 'boolean') {
      return value;
    }

    if (typeof value === 'number') {
      return value !== 0;
    }

    if (typeof value === 'string') {
      const normalizedString = value.trim().toLowerCase();
      switch (normalizedString) {
        case 'true':
        case 'yes':
        case '1':
          return true;
        case 'false':
        case 'no':
        case '0':
          return false;
        default:
          return false; // Default to false for unrecognized string values
      }
    }

    throw new Error(`Cannot parse type ${typeof value} to boolean`);
  }

  public stripHtml(dirtyHtml: string): string {
    const clean = sanitizeHtml(dirtyHtml, {
      allowedTags: [], // No tags allowed, stripping all
      allowedAttributes: {}, // No attributes allowed
    });
    return clean;
  }

  public async createDir(dirPath: string): Promise<void> {
    try {
      await fs.mkdir(dirPath, { recursive: true });
    } catch (error) {
      console.error(`Error creating directory: ${error}`);
    }
  }

  public reviveDates(key: any, value: any): any {
    const isISODate =
      typeof value === 'string' &&
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}.\d{3}Z$/.test(value);
    if (isISODate) {
      return new Date(value);
    }
    return value;
  }

  public async shuffleArray<T>(array: T[]): Promise<T[]> {
    const shuffledArray = [...array]; // Create a copy of the original array

    for (let i = shuffledArray.length - 1; i > 0; i--) {
      // Generate a random index between 0 and i (inclusive)
      const randomIndex = Math.floor(Math.random() * (i + 1));

      // Swap elements at randomIndex and i
      const temp = shuffledArray[i];
      shuffledArray[i] = shuffledArray[randomIndex];
      shuffledArray[randomIndex] = temp;
    }

    return shuffledArray;
  }

  public async sleep(duration: number) {
    return new Promise((resolve) => {
      setTimeout(resolve, duration);
    });
  }

  public async generateRandomNumber(min: number, max: number): Promise<number> {
    return Math.floor(Math.random() * (max - min + 1)) + min;
  }
  public generateFilename(name: string): string {
    return name
      .replace(/[^a-zA-Z0-9]/g, '_')
      .replace(/_+/g, '_')
      .toLowerCase();
  }

  public generateRandomString(length: number = 10): string {
    const characters =
      'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let result = '';

    for (let i = 0; i < length; i++) {
      const randomIndex = Math.floor(Math.random() * characters.length);
      result += characters[randomIndex];
    }

    return result;
  }

  public isValidEmail(email: string): boolean {
    const emailRegex = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
    return emailRegex.test(email);
  }

  /**
   * Initialize the MaxMind database reader
   */
  private async initMaxMind(): Promise<void> {
    if (Utils.maxmindReader) {
      return; // Already initialized
    }

    try {
      const dbPath = path.join(process.env['PRIVATE_DIR']!, 'ip', 'GeoLite2-City.mmdb');
      Utils.maxmindReader = await maxmind.open<CityResponse>(dbPath);
    } catch (error) {
      console.error('Error initializing MaxMind database:', error);
      throw error;
    }
  }

  /**
   * Lookup IP address information using MaxMind GeoLite2-City database
   * @param ip IP address to lookup
   * @returns IP information in ipapi.co compatible format
   */
  public async lookupIp(ip: string): Promise<any> {
    const cache = Cache.getInstance();
    const cacheKey = `ipLookup:${ip}`;
    const cachedResult = await cache.get(cacheKey);

    if (cachedResult) {
      return JSON.parse(cachedResult);
    }

    try {
      let ipToCheck = ip;

      if (process.env['ENVIRONMENT'] === 'development') {
        ipToCheck = '85.145.135.140';
      }

      // Initialize MaxMind if not already done
      if (!Utils.maxmindReader) {
        await this.initMaxMind();
      }

      // Get geo data from MaxMind
      const geoData = Utils.maxmindReader!.get(ipToCheck);

      // Transform MaxMind response to match ipapi.co format
      const data = {
        ip: ipToCheck,
        city: geoData?.city?.names?.en || null,
        region: geoData?.subdivisions?.[0]?.names?.en || null,
        region_code: geoData?.subdivisions?.[0]?.iso_code || null,
        country: geoData?.country?.names?.en || null,
        country_code: geoData?.country?.iso_code || null,
        country_name: geoData?.country?.names?.en || null,
        continent_code: geoData?.continent?.code || null,
        postal: geoData?.postal?.code || null,
        latitude: geoData?.location?.latitude || null,
        longitude: geoData?.location?.longitude || null,
        timezone: geoData?.location?.time_zone || null,
        in_eu: geoData?.country?.is_in_european_union || false,
      };

      await cache.set(cacheKey, JSON.stringify(data), 86400); // Cache individual IP info for 1 day

      // Store the IP info in a list and maintain only the last 100 entries
      const ipInfoListKey = 'ipInfoList';
      await cache.executeCommand('lpush', ipInfoListKey, JSON.stringify(data));
      await cache.executeCommand('ltrim', ipInfoListKey, 0, 99); // Keep only the last 100 entries
      return data;
    } catch (error) {
      console.error(`Error looking up IP ${ip}:`, error);
      return null;
    }
  }

  /**
   * Lighten a hex color by blending it with white
   * @param hexColor Hex color code (e.g., '#000000' or '000000')
   * @param amount Amount to lighten (0-1, where 1 is pure white)
   * @returns Lightened hex color
   */
  public lightenColor(hexColor: string | undefined, amount: number): string {
    if (!hexColor) return '#d8d8d8';

    // Remove # if present
    const color = hexColor.replace('#', '');

    // Convert to RGB
    let r = parseInt(color.substring(0, 2), 16);
    let g = parseInt(color.substring(2, 4), 16);
    let b = parseInt(color.substring(4, 6), 16);

    // Lighten by blending with white (amount = 0 to 1, where 1 is white)
    r = Math.round(r + (255 - r) * amount);
    g = Math.round(g + (255 - g) * amount);
    b = Math.round(b + (255 - b) * amount);

    // Convert back to hex
    return '#' + [r, g, b].map(x => {
      const hex = x.toString(16);
      return hex.length === 1 ? '0' + hex : hex;
    }).join('');
  }

  /**
   * Replace terms based on a mapping (case-insensitive)
   * @param text Text to process
   * @param replacements Optional custom replacement mapping (defaults to brand replacements)
   * @returns Text with replacements applied
   */
  public replaceBrandTerms(
    text: string | null | undefined,
    replacements: { [key: string]: string } = {
      'Hitster': 'QRSong!',
      'Hitstar': 'QRSong!',
      'Disney': 'Cartoon'
    }
  ): string {
    if (!text) return '';

    let result = text;

    // Apply each replacement using case-insensitive regex
    for (const [searchTerm, replacement] of Object.entries(replacements)) {
      const regex = new RegExp(searchTerm, 'gi');
      result = result.replace(regex, replacement);
    }

    return result;
  }
}

export default Utils;
