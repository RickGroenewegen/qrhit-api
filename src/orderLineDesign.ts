import PrismaInstance from './prisma';
import { CARD_DESIGN_COLUMNS, CardDesign, pickCardDesign, sanitizeCardDesign } from './cardDesigns';

/**
 * Copy one side of one card design of an order line onto another design of the same line (the qrsong toolkit's
 * `order design-copy`; first: Esther Brauhardt, 100009410, 2026-11-10). She gave "50 Jahre deutsche Charts Platz 1"
 * ten alternating designs, and on design 10 the front lost her picture and got a square QR; the designer would not
 * let her put it back, so every tenth card (65 of 652) printed with the default front.
 *
 * Design 1 is the order line itself, designs 2..N are rows in payment_has_playlist_designs (src/cardDesigns.ts).
 * `side` says which columns travel: `front` is the QR side (picture, QR, logo, emoji), `back` the text side
 * (colour or picture, font, text colour), `both` every design column. The merged design goes through the same
 * sanitising as the designer's own save. Nothing else changes: the review flags, the approval and the printer
 * timer stay, and the PDFs still show the old design until they are rebuilt (the toolkit's `rebuild-printer-pdfs`
 * route, or the printer pass, which rebuilds a PDF whose fingerprint no longer matches).
 *
 * Refused for an order at the printer (`sentToPrinter` or a Print&Bind order id): a design saved then never
 * reaches the cards. After cancelling at Print&Bind, `printer-reset` (src/printerRedo.ts) comes first.
 */

export class LineDesignError extends Error {
  constructor(message: string, public status = 400) {
    super(message);
  }
}

export type DesignSide = 'front' | 'back' | 'both';

/** The QR side of a card: its picture or colour, the QR code and its circle, a logo or emoji. */
export const FRONT_COLUMNS: readonly (keyof CardDesign)[] = [
  'emoji',
  'background',
  'logo',
  'hideCircle',
  'qrBackgroundType',
  'qrColor',
  'qrBackgroundColor',
  'qrLogo',
  'qrLogoScale',
  'backgroundFrontType',
  'backgroundFrontColor',
  'useFrontGradient',
  'gradientFrontColor',
  'gradientFrontDegrees',
  'gradientFrontPosition',
  'frontOpacity',
];

/** The text side: artist, year and title on a colour, gradient or picture. */
export const BACK_COLUMNS: readonly (keyof CardDesign)[] = [
  'selectedFont',
  'selectedFontSize',
  'backgroundBackType',
  'backgroundBack',
  'backgroundBackColor',
  'fontColor',
  'useGradient',
  'gradientBackgroundColor',
  'gradientDegrees',
  'gradientPosition',
  'backOpacity',
  'sameAsFront',
];

export function columnsFor(side: DesignSide): readonly (keyof CardDesign)[] {
  if (side === 'front') return FRONT_COLUMNS;
  if (side === 'back') return BACK_COLUMNS;
  return CARD_DESIGN_COLUMNS;
}

export interface DesignEditState {
  orderId: string;
  status: string;
  sentToPrinter: boolean;
  printApiOrderId: string | null;
  type: string;
  designCount: number;
}

/** Why design `position` of this line cannot take `side` of design `copyFrom`, or null when it can. */
export function designCopyRefusal(
  line: DesignEditState,
  position: number,
  copyFrom: number,
  side: string
): string | null {
  if (!['front', 'back', 'both'].includes(side)) return `side must be front, back or both, not "${side}"`;
  for (const [name, value] of [
    ['position', position],
    ['copyFrom', copyFrom],
  ] as const) {
    if (!Number.isInteger(value) || value < 1 || value > line.designCount) {
      return `${name} must be a design of this line: 1 to ${line.designCount}, not ${value}`;
    }
  }
  if (position === copyFrom) return 'position and copyFrom are the same design';
  if (line.status !== 'paid') return `order ${line.orderId} is not paid (${line.status})`;
  if (line.sentToPrinter || line.printApiOrderId) {
    return `order ${line.orderId} is at the printer (${line.printApiOrderId || 'sent'}): a design saved now is never printed; after cancelling at Print&Bind run printer-reset first`;
  }
  if (line.type !== 'physical') return `line is ${line.type}: only a printed line`;
  return null;
}

export interface DesignChange {
  from: unknown;
  to: unknown;
}

