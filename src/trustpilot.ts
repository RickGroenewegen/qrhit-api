import { ApiResult } from './interfaces/ApiResult';
import Cache from './cache';
import Utils from './utils';
import AnalyticsClient from './analytics';
import Logger from './logger';
import PrismaInstance from './prisma';

class Trustpilot {
  private cache = Cache.getInstance();
  private utils = new Utils();
  private analytics = AnalyticsClient.getInstance();
  private prisma = PrismaInstance.getInstance();
  private static instance: Trustpilot;

  private constructor() {}

  public static getInstance(): Trustpilot {
    if (!Trustpilot.instance) {
      Trustpilot.instance = new Trustpilot();
    }
    return Trustpilot.instance;
  }
}

export default Trustpilot;
