import type { PbCustomerInfo } from '../../src/printers/printenbindV2Request';

export type EnvName = 'sandbox' | 'live';
export type Step = 'calculate' | 'place' | 'delete' | 'verify' | 'search';

export interface Host {
  env: EnvName;
  baseUrl: string;
  key: string | null;
  /** sha256 of the key, first 12 hex: the same as _scripts/pb-quote-check.mjs */
  fingerprint: string;
}

/** One HTTP call to Print&Bind, as sent and as answered. */
export interface Exchange {
  step: Step | 'me' | 'list';
  method: string;
  url: string;
  requestBody?: unknown;
  /** ISO time the request left */
  at: string;
  ms: number;
  /** null when no HTTP answer came back */
  status: number | null;
  statusText: string;
  headers: Record<string, string>;
  body: unknown;
  bodyBytes: number;
  /** timeout, ECONNRESET, … when there was no answer */
  networkError?: string;
  /** file under requests/ holding the full exchange */
  file?: string;
}

/** A printer PDF a case sends, as found on api.qrsong.io. */
export interface FileInfo {
  url: string;
  kind: 'cards' | 'insert';
  bytes: number | null;
  pages: number | null;
  /** HTTP status of the download, or the error */
  fetch: string;
}

/** One order line of a real production order, without personal data. */
export interface FixtureLine {
  paymentDbId: number;
  created: string;
  countrycode: string;
  fast: boolean;
  phpId: number;
  playlistName: string;
  numberOfTracks: number;
  amount: number;
  subType: string;
  addHowToCard: boolean;
  boxEnabled: boolean;
  boxQuantity: number;
  boxFilename: string | null;
  printerPageCount: number;
  /** printer files, one per copy (payment_has_playlist_item), or the line's own */
  cardFiles: string[];
  usesItems: boolean;
  physicalLines: number;
}

/** A stored V2 exchange that got a 5xx, with the address taken out. */
export interface ReplayFixture {
  paymentDbId: number;
  created: string;
  url: string;
  status: number;
  responseBody: unknown;
  /** the request as sent, contact fields removed */
  request: Record<string, any>;
}

export interface Fixtures {
  generatedAt: string;
  fileBase: string;
  shapes: Record<string, FixtureLine[]>;
  mergedInsert: { paymentDbId: number; url: string; lines: FixtureLine[] } | null;
  replays: ReplayFixture[];
  files: Record<string, FileInfo>;
}

export interface HarnessCase {
  id: string;
  title: string;
  group: 'deck' | 'box' | 'international' | 'probe' | 'replay';
  /** REST articles, exactly as production sends them */
  articles: Record<string, any>[];
  country: string;
  /** label variations on top of the configured address */
  customerOverrides?: Partial<PbCustomerInfo>;
  fast: boolean;
  /** the order comment production would send ('' for none) */
  orderComment: string;
  files: FileInfo[];
  /** expected copies per article vs the real page count of its file */
  pageChecks: { article: number; copies: number; pages: number | null }[];
  /** whether place + delete may run on live (an address exists for the country) */
  livePlaceable: boolean;
  notes: string[];
  source: string;
}

export interface Attempt {
  caseId: string;
  env: EnvName;
  n: number;
  reference: string | null;
  calculate?: Exchange;
  place?: Exchange;
  orderId?: string;
  deletes: Exchange[];
  verify?: Exchange;
  search?: Exchange;
  orphan?: { orderId: string; status: string | null };
  /** null when nothing was placed */
  cancelled: boolean | null;
  orderStatus?: string | null;
  skipped?: string;
  notes: string[];
}

export interface HostReport {
  env: EnvName;
  baseUrl: string;
  fingerprint: string;
  reachable: boolean;
  problem?: string;
  accountId?: string | number;
  accountName?: string;
  me?: Exchange;
}

export interface RunOptions {
  envs: EnvName[];
  cases: string[] | 'all';
  repeat: number;
  mode: 'calculate' | 'place' | 'both';
  concurrency: number;
  maxLiveOrders: number;
  timeoutMs: number;
}

export interface RunResult {
  runId: string;
  startedAt: string;
  finishedAt?: string;
  gitSha: string;
  machine: string;
  publicIp: string | null;
  options: RunOptions;
  hosts: HostReport[];
  cases: HarnessCase[];
  attempts: Attempt[];
  uncancelled: { env: EnvName; orderId: string; reference: string | null }[];
  aborted?: string;
}
