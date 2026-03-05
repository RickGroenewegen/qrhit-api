import { Track } from './interfaces/Track';
import Logger from './logger';
import PrismaInstance from './prisma';
import { CronJob } from 'cron';
import { ApiResult } from './interfaces/ApiResult';
import Cache from './cache';
import Translation from './translation';
import Utils from './utils';
import { CartItem } from './interfaces/CartItem';
import AnalyticsClient from './analytics';
import cluster from 'cluster';
import { Music } from './music';
import PushoverClient from './pushover';
import { ChatGPT } from './chatgpt';
import YTMusic from 'ytmusic-api';
import axios, { AxiosInstance } from 'axios';
import AppTheme from './apptheme';
import { DataDeps } from './data/types';

// Sub-module imports
import * as miscModule from './data/misc';
import * as usersModule from './data/users';
import * as scoringModule from './data/scoring';
import * as playlistsModule from './data/playlists';
import * as tracksModule from './data/tracks';
import * as trackYearsModule from './data/trackYears';
import * as musicLinksModule from './data/musicLinks';
import * as featuredPlaylistsModule from './data/featuredPlaylists';

class Data {
  private static instance: Data;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private cache = Cache.getInstance();
  private translate = new Translation();
  private utils = new Utils();
  private music = new Music();
  private openai = new ChatGPT();
  private analytics = AnalyticsClient.getInstance();
  private pushover = new PushoverClient();
  private appTheme = AppTheme.getInstance();
  private axiosInstance: AxiosInstance;
  private blockedPlaylists: Set<number> = new Set();
  private blockedPlaylistsInitialized: boolean = false;

  private ytmusic: YTMusic;

  /** Cast this instance to DataDeps for sub-module calls */
  private get deps(): DataDeps {
    return this as unknown as DataDeps;
  }

  public euCountryCodes = usersModule.euCountryCodes;

