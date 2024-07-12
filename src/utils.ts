import sanitizeHtml from 'sanitize-html';
import { promises as fs } from 'fs';
import { fromInstanceMetadata } from '@aws-sdk/credential-provider-imds';

class Utils {
  public async getInstanceId(): Promise<string> {
    try {
      const credentials = await fromInstanceMetadata()();
      console.log(222, credentials);
      //const instanceId = credentials.metadata.instanceId;
      return 'abc';
    } catch (error) {
      console.log(error);
      return '';
    }
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
          throw new Error(`Unrecognized string value: ${value}`);
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
}

export default Utils;
