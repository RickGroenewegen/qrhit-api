import Analytics from '@google-analytics/data';
import Logger from './logger';

class AnalyticsClient {
  private logger = new Logger();
  private analyticsClient: typeof Analytics;

  constructor() {
    this.analyticsClient = new Analytics({
      trackingId: process.env['GOOGLE_ANALYTICS_TRACKING_ID']!,
    });
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
