import Logger from '../logger';
import Cache from '../cache';
import Translation from '../translation';
import Utils from '../utils';
import { Music } from '../music';
import { ChatGPT } from '../chatgpt';
import AnalyticsClient from '../analytics';
import PushoverClient from '../pushover';
import AppTheme from '../apptheme';
import PrismaInstance from '../prisma';
import { AxiosInstance } from 'axios';
import YTMusic from 'ytmusic-api';

export interface DataDeps {
  prisma: ReturnType<typeof PrismaInstance.getInstance>;
  logger: Logger;
  cache: Cache;
  translate: Translation;
  utils: Utils;
  music: Music;
  openai: ChatGPT;
  analytics: AnalyticsClient;
  pushover: PushoverClient;
  appTheme: AppTheme;
  axiosInstance: AxiosInstance;
  ytmusic: YTMusic;
  blockedPlaylists: Set<number>;
  blockedPlaylistsInitialized: boolean;
}
