import { PrismaClient } from '@prisma/client';
import admin from 'firebase-admin';
import { color } from 'console-log-colors';
import Logger from './logger';

admin.initializeApp({
  credential: admin.credential.cert(
    require(`${process.env['APP_ROOT']}/../docs/firebase.json`)
  ),
});

class Push {
  private static instance: Push;
  private prisma: PrismaClient;
  private logger = new Logger();

  private constructor() {
    this.prisma = new PrismaClient();
  }

  public static getInstance(): Push {
    if (!Push.instance) {
      Push.instance = new Push();
    }
    return Push.instance;
  }

  public async addToken(token: string, type: string): Promise<void> {
    const existingToken = await this.prisma.pushToken.findUnique({
      where: { token },
    });

    if (existingToken) {
      await this.prisma.pushToken.update({
        where: { token },
        data: { type },
      });
    } else {
      await this.prisma.pushToken.create({
        data: { token, type },
      });
    }
  }

  public async broadcastNotification(
    title: string,
    message: string
  ): Promise<void> {
    const tokens = await this.prisma.pushToken.findMany();

    this.logger.log(
      color.blue.bold(
        `Broadcasting notification to ${color.white.bold(
          tokens.length
        )} devices`
      )
    );

    const sendPromises = tokens.map(async (token) => {
      await this.sendPushNotification(token.token, title, message);
    });

    try {
      await Promise.all(sendPromises);
      this.logger.log(
        color.blue.bold(
          `Broadcast notification sent to ${color.white.bold(
            tokens.length
          )} devices`
        )
      );
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error sending broadcast notification to ${color.white.bold(
            tokens.length
          )} devices`
        )
      );
    }
  }

  public async sendPushNotification(
    token: string,
    title: string,
    message: string
  ): Promise<void> {
    const messagePayload = {
      token: token,
      notification: {
        title: title,
        body: message,
      },
    };

    try {
      await admin.messaging().send(messagePayload);
      this.logger.log(
        color.blue.bold(
          `Push notification sent to token: ${color.white.bold(token)}`
        )
      );
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error sending push notification to token: ${color.white.bold(token)}`
        )
      );
    }
  }
}
export default Push;