/**
 * The target design with `side` of the source laid over it, sanitised as the designer saves it, and the columns
 * that change. An empty `changes` means the side is already the same.
 */
export function copiedDesign(
  target: CardDesign,
  source: CardDesign,
  side: DesignSide
): { design: CardDesign; changes: Record<string, DesignChange> } {
  const merged: Record<string, unknown> = { ...target };
  for (const column of columnsFor(side)) merged[column] = source[column];
  const design = sanitizeCardDesign(merged);
  const changes: Record<string, DesignChange> = {};
  for (const column of CARD_DESIGN_COLUMNS) {
    if (!sameValue(target[column], design[column])) changes[column] = { from: target[column], to: design[column] };
  }
  return { design, changes };
}

// MySQL hands booleans back as 0/1 and missing text as null: compare what they mean
function sameValue(a: unknown, b: unknown): boolean {
  const norm = (v: unknown) => (typeof v === 'boolean' ? Number(v) : v === undefined ? null : v);
  return norm(a) === norm(b);
}

export async function copyLineDesign(
  lineId: number,
  input: { position: number; copyFrom: number; side: string; apply: boolean }
) {
  if (!Number.isInteger(lineId) || lineId <= 0) throw new LineDesignError('invalid line id');
  const prisma = PrismaInstance.getInstance();
  const line = await prisma.paymentHasPlaylist.findUnique({
    where: { id: lineId },
    include: {
      playlist: { select: { name: true } },
      payment: { select: { orderId: true, status: true, sentToPrinter: true, printApiOrderId: true } },
    },
  });
  if (!line) throw new LineDesignError(`no order line ${lineId}`, 404);
  const rows = await prisma.paymentHasPlaylistDesign.findMany({
    where: { paymentHasPlaylistId: lineId },
    orderBy: { position: 'asc' },
  });
  const designs = new Map<number, { rowId: number | null; design: CardDesign }>();
  designs.set(1, { rowId: null, design: pickCardDesign(line) });
  for (const row of rows) designs.set(row.position, { rowId: row.id, design: pickCardDesign(row) });

  const refusal = designCopyRefusal(
    {
      orderId: String(line.payment.orderId),
      status: line.payment.status,
      sentToPrinter: !!line.payment.sentToPrinter,
      printApiOrderId: line.payment.printApiOrderId,
      type: line.type,
      designCount: Math.max(...designs.keys()),
    },
    input.position,
    input.copyFrom,
    input.side
  );
  if (refusal) throw new LineDesignError(refusal, /must be|same design/.test(refusal) ? 400 : 409);
  const target = designs.get(input.position);
  const source = designs.get(input.copyFrom);
  if (!target || !source) {
    throw new LineDesignError(`line ${lineId} has designs ${[...designs.keys()].join(', ')}: no ${input.position} or ${input.copyFrom}`, 400);
  }

  const side = input.side as DesignSide;
  const { design, changes } = copiedDesign(target.design, source.design, side);
  const summary = {
    lineId,
    orderId: String(line.payment.orderId),
    playlist: line.playlist.name,
    designs: designs.size,
    position: input.position,
    copyFrom: input.copyFrom,
    side,
    changes,
  };
  if (!Object.keys(changes).length) return { applied: false, ...summary, note: 'that side is already the same' };
  if (!input.apply) return { applied: false, ...summary };

  const data = Object.fromEntries(Object.keys(changes).map((column) => [column, (design as any)[column]]));
  if (target.rowId === null) {
    await prisma.paymentHasPlaylist.update({ where: { id: lineId }, data });
  } else {
    await prisma.paymentHasPlaylistDesign.update({ where: { id: target.rowId }, data });
  }

  // Read back: only the changed columns may differ from what was there
  const after =
    target.rowId === null
      ? pickCardDesign((await prisma.paymentHasPlaylist.findUnique({ where: { id: lineId } }))!)
      : pickCardDesign((await prisma.paymentHasPlaylistDesign.findUnique({ where: { id: target.rowId } }))!);
  const unexpected = CARD_DESIGN_COLUMNS.filter(
    (column) => !sameValue(after[column], column in changes ? (design as any)[column] : target.design[column])
  );
  return { applied: true, ...summary, readBack: unexpected.length ? { unexpected } : 'ok' };
}
