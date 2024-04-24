import Log from './logger';
import { Progress as IProgress } from './interfaces/Progress';
import { color } from 'console-log-colors';
import { SocketStream } from '@fastify/websocket';
import Cache from './cache';

class Progress {
  private static instance: Progress;
  private progress: { [key: string]: IProgress } = {};
  private logger = new Log();
  private cache = Cache.getInstance();

  private constructor() {}

  public static getInstance(): Progress {
    if (!Progress.instance) {
      Progress.instance = new Progress();
    }
    return Progress.instance;
  }

  public async startProgress(paymentId: string) {
    if (!this.progress[paymentId]) {
      this.progress[paymentId] = {
        paymentId: paymentId,
        progress: 0,
        message: 'Started progress...',
      };
      this.logger.log(
        color.blue.bold(
          `Starting progress for payment: ${color.white.bold(paymentId)}`
        )
      );
    }
  }

  public async setProgress(
    paymentId: string,
    progress: number,
    message: string
  ) {
    if (this.progress[paymentId]) {
      this.progress[paymentId].paymentId = paymentId;
      this.progress[paymentId].progress = progress;
      this.progress[paymentId].message = message;

      this.logger.log(
        color.blue.bold(
          `Progress for payment ${color.white.bold(
            paymentId
          )}: ${color.white.bold(progress.toString())}% - ${color.white.bold(
            message
          )}`
        )
      );
    }
  }
}

export default Progress;
