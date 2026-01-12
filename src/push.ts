import { PrismaClient, PushToken } from '@prisma/client';
import admin from 'firebase-admin';
import { color } from 'console-log-colors';
import Logger from './logger';
import { createPrismaAdapter } from './prisma';

admin.initializeApp({
  credential: admin.credential.cert(
    require(`${process.env['APP_ROOT']}/../docs/firebase.json`)
  ),
});

class Push {
  private static instance: Push;
  private prisma: PrismaClient;
  private logger = new Logger();
  private static tokenLocks: Map<string, Promise<void> | null> = new Map();

  private constructor() {
    this.prisma = new PrismaClient({ adapter: createPrismaAdapter() });
  }

  public static getInstance(): Push {
    if (!Push.instance) {
      Push.instance = new Push();
    }
    return Push.instance;
  }

  public async addToken(token: string, type: string): Promise<void> {
    const lockKey = `push:addToken:${token}`;

    // Simple in-memory lock using a Promise chain per token
    let release: (() => void) | undefined;
    let lockPromise = new Promise<void>((resolve) => {
      release = resolve;
    });

    // Wait for any existing lock to finish
    while (Push.tokenLocks.get(lockKey)) {
      // eslint-disable-next-line no-await-in-loop
      await Push.tokenLocks.get(lockKey);
    }
    // Set our lock
    Push.tokenLocks.set(lockKey, lockPromise);

    try {
      // Use a transaction to guarantee atomicity at the DB level
      await this.prisma.$transaction(async (tx) => {
        const existingToken = await tx.pushToken.findUnique({
          where: { token },
        });

        if (existingToken) {
          await tx.pushToken.update({
            where: { token },
            data: { type, valid: true },
          });
        } else {
          await tx.pushToken.create({
            data: { token, type, valid: true },
          });
          this.logger.log(
            color.green.bold(
              `Token (${color.white.bold(
                type
              )}) created successfully: ${color.white.bold(token)}`
            )
          );
        }
      });
    } catch (error: any) {
      // If unique constraint error, log and ignore (another process/thread created it)
      if (error.code === 'P2002' && error.meta?.target?.includes('token')) {
        // Do not log normal duplicate
      } else {
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
      }
    } finally {
      // Release the lock
      Push.tokenLocks.delete(lockKey);
      if (typeof release === 'function') release();
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
