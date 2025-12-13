import { StateGraph, START, END, Annotation } from '@langchain/langgraph';
import { ChatOpenAI } from '@langchain/openai';
import { PlaywrightCrawler, Configuration, log as crawleeLog, LogLevel } from 'crawlee';
import { chromium, Browser, BrowserContext } from 'playwright';
import * as cheerio from 'cheerio';
import Logger from './logger';
import { color } from 'console-log-colors';
import { Solver } from '2captcha-ts';
import { DuckDuckGoSearch } from './duckduckgo';
import Cache from './cache';
import {
  EvidenceItem,
  AgentResult,
  SearchResult,
  SourceType,
} from './interfaces/ReleaseYearResearch';

// Configuration Constants
const LANGGRAPH_CONFIG = {
  ENABLED: true,
  MODEL: 'gpt-4o-mini',
  MAX_PAGES: 10,
  MAX_RETRIES: 2,
  TIMEOUT_MS: 60000,
  MIN_CONFIDENCE: 0.6,
  MAX_CONCURRENCY: 3,
  REQUEST_TIMEOUT_SECS: 30,
  // Delay between track research calls (ms) to avoid rate limiting when processing bulk lists
  MIN_DELAY_BETWEEN_TRACKS_MS: 2000,
  // CAPTCHA solving config
  CAPTCHA_ENABLED: true,
  CAPTCHA_TIMEOUT_MS: 120000, // 2 minutes max for CAPTCHA solving
} as const;

// Source reliability weights
const SOURCE_WEIGHTS: Record<SourceType, number> = {
  wikipedia: 0.9,
  musicbrainz: 0.85,
  allmusic: 0.85,
  discogs: 0.8,
  billboard: 0.75,
  genius: 0.5,
  spotify: 0.6,
  other: 0.4,
};

// State annotation for LangGraph
const ResearchStateAnnotation = Annotation.Root({
  artist: Annotation<string>,
  title: Annotation<string>,
  searchQueries: Annotation<string[]>({
    reducer: (prev, next) => [...(prev || []), ...(next || [])],
    default: () => [],
  }),
  urlsToFetch: Annotation<string[]>({
    reducer: (prev, next) => [...new Set([...(prev || []), ...(next || [])])],
    default: () => [],
  }),
  fetchedPages: Annotation<Map<string, string>>({
    reducer: (prev, next) => new Map([...(prev || new Map()), ...(next || new Map())]),
    default: () => new Map(),
  }),
  evidence: Annotation<EvidenceItem[]>({
    reducer: (prev, next) => [...(prev || []), ...(next || [])],
    default: () => [],
  }),
  scoredEvidence: Annotation<EvidenceItem[]>({
    reducer: (_, next) => next || [],
    default: () => [],
  }),
  candidateYears: Annotation<Map<number, number>>({
    reducer: (_, next) => next || new Map(),
    default: () => new Map(),
  }),
  finalYear: Annotation<number>({
    reducer: (_, next) => next ?? 0,
    default: () => 0,
  }),
  confidence: Annotation<number>({
    reducer: (_, next) => next ?? 0,
    default: () => 0,
  }),
  reasoning: Annotation<string>({
    reducer: (_, next) => next ?? '',
    default: () => '',
  }),
  retryCount: Annotation<number>({
    reducer: (_, next) => next ?? 0,
    default: () => 0,
  }),
  errors: Annotation<string[]>({
    reducer: (prev, next) => [...(prev || []), ...(next || [])],
    default: () => [],
  }),
});

type ResearchState = typeof ResearchStateAnnotation.State;

// Redis keys for Crawlee session persistence
const CRAWLEE_COOKIES_KEY = 'crawlee:cookies';
const CRAWLEE_COOKIES_TTL = 7200; // 2 hours

export class ReleaseYearAgent {
  private static instance: ReleaseYearAgent;
  private logger = new Logger();
  private openai: ChatOpenAI;
  private graph: ReturnType<typeof this.buildGraph>;
  private lastResearchTime: number = 0;
  private captchaSolver: Solver | null = null;
  private duckDuckGo = DuckDuckGoSearch.getInstance();
  private cache = Cache.getInstance();
  // Store cookies per domain for persistence
  private domainCookies: Map<string, string[]> = new Map();
  // Persist a consistent User-Agent per session to look like same browser
  private persistentUserAgent: string;
  // Persistent browser instance (kept open between track searches)
  private browser: Browser | null = null;
  private browserContext: BrowserContext | null = null;
  private browserInitializing: Promise<void> | null = null;

