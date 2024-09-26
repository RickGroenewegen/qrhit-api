import { BetaAnalyticsDataClient } from '@google-analytics/data';
import Logger from './logger';

class AnalyticsClient {
  private logger = new Logger();
  private analyticsClient: BetaAnalyticsDataClient;

  constructor() {
    this.analyticsClient = new BetaAnalyticsDataClient();
  }

  public async logEvent(eventCategory: string, eventAction: string, eventLabel?: string, eventValue?: number): Promise<void> {
    try {
      await this.analyticsClient.event({
        category: eventCategory,
        action: eventAction,
        label: eventLabel,
        value: eventValue,
      });
      this.logger.log(`Event logged: ${eventCategory} - ${eventAction}`);
    } catch (error) {
      this.logger.log(`Failed to log event: ${error}`);
    }
  }
}

export default AnalyticsClient;
