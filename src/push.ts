import { PrismaClient, PushToken } from '@prisma/client';
import { initializeApp, cert } from 'firebase-admin/app';
import { getMessaging } from 'firebase-admin/messaging';
import { color } from 'console-log-colors';
import Logger from './logger';
import PrismaInstance from './prisma';
import WebPush from './webPush';

initializeApp({
  credential: cert(
    require(`${process.env['APP_ROOT']}/../docs/firebase.json`)
  ),
});

class Push {
  private static instance: Push;
  private prisma: PrismaClient;
  private logger = new Logger();

  private constructor() {
    this.prisma = PrismaInstance.getInstance();
  }

  public static getInstance(): Push {
    if (!Push.instance) {
      Push.instance = new Push();
    }
    return Push.instance;
  }

  public async addToken(token: string, type: string): Promise<void> {
    try {
      const result = await this.prisma.pushToken.upsert({
        where: { token },
        update: { type, valid: true },
        create: { token, type, valid: true },
      });

      // Check if this was a create or update by comparing createdAt and updatedAt
      const isNew = result.createdAt.getTime() === result.updatedAt.getTime();

      if (isNew) {
        this.logger.log(
          color.green.bold(
            `Token (${color.white.bold(type)}) created: ${color.white.bold(token)}`
          )
        );
      } else {
        this.logger.log(
          color.blue.bold(
            `Token (${color.white.bold(type)}) already exists: ${color.white.bold(token)}`
          )
        );
      }
    } catch (error: any) {
      // Handle race condition: if unique constraint fails, the token already exists
      // This can happen when two concurrent requests try to upsert the same token
      if (error.code === 'P2002') {
        this.logger.log(
          color.blue.bold(
            `Token (${color.white.bold(type)}) already exists (concurrent): ${color.white.bold(token)}`
          )
        );
        return;
      }
      this.logger.log(
        color.red.bold(
          `Error adding push token: ${color.white.bold(token)} - ${color.white.bold(error.message)}`
        )
      );
      throw error;
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
    // Browsers are counted and sent apart from the app's devices: nothing on
    // the web side may stop or delay a broadcast to the app
    const webPush = WebPush.getInstance();
    const webDevices = await webPush.countTargets(test).catch(() => 0);
    const iosDevices = tokens.filter((token) => token.type === 'ios').length;
    const androidDevices = tokens.filter((token) => token.type === 'android').length;

    this.logger.log(
      color.blue.bold(
        `Broadcasting ${
          test ? 'test' : 'live'
        } notification to ${color.white.bold(tokens.length)} app device(s) and ${color.white.bold(webDevices)} browser(s)`
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
        numberOfDevices: tokens.length + webDevices,
        iosDevices,
        androidDevices,
        webDevices,
        test,
        dry,
      },
    });

    try {
      await Promise.all([
        ...sendPromises,
        webPush.broadcast(title, message, test, dry).catch((error: any) => {
          this.logger.log(
            color.red.bold(`Web push broadcast failed: ${color.white.bold(error?.message || error)}`)
          );
        }),
      ]);
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
        iosDevices: true,
        androidDevices: true,
        webDevices: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  /** Who a broadcast would reach right now, per platform. */
  public async getAudience(): Promise<{
    live: { ios: number; android: number; web: number };
    test: { ios: number; android: number; web: number };
  }> {
    const groups = await this.prisma.pushToken.groupBy({
      by: ['type', 'test'],
      where: { valid: true },
      _count: { _all: true },
    });
    const count = (type: string, testOnly: boolean) =>
      groups
        .filter((group) => group.type === type && (!testOnly || group.test))
        .reduce((sum, group) => sum + group._count._all, 0);
    const webPush = WebPush.getInstance();
    return {
      live: { ios: count('ios', false), android: count('android', false), web: await webPush.countTargets(false) },
      test: { ios: count('ios', true), android: count('android', true), web: await webPush.countTargets(true) },
    };
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
      await getMessaging().send(messagePayload);
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
