import Log from '../logger';
import Settings from '../settings';
import Utils from '../utils';
import PrintEnBindV1 from './printenbindV1';
import PrintEnBindV2 from './printenbindV2';
import { color } from 'console-log-colors';
import cluster from 'cluster';
import { CronJob } from 'cron';

export type PrintEnBindApiVersion = 'v1' | 'v2';

/** Which integration handles Print&Bind when no admin choice is stored. */
const DEFAULT_API_VERSION: PrintEnBindApiVersion = 'v2';
/** How long the stored choice is reused before Settings is asked again. */
const VERSION_CACHE_MS = 5000;

/**
 * Print&Bind entry point for the rest of the app. Two integrations exist:
 * printenbindV1.ts talks to the legacy JSON API (`/v1/orders`), printenbindV2.ts
 * to the REST API (`/orders`, `/orders/calculate`). Which one is used is an
 * admin toggle (bulk actions, stored as the `printenbind_api_version` app
 * setting) so a broken rollout can be switched back without a deploy.
 *
 * Every public method resolves the active integration per call. The hourly
 * tracking and box-instruction crons are scheduled here, once, and run on
 * whichever integration is active when they fire. Orders placed on one API
 * carry that API's order id; the other API cannot look them up, so after a
 * switch the tracking poll only sees orders placed after it.
 */
class PrintEnBind {
  private static instance: PrintEnBind;
  private settings = Settings.getInstance();
  private logger = new Log();
  private utils = new Utils();
  private cachedVersion: PrintEnBindApiVersion | null = null;
  private cachedVersionAt = 0;

