import { SITE_LOCALES } from '../data/shared/shared-data.generated';
import {
  getDeliveryTime,
  getPlaylist,
  getPrice,
  getSupportContact,
  searchFeaturedPlaylists,
} from './tools';

/**
 * The MCP server behind QRSong! in ChatGPT (POST /mcp, routes/mcpRoutes.ts):
 * a customer finds a ready-made playlist or gives their own playlist link in
 * the chat, hears what the printed cards cost and when they arrive, and gets
 * a link to the site to design the cards and pay. Nothing is ordered here.
 *
 * Stateless JSON-RPC over HTTP (MCP "streamable HTTP" without a stream or a
 * session): every tool is a read-only lookup, so one request gets one JSON
 * answer. No login: the tools give out nothing that is not on the site.
 */

export const MCP_SERVER_INFO = { name: 'qrsong', title: 'QRSong!', version: '1.0.0' };

/** Newest first; a client asking for another version gets the newest. */
const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

const INSTRUCTIONS = [
  'QRSong! turns a playlist into a music card game: one printed card per song, with a QR code on the front and the artist, title and year on the back. Players scan a card, hear the song and guess.',
  'A customer starts in one of two ways: a ready-made playlist (search_featured_playlists) or their own playlist on Spotify, YouTube Music, Apple Music, Deezer or Tidal (get_playlist with its share link).',
  'Nothing is ordered or paid in this conversation. Every playlist result has a url: give it to the customer as the next step. On that page they design the cards and pay.',
  'Only quote amounts and delivery times these tools returned, exactly as returned. Do not calculate prices yourself and do not mention discounts.',
  'Only printed cards are offered here. Do not offer other formats.',
  'Do not ask for a name, address, e-mail or payment details: the site asks for them at checkout.',
  'Answer in the language of the customer and pass that language as locale. Pass country when the customer named where they live or where the cards go.',
  'Do not compare with or name other card games.',
].join('\n');

const LOCALE_CODES = SITE_LOCALES.map((l) => l.code);

const localeProperty = {
  type: 'string',
  enum: LOCALE_CODES,
  description: 'The language of the conversation, for the language of the page the url opens.',
};
const countryProperty = {
  type: 'string',
  pattern: '^[A-Za-z]{2}$',
  description:
    'Two-letter country code (ISO 3166-1) of where the customer is or where the cards go, when they said so. Sets the currency.',
};

interface ToolDefinition {
  name: string;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True when the tool reaches outside our own data (a music service). */
  openWorld: boolean;
  run: (args: Record<string, any>) => Promise<unknown> | unknown;
}

const TOOLS: ToolDefinition[] = [
  {
    name: 'search_featured_playlists',
    title: 'Find a ready-made playlist',
    description:
      'Use this when the customer wants a music card game and has no playlist of their own, or asks what is available (a decade, a genre, a theme, a language). ' +
      'Returns ready-made playlists with the number of cards, the price of the printed cards and the url where the customer designs and orders them. Without query, genre or decade it returns the most popular ones in their country.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', maxLength: 100, description: 'Words to look for, e.g. "party", "Christmas", "Dutch hits".' },
        genre: { type: 'string', maxLength: 50, description: 'A music genre, e.g. "rock", "pop", "hip hop".' },
        decade: { type: 'string', maxLength: 10, description: 'A decade, e.g. "1980s" or "80s".' },
        locale: localeProperty,
        country: countryProperty,
        limit: { type: 'integer', minimum: 1, maximum: 10, description: 'How many playlists to return, 5 when left out.' },
      },
      additionalProperties: false,
    },
    openWorld: false,
    run: (args) => searchFeaturedPlaylists(args),
  },
  {
    name: 'get_playlist',
    title: 'Read a playlist link',
    description:
      'Use this when the customer gives the link of their own playlist on Spotify, YouTube Music, Apple Music, Deezer or Tidal. ' +
      'Returns its name, the number of songs (one card each), the price of the printed cards and the url where the customer designs and orders them.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', maxLength: 500, description: 'The share link of the playlist.' },
        locale: localeProperty,
        country: countryProperty,
      },
      required: ['url'],
      additionalProperties: false,
    },
    openWorld: true,
    run: (args) => getPlaylist(args as { url: string }),
  },
  {
    name: 'get_price',
    title: 'Price of printed cards',
    description:
      'Use this when the customer asks what the cards cost for a number of songs, several sets, a gift box, the QRGames add-on or shipping to a country. ' +
      'Returns the amounts from the checkout calculator in the currency of that country.',
    inputSchema: {
      type: 'object',
      properties: {
        cards: { type: 'integer', minimum: 1, maximum: 2000, description: 'The number of songs in the playlist: one card per song.' },
        sets: { type: 'integer', minimum: 1, maximum: 20, description: 'How many copies of the same set, 1 when left out.' },
        giftBox: { type: 'boolean', description: 'With the printed gift box that holds the cards.' },
        games: { type: 'boolean', description: 'With QRGames, the paid add-on with quiz and bingo games for the playlist.' },
        country: countryProperty,
        locale: localeProperty,
      },
      required: ['cards'],
      additionalProperties: false,
    },
    openWorld: false,
    run: (args) => getPrice(args as { cards: number }),
  },
  {
    name: 'get_delivery_time',
    title: 'Delivery time',
    description:
      'Use this when the customer asks how long printed cards take or whether they arrive before a date. Returns the production days and the delivery days to their country.',
    inputSchema: {
      type: 'object',
      properties: { country: countryProperty },
      required: ['country'],
      additionalProperties: false,
    },
    openWorld: false,
    run: (args) => getDeliveryTime(args as { country: string }),
  },
  {
    name: 'get_support_contact',
    title: 'Customer service',
    description:
      'Use this when the customer has a question about an existing order (a change, an invoice, a delivery, a complaint) or wants to reach QRSong!. Returns the contact details.',
    inputSchema: {
      type: 'object',
      properties: { locale: localeProperty },
      additionalProperties: false,
    },
    openWorld: false,
    run: (args) => getSupportContact(args),
  },
];