  private constructor() {
    this.ytmusic = new YTMusic();
    this.ytmusic.initialize();
    this.axiosInstance = axios.create();
    // ... rest of constructor
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] === 'development') {
          this.createSiteMap();

          await this.prefillLinkCache();
          await this.loadBlocked();
          // Schedule hourly cache refresh
          const job = new CronJob('0 * * * *', async () => {
            await this.prefillLinkCache();
          });
          const genreJob = new CronJob('30 1 * * *', async () => {
            await this.translateGenres();
          });
          // Schedule daily playlist stats update at 3 AM (Wilson scores + decade percentages)
          const playlistStatsJob = new CronJob('0 3 * * *', async () => {
            await this.updateFeaturedPlaylistStats();
          });
          job.start();
          genreJob.start();
          playlistStatsJob.start();
        } else {
          // Non-primary servers: load blocked list and sync from Redis hourly
          await this.loadBlockedFromCache();
          const blockedSyncJob = new CronJob('5 * * * *', async () => {
            await this.loadBlockedFromCache();
          });
          blockedSyncJob.start();
        }
      });
    } else {
      // Worker processes: load blocked list from Redis cache
      this.loadBlockedFromCache().then(() => {
        // Schedule hourly sync from Redis
        const blockedSyncJob = new CronJob('5 * * * *', async () => {
          await this.loadBlockedFromCache();
        });
        blockedSyncJob.start();
      });
    }
  }

  public static getInstance(): Data {
    if (!Data.instance) {
      Data.instance = new Data();
    }
    return Data.instance;
  }

  // ── Music Links ──────────────────────────────────────────────

  public async getYouTubeLink(artist: string, name: string): Promise<string | null> {
    return musicLinksModule.getYouTubeLink(this.deps, artist, name);
  }

  public async addSpotifyLinks(): Promise<number> {
    return musicLinksModule.addSpotifyLinks(this.deps);
  }

  private async prefillLinkCache(): Promise<void> {
    return musicLinksModule.prefillLinkCache(this.deps);
  }

  public async logLink(trackId: number, clientIp: string, php?: number): Promise<void> {
    return musicLinksModule.logLink(this.deps, trackId, clientIp, php);
  }

  public async getLink(
    trackId: number,
    clientIp: string,
    useCache: boolean = true,
    userAgent?: string,
    php?: number
  ): Promise<ApiResult> {
    return musicLinksModule.getLink(this.deps, trackId, clientIp, useCache, userAgent, php);
  }

  public async getPlaylistLinkCoverage(playlistId: number) {
    return musicLinksModule.getPlaylistLinkCoverage(this.deps, playlistId);
  }

  public async getTracksWithoutMusicLinks(limit: number = 100): Promise<any[]> {
    return musicLinksModule.getTracksWithoutMusicLinks(this.deps, limit);
  }

  public async updateTrackMusicLinks(
    trackId: number,
    links: {
      deezerLink?: string | null;
      youtubeMusicLink?: string | null;
      appleMusicLink?: string | null;
      amazonMusicLink?: string | null;
      tidalLink?: string | null;
    }
  ): Promise<{ success: boolean; error?: string }> {
    return musicLinksModule.updateTrackMusicLinks(this.deps, trackId, links);
  }

  public async findMissingServiceLinks(service: string) {
    return musicLinksModule.findMissingServiceLinks(this.deps, service);
  }

  // ── Tracks ───────────────────────────────────────────────────

  public async getTracks(playlistId: number, userId: number = 0): Promise<any> {
    return tracksModule.getTracks(this.deps, playlistId, userId);
  }

  public async getTrackById(trackId: number): Promise<any> {
    return tracksModule.getTrackById(this.deps, trackId);
  }

  public async updateTrack(
    id: number,
    artist: string,
    name: string,
    year: number,
    spotifyLink: string,
    youtubeMusicLink: string,
    appleMusicLink: string,
    tidalLink: string,
    deezerLink: string,
    amazonMusicLink: string,
    clientIp: string
  ): Promise<{ success: boolean; error?: string }> {
    return tracksModule.updateTrack(this.deps, id, artist, name, year, spotifyLink, youtubeMusicLink, appleMusicLink, tidalLink, deezerLink, amazonMusicLink, clientIp);
  }

  public async storeTracks(
    playlistDatabaseId: number,
    playlistId: string,
    tracks: any,
    trackOrder?: Map<string, number>,
    serviceType: string = 'spotify'
  ): Promise<any> {
    return tracksModule.storeTracks(this.deps, playlistDatabaseId, playlistId, tracks, trackOrder, serviceType);
  }

  public async searchTracks(
    searchTerm: string,
    missingService?: string,
    playlistItemId?: number,
    page: number = 1,
    limit: number = 50
  ) {
    return tracksModule.searchTracks(this.deps, searchTerm, missingService, playlistItemId, page, limit);
  }

  public async getTracksMissingSpotifyLink(searchTerm: string = ''): Promise<any[]> {
    return tracksModule.getTracksMissingSpotifyLink(this.deps, searchTerm);
  }

  public async getTracksMissingSpotifyLinkCount(): Promise<number> {
    return tracksModule.getTracksMissingSpotifyLinkCount(this.deps);
  }

  public async toggleSpotifyLinkIgnored(trackId: number): Promise<{ spotifyLinkIgnored: boolean }> {
    return tracksModule.toggleSpotifyLinkIgnored(this.deps, trackId);
  }

  // ── Track Years ──────────────────────────────────────────────

  public async updateTrackYear(trackIds: string[], tracks: Track[]): Promise<void> {
    return trackYearsModule.updateTrackYear(this.deps, trackIds, tracks);
  }

  public async getFirstUncheckedTrack() {
    return trackYearsModule.getFirstUncheckedTrack(this.deps);
  }

  public async getYearCheckQueue() {
    return trackYearsModule.getYearCheckQueue(this.deps);
  }

  public async updateTrackCheck(trackId: number, year: number) {
    return trackYearsModule.updateTrackCheck(this.deps, trackId, year);
  }

  public async areAllTracksManuallyChecked(paymentId: string): Promise<boolean> {
    return usersModule.areAllTracksManuallyChecked(this.deps, paymentId);
  }

  // ── Playlists ────────────────────────────────────────────────

  public async storePlaylists(
    userDatabaseId: number,
    cartItems: CartItem[],
    resetCache: boolean = false
  ): Promise<number[]> {
    return playlistsModule.storePlaylists(this.deps, userDatabaseId, cartItems, resetCache);
  }

  public async getPlaylist(playlistId: string): Promise<any> {
    return playlistsModule.getPlaylist(this.deps, playlistId);
  }

  public async getPlaylistsByPaymentId(paymentId: string, playlistId: string | null = null): Promise<any[]> {
    return playlistsModule.getPlaylistsByPaymentId(this.deps, paymentId, playlistId);
  }

  public async getPlaylistBySlug(slug: string) {
    return playlistsModule.getPlaylistBySlug(this.deps, slug);
  }

  public async updatePaymentHasPlaylist(
    paymentHasPlaylistId: number,
    eco: boolean,
    doubleSided: boolean,
    printerType?: string,
    template?: string | null
  ): Promise<{ success: boolean; error?: string }> {
    return playlistsModule.updatePaymentHasPlaylist(this.deps, paymentHasPlaylistId, eco, doubleSided, printerType, template);
  }

  public async updatePlaylistTrackCount(paymentHasPlaylistId: number, numberOfTracks: number) {
    return playlistsModule.updatePlaylistTrackCount(this.deps, paymentHasPlaylistId, numberOfTracks);
  }

  public async deletePlaylistFromOrder(paymentHasPlaylistId: number) {
    return playlistsModule.deletePlaylistFromOrder(this.deps, paymentHasPlaylistId);
  }

  public async updatePlaylistAmount(paymentHasPlaylistId: number, amount: number) {
    return playlistsModule.updatePlaylistAmount(this.deps, paymentHasPlaylistId, amount);
  }

  public async updateGamesEnabled(paymentHasPlaylistId: number, gamesEnabled: boolean) {
    return playlistsModule.updateGamesEnabled(this.deps, paymentHasPlaylistId, gamesEnabled);
  }

  public async resetJudgedStatus(paymentHasPlaylistId: number) {
    return playlistsModule.resetJudgedStatus(this.deps, paymentHasPlaylistId);
  }

  public async updatePlaylistBlocked(playlistId: number, blocked: boolean) {
    return playlistsModule.updatePlaylistBlocked(this.deps, playlistId, blocked);
  }

  private async loadBlocked(): Promise<void> {
    await playlistsModule.loadBlocked(this.deps);
    this.blockedPlaylistsInitialized = true;
  }

  private async loadBlockedFromCache(): Promise<void> {
    await playlistsModule.loadBlockedFromCache(this.deps);
    this.blockedPlaylistsInitialized = true;
  }

  // ── Users & Payments ─────────────────────────────────────────

  public async storeUser(userParams: any): Promise<number> {
    return usersModule.storeUser(this.deps, userParams);
  }

  public async getUser(id: number): Promise<any> {
    return usersModule.getUser(this.deps, id);
  }

  public async getUserByUserId(userId: string): Promise<any> {
    return usersModule.getUserByUserId(this.deps, userId);
  }

  public async getPayment(paymentId: string, playlistId: string): Promise<any> {
    return usersModule.getPayment(this.deps, paymentId, playlistId);
  }

  public async verifyPayment(paymentId: string) {
    return usersModule.verifyPayment(this.deps, paymentId);
  }

  public async checkUnfinalizedPayments(): Promise<string[]> {
    return usersModule.checkUnfinalizedPayments(this.deps);
  }

  public async getTaxRate(countryCode: string, date: Date = new Date()): Promise<number | null> {
    return usersModule.getTaxRate(this.deps, countryCode, date);
  }

  public async updatePaymentPrinterHold(paymentId: string, printerHold: boolean) {
    return usersModule.updatePaymentPrinterHold(this.deps, paymentId, printerHold);
  }

  public async updatePaymentExpress(paymentId: string, fast: boolean) {
    return usersModule.updatePaymentExpress(this.deps, paymentId, fast);
  }

  // ── Featured Playlists ───────────────────────────────────────

  public async getFeaturedPlaylists(locale: string, skipLocaleFilter: boolean = false): Promise<any> {
    return featuredPlaylistsModule.getFeaturedPlaylists(this.deps, locale, skipLocaleFilter);
  }

  public async getAllFeaturedPlaylists(): Promise<any[]> {
    return featuredPlaylistsModule.getAllFeaturedPlaylists(this.deps);
  }

  public async searchFeaturedPlaylists(
    searchTerm: string = '',
    locale: string | null = null,
    page: number = 1,
    limit: number = 20,
    sortColumn: string = 'id',
    sortDirection: string = 'desc'
  ) {
    return featuredPlaylistsModule.searchFeaturedPlaylists(this.deps, searchTerm, locale, page, limit, sortColumn, sortDirection);
  }

  public async getPendingPromotionalPlaylists(): Promise<any[]> {
    return featuredPlaylistsModule.getPendingPromotionalPlaylists(this.deps);
  }

  public async getAcceptedPromotionalPlaylists(): Promise<any[]> {
    return featuredPlaylistsModule.getAcceptedPromotionalPlaylists(this.deps);
  }

  public async updatePlaylistFeatured(playlistId: string, featured: boolean) {
    return featuredPlaylistsModule.updatePlaylistFeatured(this.deps, playlistId, featured);
  }

  public async updateFeaturedHidden(playlistId: string, featuredHidden: boolean) {
    return featuredPlaylistsModule.updateFeaturedHidden(this.deps, playlistId, featuredHidden);
  }

  public async updateFeaturedLocale(playlistId: string, featuredLocale: string | null) {
    return featuredPlaylistsModule.updateFeaturedLocale(this.deps, playlistId, featuredLocale);
  }

  public async updatePromotionalPlaylist(
    playlistId: string,
    data: { name: string; description: string; featuredLocale: string | null; slug?: string }
  ) {
    return featuredPlaylistsModule.updatePromotionalPlaylist(this.deps, playlistId, data);
  }

  public async acceptPromotionalPlaylist(playlistId: string) {
    return featuredPlaylistsModule.acceptPromotionalPlaylist(this.deps, playlistId);
  }

  public async declinePromotionalPlaylist(playlistId: string) {
    return featuredPlaylistsModule.declinePromotionalPlaylist(this.deps, playlistId);
  }

  // ── Scoring ──────────────────────────────────────────────────

  public async calculatePlaylistScores() {
    return scoringModule.calculatePlaylistScores(this.deps);
  }

  public async calculateSinglePlaylistDecadePercentages(playlistId: number) {
    return scoringModule.calculateSinglePlaylistDecadePercentages(this.deps, playlistId);
  }

  public async calculateDecadePercentages() {
    return scoringModule.calculateDecadePercentages(this.deps);
  }

  public async updateFeaturedPlaylistStats() {
    return scoringModule.updateFeaturedPlaylistStats(this.deps);
  }

  // ── Misc ─────────────────────────────────────────────────────

  public async getPDFFilepath(
    clientIp: string,
    paymentId: string,
    userHash: string,
    playlistId: string,
    type: string
  ): Promise<{ fileName: string; filePath: string } | null> {
    return miscModule.getPDFFilepath(this.deps, clientIp, paymentId, userHash, playlistId, type);
  }

  public async getLastPlays(): Promise<any[]> {
    return miscModule.getLastPlays(this.deps);
  }

  public async translateGenres() {
    return miscModule.translateGenres(this.deps);
  }

  private async createSiteMap(): Promise<void> {
    return miscModule.createSiteMap(this.deps);
  }

  public async generatePlaylistExcel(paymentId: string, paymentHasPlaylistId: number): Promise<Buffer | null> {
    return miscModule.generatePlaylistExcel(this.deps, paymentId, paymentHasPlaylistId);
  }

  public async clearPlaylistCache(playlistId: string, oldSlug?: string) {
    return miscModule.clearPlaylistCache(this.deps, playlistId, oldSlug);
  }

  public async clearNonFeaturedPlaylistCaches() {
    return miscModule.clearNonFeaturedPlaylistCaches(this.deps);
  }
}

export default Data;
