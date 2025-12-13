import axios, { AxiosInstance } from 'axios';
import { wrapper } from 'axios-cookiejar-support';
import { CookieJar } from 'tough-cookie';
import * as cheerio from 'cheerio';
import Logger from './logger';
import { color } from 'console-log-colors';
import { Solver } from '2captcha-ts';
import Cache from './cache';

export interface DuckDuckGoResult {
  url: string;
  title: string;
  snippet: string;
  domain?: string;
}

// Redis key for storing cookies (2 hour TTL)
const COOKIE_CACHE_KEY = 'duckduckgo:cookies';
const COOKIE_TTL_SECONDS = 7200; // 2 hours

// Singleton DuckDuckGo search service with session persistence
export class DuckDuckGoSearch {
  private static instance: DuckDuckGoSearch;
  private logger = new Logger();
  private captchaSolver: Solver | null = null;
  private axiosInstance: AxiosInstance;
  private cookieJar: CookieJar;
  private cache = Cache.getInstance();
  // Consistent User-Agent for session persistence
  private readonly userAgent = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
  private lastRequestTime: number = 0;
  private readonly minDelayMs = 2000; // Minimum 2 seconds between requests
  private initialized = false;

  private constructor() {
    // Initialize CAPTCHA solver if API key is available
    if (process.env['TWOCAPTCHA_API_KEY']) {
      this.captchaSolver = new Solver(process.env['TWOCAPTCHA_API_KEY']);
    }

    // Create persistent cookie jar for session management
    this.cookieJar = new CookieJar();

    // Create axios instance with cookie jar support
    this.axiosInstance = wrapper(axios.create({
      jar: this.cookieJar,
      withCredentials: true,
    }));

    // Load cookies from Redis on startup
    this.loadCookiesFromRedis();
  }

  // Load cookies from Redis into the cookie jar
  private async loadCookiesFromRedis(): Promise<void> {
    try {
      const cookiesJson = await this.cache.get(COOKIE_CACHE_KEY, false);
      if (cookiesJson) {
        const cookies = JSON.parse(cookiesJson);
        for (const cookie of cookies) {
          await this.cookieJar.setCookie(cookie.cookieString, cookie.url);
        }
        this.logger.log(color.green(`[DuckDuckGo] Loaded ${cookies.length} cookies from Redis`));
      }
      this.initialized = true;
    } catch (error: any) {
      this.logger.log(color.yellow(`[DuckDuckGo] Could not load cookies from Redis: ${error.message}`));
      this.initialized = true;
    }
  }

  // Save cookies to Redis for persistence across restarts
  private async saveCookiesToRedis(): Promise<void> {
    try {
      const cookies = await this.cookieJar.serialize();
      const cookieData = cookies.cookies.map((c: any) => ({
        cookieString: `${c.key}=${c.value}; Domain=${c.domain}; Path=${c.path}`,
        url: `https://${c.domain}${c.path}`,
      }));
      await this.cache.set(COOKIE_CACHE_KEY, JSON.stringify(cookieData), COOKIE_TTL_SECONDS);
    } catch (error: any) {
      this.logger.log(color.yellow(`[DuckDuckGo] Could not save cookies to Redis: ${error.message}`));
    }
  }

  public static getInstance(): DuckDuckGoSearch {
    if (!DuckDuckGoSearch.instance) {
      DuckDuckGoSearch.instance = new DuckDuckGoSearch();
    }
    return DuckDuckGoSearch.instance;
  }

  // Rate limit to avoid CAPTCHA
  private async rateLimitDelay(): Promise<void> {
    const timeSinceLastRequest = Date.now() - this.lastRequestTime;
    const delay = timeSinceLastRequest < this.minDelayMs
      ? this.minDelayMs - timeSinceLastRequest
      : 0;

    // Add random jitter (500-1500ms) to look more human
    const jitter = 500 + Math.random() * 1000;

    if (delay > 0 || jitter > 0) {
      await new Promise(resolve => setTimeout(resolve, delay + jitter));
    }
  }

