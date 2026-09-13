import crypto from 'crypto';

/**
 * Fingerprint of everything that determines what a printed PDF looks like.
 *
 * The PDF on disk is written once at generation time and then sent to the
 * print API some time later, sometimes days later via the cron. In between, an
 * admin can correct a release year, a customer can change a background, and a
 * product type can be switched. Nothing in the schema records "the design
 * changed": `payment_has_playlist` has no `updatedAt`, and adding one would be
 * useless here because that row is also written for unrelated reasons
 * (`printerHold`, `eligableForPrinter`), so it would report drift on every
 * send. The PDF filename is no help either: it hashes only
 * `paymentId_playlistId_name`, all of which are stable across a redesign.
 *
 * So instead of guessing from timestamps, hash the inputs. If the fingerprint
 * stored at generation time still matches the current data, the PDF on disk is
 * exactly what the current design would produce and can be shipped as is. If it
 * differs, the PDF is stale and has to be rebuilt before anyone verifies or
 * prints it.
 */

/**
 * Columns on the joined playlist/payment_has_playlist row that end up on the
 * printed card. Deliberately a whitelist rather than "hash the whole row":
 * the row also carries prices, box settings and bookkeeping flags, and hashing
 * those would report drift for changes that cannot affect the print.
 *
 * Add a field here when it starts influencing the card artwork, or stale PDFs
 * will silently ship after that field is edited.
 */
const DESIGN_FIELDS = [
  'name',
  'productType',
  'subType',
  'template',
  // theme/themeName deliberately absent: they only steer the scan app, no
  // pdf_*.ejs reads them, and the App Designer sets them after purchase.
  'printerType',
  'eco',
  'doubleSided',
  // Prepends an explanation card to the printer PDF, so it changes the page
  // count as well as the artwork.
  'addHowToCard',
  'addHowToCardLocale',
  'emoji',
  'background',
  'logo',
  'selectedFont',
  'selectedFontSize',
  'qrColor',
  'qrBackgroundColor',
  'qrBackgroundType',
  'qrLogo',
  'qrLogoScale',
  'hideCircle',
  'backgroundFrontType',
  'backgroundFrontColor',
  'useFrontGradient',
  'gradientFrontColor',
  'gradientFrontDegrees',
  'gradientFrontPosition',
  'backgroundBackType',
  'backgroundBack',
  'backgroundBackColor',
  'fontColor',
  'useGradient',
  'gradientBackgroundColor',
  'gradientDegrees',
  'gradientPosition',
  'frontOpacity',
  'backOpacity',
  'allowDuplicates',
] as const;

/**
 * The per-track values printed on a card, as returned by `data.getTracks`.
 *
 * `name`, `artist` and `year` there are already COALESCEd over `trackextrainfo`,
 * so a per-order correction is folded into these values and needs no separate
 * field here.
 */
interface FingerprintTrack {
  id?: number | null;
  trackId?: string | null;
  name?: string | null;
  artist?: string | null;
  year?: number | null;
}

/**
 * Stable fingerprint for one playlist in one order.
 *
 * `tracks` must be passed in the order they are printed; a reordered deck is a
 * different deck. Values are normalised to strings so that a `0`/`false`/`null`
 * round trip through the database cannot change the hash on its own.
 */
export function computePrintFingerprint(
  playlist: Record<string, any>,
  tracks: FingerprintTrack[] = []
): string {
  const design = DESIGN_FIELDS.map((field) => {
    const value = playlist?.[field];
    return `${field}=${value === null || value === undefined ? '' : String(value)}`;
  }).join('|');

  const trackPart = tracks
    .map((track, index) =>
      [
        index,
        track.trackId ?? track.id ?? '',
        track.name ?? '',
        track.artist ?? '',
        track.year ?? '',
      ].join(':')
    )
    .join('|');

  return crypto
    .createHash('sha256')
    .update(`${design}\n${trackPart}`)
    .digest('hex');
}

export default computePrintFingerprint;
