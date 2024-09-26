import ua from 'universal-analytics';
import Logger from './logger';

class AnalyticsClient {
  private logger = new Logger();
  private visitor: ua.Visitor;

  constructor() {
    const trackingId = process.env.GA_TRACKING_ID;
    if (!trackingId) {
      throw new Error('GA_TRACKING_ID environment variable is not set');
    }
    this.visitor = ua(trackingId);
  }

  public logEvent(eventCategory: string, eventAction: string, eventLabel?: string, eventValue?: number): void {
    this.visitor.event({
      ec: eventCategory,
      ea: eventAction,
      el: eventLabel,
      ev: eventValue,
    }, (err) => {
      if (err) {
        this.logger.log(`Failed to log event: ${err}`);
      } else {
        this.logger.log(`Event logged: ${eventCategory} - ${eventAction}`);
      }
    });
  }
}

export default AnalyticsClient;