/** The tools as `tools/list` gives them. */
export function listTools(): Record<string, unknown>[] {
  return TOOLS.map((tool) => ({
    name: tool.name,
    title: tool.title,
    description: tool.description,
    inputSchema: tool.inputSchema,
    annotations: {
      title: tool.title,
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: tool.openWorld,
    },
    securitySchemes: [{ type: 'noauth' }],
    _meta: { securitySchemes: [{ type: 'noauth' }] },
  }));
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, any>;
}

type JsonRpcResponse =
  | { jsonrpc: '2.0'; id: string | number | null; result: unknown }
  | { jsonrpc: '2.0'; id: string | number | null; error: { code: number; message: string } };

export interface McpCallLog {
  (tool: string, args: Record<string, unknown>, ok: boolean, ms: number): void;
}

function failure(id: JsonRpcRequest['id'], code: number, message: string): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

async function callTool(params: Record<string, any> | undefined, log?: McpCallLog): Promise<unknown> {
  const tool = TOOLS.find((t) => t.name === params?.['name']);
  if (!tool) throw Object.assign(new Error(`Unknown tool: ${params?.['name']}`), { code: -32602 });
  const args =
    params?.['arguments'] && typeof params['arguments'] === 'object' ? params['arguments'] : {};
  const started = Date.now();
  try {
    const data = await tool.run(args);
    log?.(tool.name, args, true, Date.now() - started);
    return {
      content: [{ type: 'text', text: JSON.stringify(data) }],
      structuredContent: data,
    };
  } catch (error) {
    log?.(tool.name, args, false, Date.now() - started);
    // A failed lookup is an answer for the model, not a protocol error.
    return {
      content: [
        {
          type: 'text',
          text: 'This could not be looked up right now. Tell the customer the site has the same information: https://www.qrsong.io',
        },
      ],
      isError: true,
    };
  }
}

/**
 * One JSON-RPC message. Null for a notification, which gets no answer.
 */
export async function handleMcpMessage(
  message: JsonRpcRequest,
  log?: McpCallLog
): Promise<JsonRpcResponse | null> {
  if (!message || message.jsonrpc !== '2.0' || typeof message.method !== 'string') {
    return failure(message?.id, -32600, 'Invalid Request');
  }
  const isNotification = message.id === undefined || message.id === null;
  if (isNotification) return null;
  const id = message.id as string | number;

  try {
    switch (message.method) {
      case 'initialize': {
        const asked = String(message.params?.['protocolVersion'] || '');
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: MCP_SERVER_INFO,
            instructions: INSTRUCTIONS,
          },
        };
      }
      case 'ping':
        return { jsonrpc: '2.0', id, result: {} };
      case 'tools/list':
        return { jsonrpc: '2.0', id, result: { tools: listTools() } };
      case 'tools/call':
        return { jsonrpc: '2.0', id, result: await callTool(message.params, log) };
      default:
        return failure(id, -32601, `Method not found: ${message.method}`);
    }
  } catch (error) {
    const code = (error as { code?: number }).code;
    return failure(id, typeof code === 'number' ? code : -32603, (error as Error).message || 'Internal error');
  }
}

/**
 * The body of one POST: a message or a batch. Null when nothing in it wants
 * an answer (notifications only), which the route answers with 202.
 */
export async function handleMcpBody(
  body: unknown,
  log?: McpCallLog
): Promise<JsonRpcResponse | JsonRpcResponse[] | null> {
  if (Array.isArray(body)) {
    if (body.length === 0 || body.length > 20) return failure(null, -32600, 'Invalid Request');
    const answers: JsonRpcResponse[] = [];
    for (const message of body) {
      const answer = await handleMcpMessage(message as JsonRpcRequest, log);
      if (answer) answers.push(answer);
    }
    return answers.length > 0 ? answers : null;
  }
  if (!body || typeof body !== 'object') return failure(null, -32700, 'Parse error');
  return handleMcpMessage(body as JsonRpcRequest, log);
}