  // Detect CAPTCHA in HTML response
  private detectCaptcha(html: string): { hasCaptcha: boolean; type: string; sitekey?: string } {
    const lowerHtml = html.toLowerCase();

    // DuckDuckGo CAPTCHA patterns
    if (
      lowerHtml.includes('select all squares') ||
      lowerHtml.includes('captcha') ||
      lowerHtml.includes('please verify')
    ) {
      // Try to find sitekey for reCAPTCHA
      const sitekeyMatch = html.match(/data-sitekey="([^"]+)"/);
      return {
        hasCaptcha: true,
        type: sitekeyMatch ? 'recaptcha_v2' : 'image',
        sitekey: sitekeyMatch?.[1],
      };
    }

    return { hasCaptcha: false, type: 'none' };
  }

  // Attempt to solve CAPTCHA
  private async solveCaptcha(
    url: string,
    type: string,
    sitekey?: string
  ): Promise<{ success: boolean; token?: string; error?: string }> {
    if (!this.captchaSolver) {
      return { success: false, error: 'CAPTCHA solver not configured' };
    }

    if (!sitekey) {
      return { success: false, error: 'No sitekey found for CAPTCHA' };
    }

    try {
      this.logger.log(color.blue(`[DuckDuckGo] Attempting to solve CAPTCHA...`));
      const result = await this.captchaSolver.recaptcha({
        pageurl: url,
        googlekey: sitekey,
      });

      if (result?.data) {
        this.logger.log(color.green(`[DuckDuckGo] CAPTCHA solved successfully!`));
        return { success: true, token: result.data };
      }

      return { success: false, error: 'No solution returned' };
    } catch (error: any) {
      this.logger.log(color.red(`[DuckDuckGo] CAPTCHA solving error: ${error.message}`));
      return { success: false, error: error.message };
    }
  }

  // Main search method
  public async search(query: string): Promise<DuckDuckGoResult[]> {
    try {
      // Wait for initialization if not done
      if (!this.initialized) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }

      // Rate limit
      await this.rateLimitDelay();
      this.lastRequestTime = Date.now();

      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;

      // Use axios instance with cookie jar for session persistence
      const response = await this.axiosInstance.get(searchUrl, {
        headers: {
          'User-Agent': this.userAgent,
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Cache-Control': 'no-cache',
          'Sec-Ch-Ua': '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
          'Sec-Ch-Ua-Mobile': '?0',
          'Sec-Ch-Ua-Platform': '"macOS"',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Upgrade-Insecure-Requests': '1',
        },
        timeout: 15000,
        maxRedirects: 5,
      });

      // Save cookies to Redis after each request
      await this.saveCookiesToRedis();

      const html = response.data;

      // Check for CAPTCHA
      const captchaDetection = this.detectCaptcha(html);
      if (captchaDetection.hasCaptcha) {
        this.logger.log(color.yellow(`[DuckDuckGo] CAPTCHA detected (${captchaDetection.type})`));

        if (captchaDetection.sitekey) {
          const solution = await this.solveCaptcha(searchUrl, captchaDetection.type, captchaDetection.sitekey);
          if (!solution.success) {
            this.logger.log(color.red(`[DuckDuckGo] CAPTCHA solving failed: ${solution.error}`));
          }
          // Note: Would need browser to submit token, returning empty for now
        }
        return [];
      }

      // Parse DuckDuckGo HTML results
      const $ = cheerio.load(html);
      const results: DuckDuckGoResult[] = [];

      // DuckDuckGo HTML results are in .result class elements
      $('.result').each((_, element) => {
        const $result = $(element);
        const titleEl = $result.find('.result__a');
        const snippetEl = $result.find('.result__snippet');
        const urlEl = $result.find('.result__url');
        let url = titleEl.attr('href') || '';
        const title = titleEl.text().trim();
        const snippet = snippetEl.text().trim();
        const domain = urlEl.text().trim();

        // DuckDuckGo uses redirect URLs, extract the actual URL
        if (url.includes('uddg=')) {
          const match = url.match(/uddg=([^&]+)/);
          if (match) {
            url = decodeURIComponent(match[1]);
          }
        }

        if (url && title && !url.includes('duckduckgo.com')) {
          results.push({ url, title, snippet, domain });
        }
      });

      return results.slice(0, 10);
    } catch (error: any) {
      this.logger.log(color.red(`[DuckDuckGo] Search error: ${error.message}`));
      return [];
    }
  }

  // Convenience method for music release year searches
  public async searchMusicRelease(artist: string, title: string): Promise<DuckDuckGoResult[]> {
    const query = `${artist} - ${title} (song) release date`;
    return this.search(query);
  }
}
