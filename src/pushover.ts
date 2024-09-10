import axios from 'axios';
import { PushoverMessage } from './interfaces/PushoverMessage';

class PushoverClient {
  private apiUrl: string = 'https://api.pushover.net/1/messages.json';

  async sendMessage(message: PushoverMessage, ip: string): Promise<void> {
    message.token = process.env.PUSHOVER_APP_KEY as string;
    message.user = process.env.PUSHOVER_USER_KEY as string;
    try {
      if (
        !(
          process.env['TRUSTED_IPS'] &&
          process.env['TRUSTED_IPS'].split(',').includes(ip)
        )
      ) {
        await axios.post(this.apiUrl, message);
      }
    } catch (error) {
      // Nothing
    }
  }
}

export default PushoverClient;
