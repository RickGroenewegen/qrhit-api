import { PrismaClient, PushToken } from '@prisma/client';
import admin from 'firebase-admin';
import { color } from 'console-log-colors';
import Logger from './logger';
import Cache from './cache';

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
    const cache = Cache.getInstance();
    const lockKey = `push:addToken:${token}`;
    let lockAcquired = false;
    try {
      this.logger.log(
        color.cyan.bold(
          `Attempting to acquire lock for push token: ${color.white.bold(token)}`
        )
      );
      lockAcquired = await cache.acquireLock(lockKey, 5);
      if (!lockAcquired) {
        this.logger.log(
          color.red.bold(
            `Could not acquire lock for push token: ${color.white.bold(token)}. Operation aborted.`
          )
        );
        throw new Error('Could not acquire lock for push token operation');
      }
      this.logger.log(
        color.cyan.bold(
          `Lock acquired for push token: ${color.white.bold(token)}`
        )
      );
      this.logger.log(
        color.cyan.bold(
          `Attempting to add or update push token: ${color.white.bold(
            token
          )} of type: ${color.white.bold(type)}`
        )
      );
      const existingToken = await this.prisma.pushToken.findUnique({
        where: { token },
      });

      if (existingToken) {
        this.logger.log(
          color.yellow.bold(
            `Token already exists. Updating token: ${color.white.bold(token)}`
          )
        );
        await this.prisma.pushToken.update({
          where: { token },
          data: { type, valid: true },
        });
        this.logger.log(
          color.green.bold(
            `Token updated successfully: ${color.white.bold(token)}`
          )
        );
      } else {
        this.logger.log(
          color.cyan.bold(
            `Token does not exist. Creating new token: ${color.white.bold(
              token
            )}`
          )
        );
        await this.prisma.pushToken.create({
          data: { token, type, valid: true },
        });
        this.logger.log(
          color.green.bold(
            `Token created successfully: ${color.white.bold(token)}`
          )
        );
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error adding or updating push token: ${color.white.bold(token)}`
        )
      );
      this.logger.log(
        color.red.bold(
          `Error details: ${color.white.bold((error as Error).message)}`
        )
      );
      throw error;
    } finally {
      if (lockAcquired) {
        try {
          const cache = Cache.getInstance();
          await cache.releaseLock(lockKey);
          this.logger.log(
            color.cyan.bold(
              `Lock released for push token: ${color.white.bold(token)}`
            )
          );
        } catch (releaseError) {
          this.logger.log(
            color.red.bold(
              `Error releasing lock for push token: ${color.white.bold(token)}`
            )
          );
        }
      }
    }
  }

  public async broadcastNotification(
    title: string,
    message: string,
    test: boolean,
    dry: boolean
  ): Promise<void> {
    const tokens = await this.prisma.pushToken.findMany({
      where: test ? { test, valid: true } : { valid: true },
    });

    this.logger.log(
      color.blue.bold(
        `Broadcasting ${
          test ? 'test' : 'live'
        } notification to ${color.white.bold(tokens.length)} device(s)`
      )
    );

    if (dry) {
      this.logger.log(
        color.yellow.bold('Dry run enabled, no push notifications will be sent')
      );
    }

    const sendPromises = tokens.map(async (token) => {
      if (!dry) {
        await this.sendPushNotification(token, title, message);
      }
    });

    // Create the pushMessage in the database
    await this.prisma.pushMessage.create({
      data: {
        title,
        message,
        numberOfDevices: tokens.length,
        test,
        dry,
      },
    });

    try {
      await Promise.all(sendPromises);
      this.logger.log(
        color.blue.bold(
          `Broadcast ${
            test ? 'test' : 'live'
          } notification sent to ${color.white.bold(tokens.length)} device(s)`
        )
      );
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error sending broadcast ${
            test ? 'test' : 'live'
          } notification to ${color.white.bold(tokens.length)} device(s)`
        )
      );
    }
  }

  public async getMessages(): Promise<any> {
    return this.prisma.pushMessage.findMany({
      select: {
        id: true,
        title: true,
        message: true,
        test: true,
        dry: true,
        numberOfDevices: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  public async sendPushNotification(
    token: PushToken,
    title: string,
    message: string
  ): Promise<void> {
    const messagePayload = {
      token: token.token,
      notification: {
        title: title,
        body: message,
      },
    };

    try {
      await admin.messaging().send(messagePayload);
      this.logger.log(
        color.blue.bold(
          `Push notification sent to token: ${color.white.bold(token.token)}`
        )
      );
    } catch (error) {
      // If the token is invalid, mark it as invalid in the database
      await this.prisma.pushToken.update({
        where: { id: token.id },
        data: { valid: false },
      });
      this.logger.log(
        color.red.bold(
          `Error sending push notification to token: ${color.white.bold(
            token.token
          )}`
        )
      );
    }
  }
}
export default Push;
