import PrismaInstance from './prisma';
import Logger from './logger';
import Cache from './cache';
import { color, white } from 'console-log-colors';
import Designer from './designer';
import MusicServiceRegistry from './services/MusicServiceRegistry';
import Data from './data';
import Order from './order';
import Generator from './generator';
import Utils from './utils';
import { ResellerUser } from './resellerAuth';
import { CartItem } from './interfaces/CartItem';
import { BACKGROUNDS, getBackgroundsWithUrls } from './backgrounds';
import { FONTS } from './fonts';

class Resellers {
  private static instance: Resellers;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private designer = Designer.getInstance();
  private musicServiceRegistry = MusicServiceRegistry.getInstance();
  private data = Data.getInstance();
  private order = Order.getInstance();
  private generator = Generator.getInstance();
  private cache = Cache.getInstance();
  private utils = new Utils();
  private systemUserId: number | null = null;
  private initialized = false;

  private constructor() {}

  public static getInstance(): Resellers {
    if (!Resellers.instance) {
      Resellers.instance = new Resellers();
    }
    return Resellers.instance;
  }

  /**
   * Register preset backgrounds in the database on startup.
   * Called once from resellerRoutes when routes are registered.
   */
  public async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    try {
      await this.loadAdminUserId();
      await this.ensurePresetBackgroundsRegistered();
    } catch (error: any) {
      this.logger.log(
        color.red.bold(`[${white.bold('Reseller')}] Failed to register preset backgrounds: ${error.message}`)
      );
    }
  }

  private async loadAdminUserId(): Promise<void> {
    if (this.systemUserId) return;
    const adminGroupUser = await this.prisma.userInGroup.findFirst({
      where: { UserGroup: { name: 'admin' } },
      orderBy: { userId: 'asc' },
      select: { userId: true },
    });
    if (!adminGroupUser) {
      throw new Error('No admin user found — cannot register preset backgrounds');
    }
    this.systemUserId = adminGroupUser.userId;
  }

  private async ensurePresetBackgroundsRegistered(): Promise<void> {
    const existing = await this.prisma.resellerMedia.findMany({
      where: { userId: this.systemUserId!, mediaType: 'preset_background' },
    });

    const existingFilenames = new Set(existing.map((m) => m.filename));

    for (const bg of BACKGROUNDS) {
      if (!existingFilenames.has(bg.filename)) {
        await this.prisma.resellerMedia.create({
          data: {
            userId: this.systemUserId!,
            mediaType: 'preset_background',
            filename: bg.filename,
          },
        });
      }
    }
  }

  /**
   * Returns preset backgrounds with full URLs and media IDs.
   * Result is cached in Redis for 24 hours.
   */
  public async getPresetBackgrounds(): Promise<any[]> {
    const cacheKey = 'reseller:preset-backgrounds';

    const cached = await this.cache.get(cacheKey, false);
    if (cached) {
      return JSON.parse(cached);
    }

    await this.loadAdminUserId();
    await this.ensurePresetBackgroundsRegistered();

    const presetMedia = await this.prisma.resellerMedia.findMany({
      where: { userId: this.systemUserId!, mediaType: 'preset_background' },
      orderBy: { id: 'asc' },
    });

    const mediaIds = new Map(presetMedia.map((m) => [m.filename, m.id]));
    const frontendUrl = process.env['FRONTEND_URI'] || 'https://www.qrsong.io';
    const result = getBackgroundsWithUrls(frontendUrl, mediaIds);

    await this.cache.set(cacheKey, JSON.stringify(result), 86400);

    return result;
  }

  public async uploadMedia(
    userId: number,
    base64Image: string,
    mediaType: 'background' | 'background_back' | 'logo'
  ): Promise<{ success: boolean; data?: { mediaId: number; type: string }; error?: string }> {
    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] Uploading ${white.bold(mediaType)} media for user ${white.bold(userId.toString())} (${white.bold((base64Image.length / 1024).toFixed(1) + 'KB')} base64)`)
    );

    let uploadResult;

    if (mediaType === 'background') {
      uploadResult = await this.designer.uploadBackgroundImage(base64Image);
    } else if (mediaType === 'background_back') {
      uploadResult = await this.designer.uploadBackgroundBackImage(base64Image);
    } else if (mediaType === 'logo') {
      uploadResult = await this.designer.uploadLogoImage(base64Image);
    } else {
      return { success: false, error: 'Invalid media type' };
    }

    if (!uploadResult.success || !uploadResult.filename) {
      this.logger.log(
        color.red.bold(`[${white.bold('Reseller')}] Media upload failed for user ${white.bold(userId.toString())}: ${uploadResult.error || 'Unknown error'}`)
      );
      return { success: false, error: uploadResult.error || 'Upload failed' };
    }

    const record = await this.prisma.resellerMedia.create({
      data: {
        userId,
        mediaType,
        filename: uploadResult.filename,
      },
    });

    this.logger.logDev(
      color.green.bold(
        `[${white.bold('Reseller')}] Media uploaded: ID ${white.bold(record.id.toString())} (${white.bold(mediaType)}) → ${white.bold(uploadResult.filename)} for user ${white.bold(userId.toString())}`
      )
    );

    return {
      success: true,
      data: { mediaId: record.id, type: mediaType },
    };
  }

  public async createOrder(
    resellerUser: ResellerUser,
    params: {
      playlistUrl: string;
      serviceType?: string;
      design: any;
    }
  ): Promise<{ success: boolean; data?: { orderId: string; status: string }; error?: string }> {
    const { playlistUrl, design } = params;

    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] Creating order for user ${white.bold(resellerUser.id.toString())} (${white.bold(resellerUser.displayName)})`)
    );
    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] Playlist URL: ${white.bold(playlistUrl)}`)
    );

    // Validate and parse playlist URL
    const recognition = this.musicServiceRegistry.recognizeUrl(playlistUrl);
    if (!recognition.recognized) {
      this.logger.logDev(
        color.yellow.bold(`[${white.bold('Reseller')}] URL not recognized: ${white.bold(playlistUrl)}`)
      );
      return { success: false, error: 'URL not recognized as a supported music service' };
    }

    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] Recognized ${white.bold(recognition.serviceType || 'unknown')} playlist: ${white.bold(recognition.playlistId || 'unknown')}`)
    );

    // Fetch playlist metadata
    const playlistResult = await this.musicServiceRegistry.getPlaylistFromUrl(playlistUrl) as any;
    if (!playlistResult.success || !playlistResult.data) {
      this.logger.log(
        color.red.bold(`[${white.bold('Reseller')}] Failed to fetch playlist: ${playlistResult.error || 'Unknown error'}`)
      );
      return { success: false, error: playlistResult.error || 'Failed to fetch playlist' };
    }

    const playlistData = playlistResult.data;
    const serviceType = playlistResult.serviceType || 'spotify';
    const playlistId = recognition.playlistId!;

    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] Playlist "${white.bold(playlistData.name)}" - ${white.bold(playlistData.trackCount.toString())} tracks (${white.bold(serviceType)})`)
    );

    // Resolve media IDs in design to filenames
    let resolvedBackground = design.background || '';
    let resolvedBackgroundBack = design.backgroundBack || '';
    let resolvedLogo = design.logo || '';

    if (design.background && typeof design.background === 'number') {
      this.logger.logDev(
        color.blue.bold(`[${white.bold('Reseller')}] Resolving background media ID ${white.bold(design.background.toString())}`)
      );
      const media = await this.resolveMedia(resellerUser.id, design.background, 'background');
      if (!media) {
        this.logger.logDev(
          color.yellow.bold(`[${white.bold('Reseller')}] Invalid background media ID ${white.bold(design.background.toString())} for user ${white.bold(resellerUser.id.toString())}`)
        );
        return { success: false, error: `Invalid background media ID: ${design.background}` };
      }
      resolvedBackground = media.filename;
      this.logger.logDev(
        color.blue.bold(`[${white.bold('Reseller')}] Background resolved → ${white.bold(media.filename)}`)
      );
    }

    if (design.backgroundBack && typeof design.backgroundBack === 'number') {
      this.logger.logDev(
        color.blue.bold(`[${white.bold('Reseller')}] Resolving backgroundBack media ID ${white.bold(design.backgroundBack.toString())}`)
      );
      const media = await this.resolveMedia(resellerUser.id, design.backgroundBack, 'background_back');
      if (!media) {
        this.logger.logDev(
          color.yellow.bold(`[${white.bold('Reseller')}] Invalid backgroundBack media ID ${white.bold(design.backgroundBack.toString())} for user ${white.bold(resellerUser.id.toString())}`)
        );
        return { success: false, error: `Invalid backgroundBack media ID: ${design.backgroundBack}` };
      }
      resolvedBackgroundBack = media.filename;
      this.logger.logDev(
        color.blue.bold(`[${white.bold('Reseller')}] BackgroundBack resolved → ${white.bold(media.filename)}`)
      );
    }

    if (design.logo && typeof design.logo === 'number') {
      this.logger.logDev(
        color.blue.bold(`[${white.bold('Reseller')}] Resolving logo media ID ${white.bold(design.logo.toString())}`)
      );
      const media = await this.resolveMedia(resellerUser.id, design.logo, 'logo');
      if (!media) {
        this.logger.logDev(
          color.yellow.bold(`[${white.bold('Reseller')}] Invalid logo media ID ${white.bold(design.logo.toString())} for user ${white.bold(resellerUser.id.toString())}`)
        );
        return { success: false, error: `Invalid logo media ID: ${design.logo}` };
      }
      resolvedLogo = media.filename;
      this.logger.logDev(
        color.blue.bold(`[${white.bold('Reseller')}] Logo resolved → ${white.bold(media.filename)}`)
      );
    }

    // Store user (reuse existing method)
    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] Storing user record for ${white.bold(resellerUser.email)}`)
    );
    const userDatabaseId = await this.data.storeUser({
      userId: resellerUser.email,
      email: resellerUser.email,
      displayName: resellerUser.displayName,
      locale: 'en',
    });
    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] User stored with DB ID ${white.bold(userDatabaseId.toString())}`)
    );

    // Store playlist
    const cartItem: CartItem = {
      type: 'physical',
      subType: 'none',
      playlistId,
      playlistName: playlistData.name,
      numberOfTracks: playlistData.trackCount,
      amount: 1,
      price: 0,
      image: playlistData.imageUrl || '',
      productType: 'cards',
      serviceType,
    };

    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] Storing playlist ${white.bold(playlistId)} (${white.bold(playlistData.trackCount.toString())} tracks)`)
    );
    const playlistDatabaseIds = await this.data.storePlaylists(
      userDatabaseId,
      [cartItem]
    );
    const playlistDbId = playlistDatabaseIds[0];
    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] Playlist stored with DB ID ${white.bold(playlistDbId.toString())}`)
    );

    // Get order type
    const orderType = await this.order.getOrderType(
      playlistData.trackCount,
      false,
      'cards',
      playlistId,
      'none'
    );

    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] Order type: ${white.bold(orderType.id.toString())}`)
    );

    // Create Payment record (mimicking mollie.ts)
    const randomStr = this.utils.generateRandomString(16);
    const molliePaymentId = `reseller_${randomStr}`;

    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] Creating payment record ${white.bold(molliePaymentId)}`)
    );

    const paymentHasPlaylistData = {
      playlistId: playlistDbId,
      orderTypeId: orderType.id,
      amount: 1,
      numberOfTracks: playlistData.trackCount,
      type: 'physical',
      subType: 'none',
      doubleSided: true,
      eco: false,
      qrColor: design.qrColor || '#000000',
      qrBackgroundColor: design.qrBackgroundColor || '#ffffff',
      hideCircle: design.hideCircle || false,
      qrBackgroundType: design.qrBackgroundType || (design.hideCircle ? 'none' : 'square'),
      price: 0,
      priceWithoutVAT: 0,
      priceVAT: 0,
      printApiPrice: 0,
      emoji: '',
      background: resolvedBackground,
      logo: resolvedLogo,
      selectedFont: this.resolveFont(design.selectedFont).family,
      selectedFontSize: design.selectedFontSize || this.resolveFont(design.selectedFont).defaultSize,
      backgroundFrontType: design.backgroundFrontType || 'image',
      backgroundFrontColor: design.backgroundFrontColor || '#ffffff',
      useFrontGradient: design.useFrontGradient || false,
      gradientFrontColor: design.gradientFrontColor || '#ffffff',
      gradientFrontDegrees: design.gradientFrontDegrees || 180,
      gradientFrontPosition: design.gradientFrontPosition || 50,
      backgroundBackType: design.backgroundBackType || 'image',
      backgroundBack: resolvedBackgroundBack,
      backgroundBackColor: design.backgroundBackColor || '#ffffff',
      fontColor: design.fontColor || '#000000',
      useGradient: design.useGradient || false,
      gradientBackgroundColor: design.gradientBackgroundColor || '#ffffff',
      gradientDegrees: design.gradientDegrees || 180,
      gradientPosition: design.gradientPosition || 50,
      frontOpacity: design.frontOpacity !== undefined ? design.frontOpacity : 100,
      backOpacity: design.backOpacity !== undefined ? design.backOpacity : 50,
      printerType: 'reseller',
      gamesEnabled: false,
      gamesPrice: 0,
    };

    const insertResult = await this.prisma.payment.create({
      data: {
        paymentId: molliePaymentId,
        vibe: false,
        user: { connect: { id: userDatabaseId } },
        totalPrice: 0,
        totalPriceWithoutTax: 0,
        status: 'paid',
        locale: 'en',
        taxRate: 0,
        taxRateShipping: 0,
        productPriceWithoutTax: 0,
        shippingPriceWithoutTax: 0,
        productVATPrice: 0,
        shippingVATPrice: 0,
        totalVATPrice: 0,
        clientIp: '127.0.0.1',
        test: false,
        profit: 0,
        printApiPrice: 0,
        discount: 0,
        fullname: resellerUser.displayName,
        email: resellerUser.email,
        PaymentHasPlaylist: { create: [paymentHasPlaylistData] },
      },
    });

    const paymentDbId = insertResult.id;
    const newOrderId = (100000000 + paymentDbId).toString();

    await this.prisma.payment.update({
      where: { id: paymentDbId },
      data: { orderId: newOrderId },
    });

    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] Queuing PDF generation for ${white.bold(molliePaymentId)} (playlist: ${white.bold(playlistId)})`)
    );

    // Queue generation (skipMainMail = true)
    this.generator.queueGenerate(
      molliePaymentId,
      '127.0.0.1',
      playlistId,
      false,
      true,
      false
    );

    this.logger.logDev(
      color.green.bold(
        `[${white.bold('Reseller')}] Order created: ${white.bold(newOrderId)} (payment: ${white.bold(molliePaymentId)}, ${white.bold(playlistData.trackCount.toString())} tracks, user: ${white.bold(resellerUser.id.toString())})`
      )
    );

    return {
      success: true,
      data: {
        orderId: newOrderId,
        status: 'processing',
      },
    };
  }

  public async createPreview(
    resellerUser: ResellerUser,
    params: {
      design: any;
      sampleTrackName?: string;
      sampleTrackArtist?: string;
      sampleTrackYear?: string;
    }
  ): Promise<{ success: boolean; data?: { previewUrlFront: string; previewUrlBack: string; token: string }; error?: string }> {
    const { design } = params;

    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] Creating preview for user ${white.bold(resellerUser.id.toString())} (${white.bold(resellerUser.displayName)})`)
    );

    // Resolve media IDs to filenames and build full URLs
    let resolvedBackground = design.background || '';
    let resolvedBackgroundBack = design.backgroundBack || '';
    let resolvedLogo = design.logo || '';

    if (design.background && typeof design.background === 'number') {
      const media = await this.resolveMedia(resellerUser.id, design.background, 'background');
      if (!media) {
        return { success: false, error: `Invalid background media ID: ${design.background}` };
      }
      resolvedBackground = `${process.env['API_URI']}/public/background/${media.filename}`;
    }

    if (design.backgroundBack && typeof design.backgroundBack === 'number') {
      const media = await this.resolveMedia(resellerUser.id, design.backgroundBack, 'background_back');
      if (!media) {
        return { success: false, error: `Invalid backgroundBack media ID: ${design.backgroundBack}` };
      }
      resolvedBackgroundBack = `${process.env['API_URI']}/public/background/${media.filename}`;
    }

    if (design.logo && typeof design.logo === 'number') {
      const media = await this.resolveMedia(resellerUser.id, design.logo, 'logo');
      if (!media) {
        return { success: false, error: `Invalid logo media ID: ${design.logo}` };
      }
      resolvedLogo = `${process.env['API_URI']}/public/logo/${media.filename}`;
    }

    const token = this.utils.generateRandomString(32);
    const expiresIn = 86400;

    const resolvedFont = this.resolveFont(design.selectedFont);
    const { emoji: _emoji, doubleSided: _ds, eco: _eco, ...cleanDesign } = design;
    const previewData = {
      ...cleanDesign,
      background: resolvedBackground,
      backgroundBack: resolvedBackgroundBack,
      logo: resolvedLogo,
      selectedFont: resolvedFont.family,
      selectedFontSize: design.selectedFontSize || resolvedFont.defaultSize,
      sampleTrackName: params.sampleTrackName || 'Sample Track',
      sampleTrackArtist: params.sampleTrackArtist || 'Sample Artist',
      sampleTrackYear: params.sampleTrackYear || '2025',
    };

    await this.cache.set(`preview:${token}`, JSON.stringify(previewData), expiresIn);

    const previewUrlFront = `${process.env['FRONTEND_URI']}/en/card-preview-front/${token}`;
    const previewUrlBack = `${process.env['FRONTEND_URI']}/en/card-preview-back/${token}`;

    this.logger.logDev(
      color.green.bold(
        `[${white.bold('Reseller')}] Preview created: ${white.bold(token.substring(0, 8))}... for user ${white.bold(resellerUser.id.toString())} (expires in ${white.bold('24h')})`
      )
    );

    return {
      success: true,
      data: { previewUrlFront, previewUrlBack, token },
    };
  }

  public async getPreview(token: string): Promise<{ success: boolean; data?: any; error?: string }> {
    const data = await this.cache.get(`preview:${token}`, false);
    if (!data) {
      return { success: false, error: 'Preview not found or expired' };
    }
    return { success: true, data: JSON.parse(data) };
  }

  public async getOrderStatus(
    userId: number,
    orderId: string
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] Status check for order ${white.bold(orderId)} by user ${white.bold(userId.toString())}`)
    );

    const payment = await this.prisma.payment.findFirst({
      where: {
        orderId,
        userId,
      },
      select: {
        id: true,
        paymentId: true,
        status: true,
        finalized: true,
        processedFirstTime: true,
        createdAt: true,
        PaymentHasPlaylist: {
          select: {
            filename: true,
            printerType: true,
          },
        },
      },
    });

    if (!payment) {
      this.logger.logDev(
        color.yellow.bold(`[${white.bold('Reseller')}] Order ${white.bold(orderId)} not found for user ${white.bold(userId.toString())}`)
      );
      return { success: false, error: 'Order not found' };
    }

    // Only allow status checks for reseller orders
    const isResellerOrder = payment.PaymentHasPlaylist.some(
      (php) => php.printerType === 'reseller'
    );
    if (!isResellerOrder) {
      this.logger.logDev(
        color.yellow.bold(`[${white.bold('Reseller')}] Order ${white.bold(orderId)} is not a reseller order`)
      );
      return { success: false, error: 'Order not found' };
    }

    let status: string;
    let pdfUrl: string | undefined;
    let comment = '';

    if (payment.status !== 'paid') {
      status = 'failed';
    } else if (!payment.finalized) {
      status = 'processing';
      // Check if tracks are stored but waiting on manual year verification
      if (payment.processedFirstTime) {
        const allChecked = await this.data.areAllTracksManuallyChecked(payment.paymentId);
        if (!allChecked) {
          comment = 'Order years are being manually checked';
        }
      }
    } else {
      const php = payment.PaymentHasPlaylist[0];
      if (!php?.filename) {
        status = 'finalizing';
      } else {
        status = 'done';
        pdfUrl = `${process.env['API_URI']}/public/pdf/${php.filename}`;
      }
    }

    this.logger.logDev(
      color.blue.bold(`[${white.bold('Reseller')}] Order ${white.bold(orderId)} status: ${white.bold(status)}${pdfUrl ? ` → ${white.bold(pdfUrl)}` : ''}`)
    );

    return {
      success: true,
      data: {
        orderId,
        status,
        createdAt: payment.createdAt,
        ...(pdfUrl && { pdfUrl }),
        ...(comment && { comment }),
      },
    };
  }

  public async getPlaylistInfo(
    playlistUrl: string,
  ): Promise<{ success: boolean; data?: any; error?: string }> {
    const playlistResult = await this.musicServiceRegistry.getPlaylistFromUrl(playlistUrl);

    if (!playlistResult.success || !playlistResult.data) {
      return { success: false, error: playlistResult.error || 'Failed to fetch playlist' };
    }

    const tracksResult = await this.musicServiceRegistry.getTracksFromUrl(playlistUrl);

    if (!tracksResult.success || !tracksResult.data) {
      return { success: false, error: tracksResult.error || 'Failed to fetch tracks' };
    }

    const playlist = playlistResult.data;
    const tracks = tracksResult.data.tracks.map((t) => ({
      name: t.name,
      artist: t.artist,
      album: t.album,
      releaseDate: t.releaseDate,
      duration: t.duration,
    }));

    return {
      success: true,
      data: {
        serviceType: playlistResult.serviceType,
        playlist: {
          id: playlist.id,
          name: playlist.name,
          description: playlist.description,
          imageUrl: playlist.imageUrl,
          trackCount: playlist.trackCount,
        },
        tracks,
        ...(tracksResult.data.skipped && tracksResult.data.skipped.total > 0 && {
          skipped: tracksResult.data.skipped,
        }),
      },
    };
  }

  /**
   * Resolve a googleFontName (e.g. "Oswald") to the full CSS family string.
   * Also returns the font's recommended default size.
   */
  private resolveFont(googleFontName?: string): { family: string; defaultSize: string } {
    if (!googleFontName) return { family: 'Arial, sans-serif', defaultSize: '16px' };
    const font = FONTS.find((f) => f.googleFontName === googleFontName);
    if (font) return { family: font.family, defaultSize: font.defaultSize };
    return { family: 'Arial, sans-serif', defaultSize: '16px' };
  }

  private async resolveMedia(
    userId: number,
    mediaId: number,
    expectedType: string
  ): Promise<{ filename: string } | null> {
    // First try user-specific media
    let media = await this.prisma.resellerMedia.findFirst({
      where: {
        id: mediaId,
        userId,
      },
    });

    // If not found, try preset backgrounds (admin user)
    if (!media) {
      await this.loadAdminUserId();
      if (this.systemUserId && this.systemUserId !== userId) {
        media = await this.prisma.resellerMedia.findFirst({
          where: {
            id: mediaId,
            userId: this.systemUserId,
          },
        });
      }
    }

    if (!media) return null;

    // Preset backgrounds can be used as both front and back backgrounds
    if (media.mediaType === 'preset_background') {
      if (expectedType !== 'background' && expectedType !== 'background_back') {
        return null;
      }
    } else if (media.mediaType !== expectedType) {
      return null;
    }

    return { filename: media.filename };
  }
}

export default Resellers;