  private constructor() {
    this.openai = new ChatOpenAI({
      modelName: LANGGRAPH_CONFIG.MODEL,
      temperature: 0.2,
      openAIApiKey: process.env['OPENAI_TOKEN'],
    });
    this.graph = this.buildGraph();

    // Initialize CAPTCHA solver if API key is available
    if (process.env['TWOCAPTCHA_API_KEY'] && LANGGRAPH_CONFIG.CAPTCHA_ENABLED) {
      this.captchaSolver = new Solver(process.env['TWOCAPTCHA_API_KEY']);
    }

    // Pick a consistent User-Agent for this agent instance (like a real browser)
    const userAgents = [
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15',
    ];
    this.persistentUserAgent = userAgents[Math.floor(Math.random() * userAgents.length)];

    // Load cookies from Redis on startup
    this.loadCookiesFromRedis();

    // Initialize browser on startup
    this.browserInitializing = this.initBrowser();
  }

  // Initialize persistent browser
  private async initBrowser(): Promise<void> {
    try {
      this.browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-blink-features=AutomationControlled',
        ],
      });

      this.browserContext = await this.browser.newContext({
        userAgent: this.persistentUserAgent,
        viewport: { width: 1920, height: 1080 },
        locale: 'en-US',
        timezoneId: 'America/New_York',
      });

    } catch (error: any) {
      this.logger.log(color.red(`[LangGraph] Failed to initialize browser: ${error.message}`));
    }
  }

  // Ensure browser is ready
  private async ensureBrowser(): Promise<BrowserContext | null> {
    if (this.browserInitializing) {
      await this.browserInitializing;
      this.browserInitializing = null;
    }

    // Reconnect if browser was closed
    if (!this.browser || !this.browserContext) {
      await this.initBrowser();
    }

    return this.browserContext;
  }

  // Cleanup browser on shutdown
  public async closeBrowser(): Promise<void> {
    if (this.browserContext) {
      await this.browserContext.close();
      this.browserContext = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
    }
    this.logger.log(color.yellow('[LangGraph] Browser closed'));
  }

  // Load cookies from Redis
  private async loadCookiesFromRedis(): Promise<void> {
    try {
      const cookiesJson = await this.cache.get(CRAWLEE_COOKIES_KEY, false);
      if (cookiesJson) {
        const cookiesData = JSON.parse(cookiesJson);
        this.domainCookies = new Map(Object.entries(cookiesData));
        this.logger.log(color.green(`[LangGraph] Loaded cookies for ${this.domainCookies.size} domains from Redis`));
      }
    } catch (error: any) {
      this.logger.log(color.yellow(`[LangGraph] Could not load cookies from Redis: ${error.message}`));
    }
  }

  // Save cookies to Redis
  private async saveCookiesToRedis(): Promise<void> {
    try {
      const cookiesData = Object.fromEntries(this.domainCookies);
      await this.cache.set(CRAWLEE_COOKIES_KEY, JSON.stringify(cookiesData), CRAWLEE_COOKIES_TTL);
    } catch (error: any) {
      this.logger.log(color.yellow(`[LangGraph] Could not save cookies to Redis: ${error.message}`));
    }
  }

  // Extract domain from URL
  private getDomain(url: string): string {
    try {
      return new URL(url).hostname;
    } catch {
      return '';
    }
  }

  public static getInstance(): ReleaseYearAgent {
    if (!ReleaseYearAgent.instance) {
      ReleaseYearAgent.instance = new ReleaseYearAgent();
    }
    return ReleaseYearAgent.instance;
  }

  private buildGraph() {
    const graph = new StateGraph(ResearchStateAnnotation)
      .addNode('search', this.searchNode.bind(this))
      .addNode('fetch', this.fetchNode.bind(this))
      .addNode('extract', this.extractNode.bind(this))
      .addNode('score', this.scoreNode.bind(this))
      .addNode('resolve', this.resolveNode.bind(this))
      .addNode('answer', this.answerNode.bind(this))
      .addEdge(START, 'search')
      .addEdge('search', 'fetch')
      .addEdge('fetch', 'extract')
      .addEdge('extract', 'score')
      .addEdge('score', 'resolve')
      .addConditionalEdges('resolve', this.shouldRetryOrAnswer.bind(this), {
        retry: 'search',
        answer: 'answer',
      })
      .addEdge('answer', END);

    return graph.compile();
  }

  // Node 1: Generate search queries
  private async searchNode(state: ResearchState): Promise<Partial<ResearchState>> {
    const { artist, title, retryCount } = state;

    // Base queries
    const queries = [
      `"${artist}" "${title}" release date year`,
      `"${title}" by "${artist}" original release`,
      `${artist} ${title} wikipedia`,
      `${artist} ${title} discography`,
    ];

    // Add refined queries on retry
    if (retryCount > 0) {
      queries.push(
        `${artist} ${title} single album release year`,
        `${artist} ${title} first release original`,
      );
    }

    return { searchQueries: queries };
  }

  // Node 2: Fetch web pages using Playwright (persistent browser)
  private async fetchNode(state: ResearchState): Promise<Partial<ResearchState>> {
    const { searchQueries, artist, title } = state;

    const newUrls: string[] = [];

    // Perform DuckDuckGo searches sequentially (to avoid rate limiting)
    // Using only 2 queries to reduce CAPTCHA risk
    for (const query of searchQueries.slice(-2)) {
      try {
        const results = await this.duckDuckGo.search(query);
        newUrls.push(...results.map((r) => r.url));
      } catch (error: any) {
        this.logger.log(color.red(`[LangGraph] Search error: ${error.message}`));
      }
    }

    // Dedupe and limit URLs
    const uniqueUrls = [...new Set(newUrls)].slice(0, LANGGRAPH_CONFIG.MAX_PAGES);

    if (uniqueUrls.length === 0) {
      return { errors: ['No URLs found from search'] };
    }

    // Fetch pages with Playwright (persistent browser)
    const fetchedPages = new Map<string, string>();

    try {
      // Silence Crawlee's verbose logging in production, allow INFO in development
      crawleeLog.setLevel(process.env['ENVIRONMENT'] === 'development' ? LogLevel.INFO : LogLevel.ERROR);

      // Ensure browser is ready
      const browserContext = await this.ensureBrowser();
      if (!browserContext) {
        this.logger.log(color.red('[LangGraph] Browser not available'));
        return { errors: ['Browser not available'], urlsToFetch: uniqueUrls, fetchedPages };
      }

      // Use persistent storage directory
      const config = new Configuration({
        storageClientOptions: {
          localDataDirectory: `/tmp/crawlee-langgraph-persistent`,
        },
        persistStorage: true,
      });

      const crawler = new PlaywrightCrawler(
        {
          // Use our persistent browser context
          launchContext: {
            launcher: chromium,
            launchOptions: {
              headless: true,
              args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-blink-features=AutomationControlled',
              ],
            },
          },
          // Reuse browser context to maintain cookies/session
          browserPoolOptions: {
            useFingerprints: false,
            preLaunchHooks: [
              async (pageId, launchContext) => {
                launchContext.userAgent = this.persistentUserAgent;
              },
            ],
          },
          maxConcurrency: LANGGRAPH_CONFIG.MAX_CONCURRENCY,
          maxRequestRetries: 1,
          requestHandlerTimeoutSecs: LANGGRAPH_CONFIG.REQUEST_TIMEOUT_SECS,
          maxRequestsPerCrawl: LANGGRAPH_CONFIG.MAX_PAGES,
          // Use persistent session pool for cookie management (2 hour sessions)
          useSessionPool: true,
          persistCookiesPerSession: true,
          sessionPoolOptions: {
            maxPoolSize: 10,
            sessionOptions: {
              maxAgeSecs: 7200, // 2 hours
              maxUsageCount: 500,
            },
          },
          requestHandler: async ({ request, page }) => {
            // Random delay to look human
            await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1500));

            const html = await page.content();

            // Check for CAPTCHA
            const captchaDetection = this.detectCaptcha(html, request.url);
            if (captchaDetection.hasCaptcha) {
              this.logger.log(color.yellow(`[LangGraph] CAPTCHA detected (${captchaDetection.type}) on ${request.url}, sitekey: ${captchaDetection.sitekey || 'NOT FOUND'}`));

              if (this.captchaSolver && captchaDetection.sitekey) {
                this.logger.log(color.blue(`[LangGraph] Solving ${captchaDetection.type} CAPTCHA...`));
                const solution = await this.solveCaptcha(
                  request.url,
                  captchaDetection.type,
                  captchaDetection.sitekey
                );

                if (solution.success && solution.token) {
                  this.logger.log(color.green(`[LangGraph] CAPTCHA solved, submitting token...`));

                  // Submit the CAPTCHA token via JavaScript
                  try {
                    if (captchaDetection.type === 'hcaptcha') {
                      // For hCaptcha, set the response and submit
                      await page.evaluate((token) => {
                        // Set hCaptcha response
                        const textarea = document.querySelector('[name="h-captcha-response"]') as HTMLTextAreaElement;
                        if (textarea) textarea.value = token;
                        // Also try setting via hcaptcha API if available
                        if ((window as any).hcaptcha) {
                          (window as any).hcaptcha.setResponse(token);
                        }
                        // Submit the form
                        const form = document.querySelector('form');
                        if (form) form.submit();
                      }, solution.token);
                    } else if (captchaDetection.type === 'recaptcha_v2') {
                      // For reCAPTCHA v2, set the response and callback
                      await page.evaluate((token) => {
                        const textarea = document.querySelector('[name="g-recaptcha-response"]') as HTMLTextAreaElement;
                        if (textarea) textarea.value = token;
                        // Try to trigger the callback
                        if ((window as any).grecaptcha) {
                          const callback = (window as any).grecaptcha.getResponse;
                          if (callback) callback();
                        }
                        const form = document.querySelector('form');
                        if (form) form.submit();
                      }, solution.token);
                    }

                    // Wait for navigation after CAPTCHA submission
                    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});

                    // Get the new page content after CAPTCHA
                    const newHtml = await page.content();
                    const newCaptchaCheck = this.detectCaptcha(newHtml, request.url);

                    if (!newCaptchaCheck.hasCaptcha) {
                      this.logger.log(color.green(`[LangGraph] CAPTCHA bypass successful for ${request.url}`));
                      fetchedPages.set(request.url, newHtml);
                      return;
                    } else {
                      this.logger.log(color.yellow(`[LangGraph] CAPTCHA still present after submission`));
                    }
                  } catch (evalError: any) {
                    this.logger.log(color.red(`[LangGraph] CAPTCHA submission error: ${evalError.message}`));
                  }
                } else {
                  this.logger.log(color.red(`[LangGraph] CAPTCHA solving failed: ${solution.error}`));
                }
              }

              // Skip pages with unsolvable CAPTCHAs
              if (captchaDetection.type === 'image' || captchaDetection.type === 'unknown' || !captchaDetection.sitekey) {
                this.logger.log(color.yellow(`[LangGraph] Skipping page with unsolvable CAPTCHA`));
                return;
              }
            } else {
              // No CAPTCHA, store the page
              fetchedPages.set(request.url, html);
            }
          },
          failedRequestHandler: async ({ request }) => {
            this.logger.log(color.red(`[LangGraph] Failed to fetch: ${request.url}`));
          },
        },
        config
      );

      await Promise.race([
        crawler.run(uniqueUrls),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Crawl timeout')), LANGGRAPH_CONFIG.TIMEOUT_MS)
        ),
      ]);

      // Save cookies to Redis after crawl completes
      await this.saveCookiesToRedis();
    } catch (error: any) {
      this.logger.log(color.red(`[LangGraph] Crawl error: ${error.message}`));
    }

    return {
      urlsToFetch: uniqueUrls,
      fetchedPages,
    };
  }

  // Node 3: Extract year evidence from fetched pages
  private async extractNode(state: ResearchState): Promise<Partial<ResearchState>> {
    const { artist, title, fetchedPages } = state;

    const evidence: EvidenceItem[] = [];

    for (const [url, html] of fetchedPages) {
      try {
        const $ = cheerio.load(html);
        const sourceType = this.classifySource(url);
        const extracted = await this.extractYearFromPage($, artist, title, url, sourceType);

        if (extracted.year > 0) {
          evidence.push({
            source: url,
            sourceType,
            year: extracted.year,
            confidence: extracted.confidence,
            snippet: extracted.snippet,
            fetchedAt: new Date(),
          });
        }
      } catch (error: any) {
        this.logger.log(color.red(`[LangGraph] Extract error for ${url}: ${error.message}`));
      }
    }

    return { evidence };
  }

  // Node 4: Score evidence reliability
  private async scoreNode(state: ResearchState): Promise<Partial<ResearchState>> {
    const { evidence } = state;

    const scoredEvidence = evidence.map((item) => ({
      ...item,
      confidence: item.confidence * SOURCE_WEIGHTS[item.sourceType],
    }));

    // Sort by confidence descending
    scoredEvidence.sort((a, b) => b.confidence - a.confidence);

    return { scoredEvidence };
  }

  // Node 5: Resolve conflicts between evidence
  private async resolveNode(state: ResearchState): Promise<Partial<ResearchState>> {
    const { artist, title, scoredEvidence, retryCount } = state;

    // Group by year and calculate weighted scores
    const yearScores = new Map<number, number>();

    for (const item of scoredEvidence) {
      const currentScore = yearScores.get(item.year) || 0;
      yearScores.set(item.year, currentScore + item.confidence);
    }

    // Calculate confidence from score distribution
    const scores = Array.from(yearScores.values());
    const totalScore = scores.reduce((a, b) => a + b, 0);
    const maxScore = Math.max(...scores, 0);
    const confidence = totalScore > 0 ? maxScore / totalScore : 0;

    // Check if we need to use LLM to resolve conflicts
    const years = Array.from(yearScores.keys());
    const variance = this.calculateVariance(years);

    if (variance > 10 && scoredEvidence.length > 2 && confidence < 0.7) {
      // Use LLM to resolve conflicts
      try {
        const resolution = await this.llmResolveConflict(artist, title, scoredEvidence);
        return {
          candidateYears: new Map([[resolution.year, 1.0]]),
          retryCount: retryCount + 1,
        };
      } catch (error: any) {
        this.logger.log(color.red(`[LangGraph] LLM resolve error: ${error.message}`));
      }
    }

    return {
      candidateYears: yearScores,
      retryCount: retryCount + 1,
    };
  }

  // Node 6: Generate final answer
  private async answerNode(state: ResearchState): Promise<Partial<ResearchState>> {
    const { artist, title, candidateYears, scoredEvidence } = state;

    // Find highest scored year
    let bestYear = 0;
    let bestScore = 0;

    for (const [year, score] of candidateYears) {
      if (score > bestScore) {
        bestScore = score;
        bestYear = year;
      }
    }

    // Calculate overall confidence
    const totalScore = Array.from(candidateYears.values()).reduce((a, b) => a + b, 0);
    let confidence = totalScore > 0 ? bestScore / totalScore : 0;

    // Adjust confidence based on evidence count
    if (scoredEvidence.length < 2) confidence *= 0.5;
    else if (scoredEvidence.length < 4) confidence *= 0.8;
    else if (scoredEvidence.length > 6) confidence = Math.min(confidence * 1.1, 0.95);

    // Generate reasoning
    const topSources = scoredEvidence
      .filter((e) => e.year === bestYear)
      .slice(0, 3)
      .map((e) => `${e.sourceType} (${e.snippet.slice(0, 50)}...)`)
      .join(', ');

    const reasoning =
      scoredEvidence.length > 0
        ? `Year ${bestYear} supported by ${scoredEvidence.filter((e) => e.year === bestYear).length} sources: ${topSources}`
        : 'No reliable evidence found';

    return {
      finalYear: bestYear,
      confidence: Math.min(confidence, 0.95),
      reasoning,
    };
  }

  // Conditional routing: should we retry or answer?
  private shouldRetryOrAnswer(state: ResearchState): 'retry' | 'answer' {
    const { candidateYears, retryCount, scoredEvidence } = state;

    const scores = Array.from(candidateYears.values());
    const totalScore = scores.reduce((a, b) => a + b, 0);
    const maxScore = Math.max(...scores, 0);
    const confidence = totalScore > 0 ? maxScore / totalScore : 0;

    // Retry if low confidence and haven't exceeded max retries
    if (
      confidence < LANGGRAPH_CONFIG.MIN_CONFIDENCE &&
      scoredEvidence.length < 3 &&
      retryCount < LANGGRAPH_CONFIG.MAX_RETRIES
    ) {
      this.logger.log(
        color.gray(
          `[LangGraph] Low confidence (${(confidence * 100).toFixed(1)}%), retrying (${retryCount + 1}/${LANGGRAPH_CONFIG.MAX_RETRIES})`
        )
      );
      return 'retry';
    }

    return 'answer';
  }

  // Helper: Classify source type from URL
  private classifySource(url: string): SourceType {
    const patterns: [RegExp, SourceType][] = [
      [/wikipedia\.org/, 'wikipedia'],
      [/musicbrainz\.org/, 'musicbrainz'],
      [/allmusic\.com/, 'allmusic'],
      [/discogs\.com/, 'discogs'],
      [/billboard\.com/, 'billboard'],
      [/genius\.com/, 'genius'],
      [/spotify\.com/, 'spotify'],
    ];

    for (const [pattern, sourceType] of patterns) {
      if (pattern.test(url)) {
        return sourceType;
      }
    }

    return 'other';
  }

  // Helper: Extract year from a page using source-specific patterns
  private async extractYearFromPage(
    $: cheerio.CheerioAPI,
    artist: string,
    title: string,
    url: string,
    sourceType: SourceType
  ): Promise<{ year: number; confidence: number; snippet: string }> {
    let year = 0;
    let confidence = 0.5;
    let snippet = '';

    const currentYear = new Date().getFullYear();
    const yearPattern = /\b(19[0-9]{2}|20[0-2][0-9])\b/g;

    try {
      switch (sourceType) {
        case 'wikipedia': {
          // Try infobox first
          const infobox = $('.infobox');
          const releasedRow = infobox.find('th:contains("Released")').next('td').text();

          if (releasedRow) {
            const matches = releasedRow.match(yearPattern);
            if (matches) {
              year = parseInt(matches[0], 10);
              confidence = 0.9;
              snippet = `Released: ${releasedRow.slice(0, 100)}`;
            }
          }

          // Fallback to first paragraphs
          if (year === 0) {
            const firstParagraphs = $('p').slice(0, 5).text();
            const matches = firstParagraphs.match(yearPattern);
            if (matches) {
              // Find the earliest valid year
              const years = matches
                .map((m) => parseInt(m, 10))
                .filter((y) => y >= 1900 && y <= currentYear);
              if (years.length > 0) {
                year = Math.min(...years);
                confidence = 0.7;
                snippet = firstParagraphs.slice(0, 150);
              }
            }
          }
          break;
        }

        case 'discogs': {
          // Look for year in profile section
          const profileYear = $('a[href*="/year/"]').first().text();
          if (profileYear) {
            const parsed = parseInt(profileYear, 10);
            if (parsed >= 1900 && parsed <= currentYear) {
              year = parsed;
              confidence = 0.8;
              snippet = `Discogs year: ${profileYear}`;
            }
          }
          break;
        }

        case 'allmusic': {
          const releaseDate = $('.release-date').text();
          const matches = releaseDate.match(yearPattern);
          if (matches) {
            year = parseInt(matches[0], 10);
            confidence = 0.85;
            snippet = `AllMusic: ${releaseDate}`;
          }
          break;
        }

        case 'genius': {
          const releaseInfo = $('.metadata_unit-info').text();
          const matches = releaseInfo.match(yearPattern);
          if (matches) {
            year = parseInt(matches[0], 10);
            confidence = 0.7;
            snippet = `Genius: ${releaseInfo.slice(0, 100)}`;
          }
          break;
        }

        default: {
          // Generic extraction from page body
          const bodyText = $('body').text().slice(0, 5000);
          const matches = bodyText.match(yearPattern);
          if (matches) {
            // Count occurrences of each year
            const yearCounts = new Map<number, number>();
            for (const match of matches) {
              const y = parseInt(match, 10);
              if (y >= 1900 && y <= currentYear) {
                yearCounts.set(y, (yearCounts.get(y) || 0) + 1);
              }
            }

            // Get the most common year
            let maxCount = 0;
            for (const [y, count] of yearCounts) {
              if (count > maxCount) {
                maxCount = count;
                year = y;
              }
            }

            if (year > 0) {
              confidence = 0.4;
              snippet = `Generic extraction: ${year} mentioned ${maxCount} times`;
            }
          }
          break;
        }
      }
    } catch (error: any) {
      this.logger.log(color.red(`[LangGraph] Extraction error: ${error.message}`));
    }

    return { year, confidence, snippet };
  }

  // Helper: Calculate variance of years
  private calculateVariance(years: number[]): number {
    if (years.length === 0) return 0;
    const mean = years.reduce((a, b) => a + b, 0) / years.length;
    const squaredDiffs = years.map((y) => Math.pow(y - mean, 2));
    return squaredDiffs.reduce((a, b) => a + b, 0) / years.length;
  }

  // Helper: Use LLM to resolve conflicting evidence
  private async llmResolveConflict(
    artist: string,
    title: string,
    evidence: EvidenceItem[]
  ): Promise<{ year: number; confidence: number; reasoning: string }> {
    const evidenceText = evidence
      .map(
        (e) =>
          `- ${e.sourceType} (${e.source}): ${e.year} - "${e.snippet.slice(0, 100)}"`
      )
      .join('\n');

    const prompt = `Analyze these conflicting release year claims for "${title}" by "${artist}":

${evidenceText}

IMPORTANT RULES:
1. For classical songs: Return the year of ORIGINAL COMPOSITION, not the year of any recording or release
2. For TV show theme songs: Return the year of FIRST AIRING of the show, not when the soundtrack was released
3. For regular songs: Return the ORIGINAL release year (not re-releases, remasters, or compilations)
4. Consider single release vs album release - prefer the earlier date
5. Consider regional differences - prefer the earliest worldwide release

Return the most likely year following these rules as a JSON object with fields: year (number), confidence (0-1), reasoning (string).`;

    const response = await this.openai.invoke([
      {
        role: 'system',
        content:
          'You are an expert music historian. For classical songs, always return the year of original composition. For TV show theme songs, return the year the show first aired. Return only valid JSON with year, confidence, and reasoning fields.',
      },
      { role: 'user', content: prompt },
    ]);

    try {
      const content =
        typeof response.content === 'string'
          ? response.content
          : JSON.stringify(response.content);
      const parsed = JSON.parse(content.replace(/```json\n?|\n?```/g, ''));
      return {
        year: parsed.year || 0,
        confidence: parsed.confidence || 0.5,
        reasoning: parsed.reasoning || 'LLM analysis',
      };
    } catch {
      return { year: 0, confidence: 0, reasoning: 'Failed to parse LLM response' };
    }
  }

  // Rate limit helper - ensures minimum delay between research calls
  private async rateLimitDelay(): Promise<void> {
    const timeSinceLastRequest = Date.now() - this.lastResearchTime;
    const delay = timeSinceLastRequest < LANGGRAPH_CONFIG.MIN_DELAY_BETWEEN_TRACKS_MS
      ? LANGGRAPH_CONFIG.MIN_DELAY_BETWEEN_TRACKS_MS - timeSinceLastRequest
      : 0;

    if (delay > 0) {
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }

  // CAPTCHA detection helper - checks if HTML contains a CAPTCHA challenge
  private detectCaptcha(html: string, url: string): { hasCaptcha: boolean; type: string; sitekey?: string } {
    const lowerHtml = html.toLowerCase();

    // DuckDuckGo CAPTCHA detection
    if (url.includes('duckduckgo.com') && (
      lowerHtml.includes('select all squares') ||
      lowerHtml.includes('captcha') ||
      lowerHtml.includes('please verify')
    )) {
      return { hasCaptcha: true, type: 'image' };
    }

    // Google reCAPTCHA v2 detection
    const recaptchaV2Match = html.match(/data-sitekey="([^"]+)"/);
    if (recaptchaV2Match || lowerHtml.includes('g-recaptcha')) {
      return {
        hasCaptcha: true,
        type: 'recaptcha_v2',
        sitekey: recaptchaV2Match?.[1],
      };
    }

    // Google reCAPTCHA v3 detection
    const recaptchaV3Match = html.match(/grecaptcha\.execute\s*\(\s*['"]([^'"]+)['"]/);
    if (recaptchaV3Match) {
      return {
        hasCaptcha: true,
        type: 'recaptcha_v3',
        sitekey: recaptchaV3Match[1],
      };
    }

    // hCaptcha detection - only detect BLOCKING captchas
    // Wikipedia has "hcaptcha" in config for edit protection, but the page loads fine
    // Only trigger on actual CAPTCHA challenge pages that block content
    const hasBlockingHCaptcha =
      // Actual hCaptcha widget div with data-sitekey
      (html.includes('class="h-captcha"') && html.includes('data-sitekey')) ||
      // hCaptcha iframe challenge
      html.includes('hcaptcha.com/captcha/') ||
      // hCaptcha challenge page (minimal content with captcha)
      (lowerHtml.includes('h-captcha') && !lowerHtml.includes('<article') && !lowerHtml.includes('<main'));

    if (hasBlockingHCaptcha) {
      // Extract sitekey from data-sitekey attribute
      const sitekeyMatch = html.match(/data-sitekey="([a-f0-9-]{36,})"/i);
      return {
        hasCaptcha: true,
        type: 'hcaptcha',
        sitekey: sitekeyMatch?.[1],
      };
    }

    // Cloudflare Turnstile detection
    const turnstileMatch = html.match(/data-sitekey="([^"]+)"[^>]*cf-turnstile/i) ||
      html.match(/cf-turnstile[^>]*data-sitekey="([^"]+)"/i);
    if (lowerHtml.includes('turnstile') || lowerHtml.includes('cf-challenge') || turnstileMatch) {
      const sitekeyMatch = html.match(/data-sitekey="([^"]+)"/);
      return {
        hasCaptcha: true,
        type: 'turnstile',
        sitekey: sitekeyMatch?.[1] || turnstileMatch?.[1],
      };
    }

    // Generic CAPTCHA patterns - only trigger on actual blocking pages
    // Skip if page has normal content (article, main, content sections)
    const hasNormalContent = lowerHtml.includes('<article') ||
      lowerHtml.includes('<main') ||
      lowerHtml.includes('id="content"') ||
      lowerHtml.includes('class="content"') ||
      lowerHtml.includes('id="mw-content-text"'); // Wikipedia content

    if (!hasNormalContent) {
      if (
        lowerHtml.includes('verify you are human') ||
        lowerHtml.includes('prove you are not a robot') ||
        lowerHtml.includes('security check') ||
        lowerHtml.includes('please complete the captcha')
      ) {
        return { hasCaptcha: true, type: 'unknown' };
      }
    }

    return { hasCaptcha: false, type: 'none' };
  }

  // CAPTCHA solving helper - attempts to solve detected CAPTCHAs
  private async solveCaptcha(
    url: string,
    captchaType: string,
    sitekey?: string
  ): Promise<{ success: boolean; token?: string; error?: string }> {
    if (!this.captchaSolver) {
      return { success: false, error: 'CAPTCHA solver not configured' };
    }

    try {
      let result: any;

      switch (captchaType) {
        case 'recaptcha_v2':
          if (!sitekey) return { success: false, error: 'Missing sitekey for reCAPTCHA' };
          result = await this.captchaSolver.recaptcha({
            pageurl: url,
            googlekey: sitekey,
          });
          break;

        case 'recaptcha_v3':
          if (!sitekey) return { success: false, error: 'Missing sitekey for reCAPTCHA v3' };
          result = await this.captchaSolver.recaptcha({
            pageurl: url,
            googlekey: sitekey,
            version: 'v3',
            action: 'verify',
            min_score: 0.5,
          });
          break;

        case 'hcaptcha':
          if (!sitekey) return { success: false, error: 'Missing sitekey for hCaptcha' };
          // Note: Wikipedia uses custom hCaptcha implementation that doesn't work with 2Captcha
          // Standard hCaptcha sites should work, but Wikipedia's ConfirmEdit extension uses
          // internal sitekeys that 2Captcha doesn't recognize
          this.logger.log(color.blue(`[LangGraph] Calling 2Captcha hcaptcha with sitekey=${sitekey}, pageurl=${url}`));
          result = await this.captchaSolver.hcaptcha({
            pageurl: url,
            sitekey: sitekey,
          });
          break;

        case 'turnstile':
          if (!sitekey) return { success: false, error: 'Missing sitekey for Turnstile' };
          result = await this.captchaSolver.cloudflareTurnstile({
            pageurl: url,
            sitekey: sitekey,
          });
          break;

        default:
          return { success: false, error: `Unsupported CAPTCHA type: ${captchaType}` };
      }

      if (result?.data) {
        return { success: true, token: result.data };
      }

      return { success: false, error: 'No solution returned' };
    } catch (error: any) {
      // Log full error details for debugging
      this.logger.log(color.red(`[LangGraph] CAPTCHA solving error: ${error.message}`));
      if (error.code) this.logger.log(color.red(`[LangGraph] Error code: ${error.code}`));
      if (error.response) this.logger.log(color.red(`[LangGraph] Response: ${JSON.stringify(error.response)}`));
      return { success: false, error: error.message };
    }
  }

  // Public API: Research release year
  public async research(artist: string, title: string): Promise<AgentResult> {
    if (!LANGGRAPH_CONFIG.ENABLED) {
      return {
        year: 0,
        confidence: 0,
        reasoning: 'Agent disabled',
        sourcesCount: 0,
      };
    }

    // Rate limit between track research calls
    await this.rateLimitDelay();
    this.lastResearchTime = Date.now();

    try {
      const initialState = {
        artist,
        title,
        retryCount: 0,
      };

      const result = await this.graph.invoke(initialState);

      return {
        year: result.finalYear,
        confidence: result.confidence,
        reasoning: result.reasoning,
        sourcesCount: result.scoredEvidence?.length || 0,
        evidence: result.scoredEvidence,
      };
    } catch (error: any) {
      this.logger.log(color.red(`[LangGraph] Research error: ${error.message}`));
      return {
        year: 0,
        confidence: 0,
        reasoning: `Error: ${error.message}`,
        sourcesCount: 0,
      };
    }
  }
}
