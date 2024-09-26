import Logger from './logger';

class AnalyticsClient {
  private logger = new Logger();

  constructor() {}

  public logEvent(
    eventCategory: string,
    eventAction: string,
    eventLabel?: string,
    eventValue?: number
  ): void {}
}

export default AnalyticsClient;
