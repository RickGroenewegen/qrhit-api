import Logger from '../logger';
import Cache from '../cache';
import Translation from '../translation';
import Utils from '../utils';
import { Music } from '../music';
import { AiTasks } from '../aiTasks';
import AnalyticsClient from '../analytics';
import PushoverClient from '../pushover';
import AppTheme from '../apptheme';
import PrismaInstance from '../prisma';
import { AxiosInstance } from 'axios';

export interface DataDeps {
  prisma: ReturnType<typeof PrismaInstance.getInstance>;
  logger: Logger;
  cache: Cache;
  translate: Translation;
  utils: Utils;
  music: Music;
  aiTasks: AiTasks;
  analytics: AnalyticsClient;
  pushover: PushoverClient;
  appTheme: AppTheme;
  axiosInstance: AxiosInstance;
  blockedPlaylists: Set<number>;
  blockedPlaylistsInitialized: boolean;
  blockedFailOpenUntil: number;
  ensureBlockedLoaded(): Promise<void>;
  reloadBlocked(): Promise<void>;
}