  private constructor() {
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          // Poll Print&Bind for shipped orders and send the tracking mail
          const trackingJob = new CronJob('15 * * * *', async () => {
            await this.handleTrackingMails();
          });
          trackingJob.start();

          // Send gift box folding instructions 24 hours after shipping
          const boxInstructionsJob = new CronJob('35 * * * *', async () => {
            await this.handleBoxInstructionMails();
          });
          boxInstructionsJob.start();
        }
      });
    }
  }

  public static getInstance(): PrintEnBind {
    if (!PrintEnBind.instance) {
      PrintEnBind.instance = new PrintEnBind();
    }
    return PrintEnBind.instance;
  }

  // ---------------------------------------------------------------------------
  // API version toggle
  // ---------------------------------------------------------------------------

  public async getApiVersion(): Promise<PrintEnBindApiVersion> {
    if (
      this.cachedVersion &&
      Date.now() - this.cachedVersionAt < VERSION_CACHE_MS
    ) {
      return this.cachedVersion;
    }
    let version: PrintEnBindApiVersion = DEFAULT_API_VERSION;
    try {
      const stored = await this.settings.getSetting('printenbind_api_version');
      if (stored === 'v1' || stored === 'v2') {
        version = stored;
      }
    } catch (error) {
      this.logger.log(
        color.yellow.bold(
          `Could not read the Print&Bind API version setting (${error}); using ${color.white.bold(
            DEFAULT_API_VERSION
          )}`
        )
      );
    }
    this.cachedVersion = version;
    this.cachedVersionAt = Date.now();
    return version;
  }

  public async setApiVersion(version: PrintEnBindApiVersion): Promise<void> {
    if (version !== 'v1' && version !== 'v2') {
      throw new Error(`Unknown Print&Bind API version: ${version}`);
    }
    await this.settings.setSetting('printenbind_api_version', version);
    this.cachedVersion = version;
    this.cachedVersionAt = Date.now();
    this.logger.log(
      color.blue.bold(
        `Print&Bind API switched to ${color.white.bold(version)} (${color.white.bold(
          this.apiUrlFor(version) || 'no URL configured'
        )})`
      )
    );
  }

  /** What the admin toggle shows: the active version and both endpoints. */
  public async getApiInfo(): Promise<{
    version: PrintEnBindApiVersion;
    v1Url: string | null;
    v2Url: string | null;
  }> {
    return {
      version: await this.getApiVersion(),
      v1Url: this.apiUrlFor('v1'),
      v2Url: this.apiUrlFor('v2'),
    };
  }

  public apiUrlFor(version: PrintEnBindApiVersion): string | null {
    const url =
      version === 'v1'
        ? process.env['PRINTENBIND_V1_API_URL']
        : process.env['PRINTENBIND_API_URL'];
    return url ? url.replace(/\/+$/, '') : null;
  }

  private async active(): Promise<PrintEnBindV1 | PrintEnBindV2> {
    return (await this.getApiVersion()) === 'v1'
      ? PrintEnBindV1.getInstance()
      : PrintEnBindV2.getInstance();
  }

  // ---------------------------------------------------------------------------
  // Pricing (identical in both integrations; served by v2 so sync callers work)
  // ---------------------------------------------------------------------------

  public getRawCardCostEur(
    ...args: Parameters<PrintEnBindV2['getRawCardCostEur']>
  ): ReturnType<PrintEnBindV2['getRawCardCostEur']> {
    return PrintEnBindV2.getInstance().getRawCardCostEur(...args);
  }

  public async calculateCardPrice(
    ...args: Parameters<PrintEnBindV2['calculateCardPrice']>
  ) {
    return (await this.active()).calculateCardPrice(...args);
  }

  public async calculateSingleItem(
    ...args: Parameters<PrintEnBindV2['calculateSingleItem']>
  ) {
    return (await this.active()).calculateSingleItem(...args);
  }

  public async getOrderTypes(
    ...args: Parameters<PrintEnBindV2['getOrderTypes']>
  ) {
    return (await this.active()).getOrderTypes(...args);
  }

  public async getOrderType(
    ...args: Parameters<PrintEnBindV2['getOrderType']>
  ) {
    return (await this.active()).getOrderType(...args);
  }

  public async getInvoice(...args: Parameters<PrintEnBindV2['getInvoice']>) {
    return (await this.active()).getInvoice(...args);
  }

  // ---------------------------------------------------------------------------
  // Checkout and shipping
  // ---------------------------------------------------------------------------

  public async calculateOrder(
    ...args: Parameters<PrintEnBindV2['calculateOrder']>
  ) {
    return (await this.active()).calculateOrder(...args);
  }

  /** Live delivery quote; REST only. Returns null on the legacy API. */
  public async quoteShippingCost(
    ...args: Parameters<PrintEnBindV2['quoteShippingCost']>
  ) {
    if ((await this.getApiVersion()) !== 'v2') {
      return null;
    }
    return PrintEnBindV2.getInstance().quoteShippingCost(...args);
  }

  public async getShippingCosts(
    ...args: Parameters<PrintEnBindV2['getShippingCosts']>
  ) {
    return (await this.active()).getShippingCosts(...args);
  }

  public async calculateShippingCosts(
    ...args: Parameters<PrintEnBindV2['calculateShippingCosts']>
  ) {
    return (await this.active()).calculateShippingCosts(...args);
  }

  // ---------------------------------------------------------------------------
  // Orders
  // ---------------------------------------------------------------------------

  public async testOrder(...args: Parameters<PrintEnBindV2['testOrder']>) {
    return (await this.active()).testOrder(...args);
  }

  public async createOrder(...args: Parameters<PrintEnBindV2['createOrder']>) {
    return (await this.active()).createOrder(...args);
  }

  public async orderInlayCard(
    ...args: Parameters<PrintEnBindV2['orderInlayCard']>
  ) {
    return (await this.active()).orderInlayCard(...args);
  }

  public async createBoxUpgradeOrder(
    ...args: Parameters<PrintEnBindV2['createBoxUpgradeOrder']>
  ) {
    return (await this.active()).createBoxUpgradeOrder(...args);
  }

  public async updateProductionMethod(
    ...args: Parameters<PrintEnBindV2['updateProductionMethod']>
  ) {
    return (await this.active()).updateProductionMethod(...args);
  }

  public async processPrintApiWebhook(
    ...args: Parameters<PrintEnBindV2['processPrintApiWebhook']>
  ) {
    return (await this.active()).processPrintApiWebhook(...args);
  }

  // ---------------------------------------------------------------------------
  // Tracking and admin
  // ---------------------------------------------------------------------------

  public async getSubmittedOrders(
    ...args: Parameters<PrintEnBindV2['getSubmittedOrders']>
  ) {
    return (await this.active()).getSubmittedOrders(...args);
  }

  public async checkDeliveryForOrder(
    ...args: Parameters<PrintEnBindV2['checkDeliveryForOrder']>
  ) {
    return (await this.active()).checkDeliveryForOrder(...args);
  }

  public async handleTrackingMails(
    ...args: Parameters<PrintEnBindV2['handleTrackingMails']>
  ) {
    return (await this.active()).handleTrackingMails(...args);
  }

  public async handleBoxInstructionMails(
    ...args: Parameters<PrintEnBindV2['handleBoxInstructionMails']>
  ) {
    return (await this.active()).handleBoxInstructionMails(...args);
  }

  public async updateAllPaymentsWithPrintApiOrderId(
    ...args: Parameters<PrintEnBindV2['updateAllPaymentsWithPrintApiOrderId']>
  ) {
    return (await this.active()).updateAllPaymentsWithPrintApiOrderId(...args);
  }
}

export default PrintEnBind;
