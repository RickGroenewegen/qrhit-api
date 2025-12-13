export type SourceType =
  | 'wikipedia'
  | 'musicbrainz'
  | 'discogs'
  | 'allmusic'
  | 'genius'
  | 'billboard'
  | 'spotify'
  | 'other';

export interface EvidenceItem {
  source: string;
  sourceType: SourceType;
  year: number;
  confidence: number;
  snippet: string;
  fetchedAt: Date;
}

export interface AgentResult {
  year: number;
  confidence: number;
  reasoning: string;
  sourcesCount: number;
  evidence?: EvidenceItem[];
}

export interface SearchResult {
  url: string;
  title: string;
  snippet: string;
}
