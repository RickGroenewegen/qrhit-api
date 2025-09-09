import axios from 'axios';
import { PushoverMessage } from './interfaces/PushoverMessage';
import Utils from './utils';

class PushoverClient {
  private apiUrl: string = 'https://api.pushover.net/1/messages.json';
  private utils = new Utils();

  async sendMessage(message: PushoverMessage, ip: string): Promise<void> {
    message.token = process.env.PUSHOVER_APP_KEY as string;
    message.user = process.env.PUSHOVER_USER_KEY as string;
    try {
      if (
        !this.utils.isTrustedIp(ip) &&
        process.env['ENVIRONMENT'] !== 'development'
      ) {
        await axios.post(this.apiUrl, message);
      }
    } catch (error) {
      // Nothing
    }
  }
}

export default PushoverClient;
