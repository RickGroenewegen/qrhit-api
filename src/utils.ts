import sanitizeHtml from 'sanitize-html';
import { promises as fs } from 'fs';
import { EC2Client, DescribeInstancesCommand } from '@aws-sdk/client-ec2';
import axios from 'axios';
import parser from 'accept-language-parser';
import Translation from './translation';

class Utils {
  private translation: Translation = new Translation();

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

    // Title can be max. 70 characters. Add "..." if it's longer
    if (str.length > 70) {
      str = str.substring(0, 67) + '...';
    }

    // Remove (Remastered) from the title
    str = str.replace(/\(Remastered\)/gi, '').trim();

    return str;
  }

  public async verifyRecaptcha(token: string): Promise<boolean> {
    try {
      const secretKey = process.env['RECAPTCHA_SECRET_KEY'];
      const verifyUrl = `https://www.google.com/recaptcha/api/siteverify?secret=${secretKey}&response=${token}`;

      const response = await axios.post(verifyUrl);

      return response.data.success;
    } catch (error) {
      console.error('reCAPTCHA verification failed:', error);
      return false;
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
}

export default Utils;
