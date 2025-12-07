import { PrismaClient } from '@prisma/client';
import PrismaInstance from './prisma';
import Logger from './logger';
import Mail from './mail';
import { ChatGPT } from './chatgpt';
import Cache from './cache';
import Translation from './translation';
import { color } from 'console-log-colors';
import { CACHE_KEY_FEATURED_PLAYLISTS } from './data';
import { CACHE_KEY_PLAYLIST, CACHE_KEY_PLAYLIST_DB } from './spotify';

const PROMOTIONAL_CREDIT_AMOUNT = parseFloat(process.env['PROMOTIONAL_CREDIT_AMOUNT'] || '2.5');

class Promotional {
  private static instance: Promotional;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private mail = Mail.getInstance();
  private chatgpt = new ChatGPT();
  private cache = Cache.getInstance();
  private translation = new Translation();

  private constructor() {}

  public static getInstance(): Promotional {
    if (!Promotional.instance) {
      Promotional.instance = new Promotional();
    }
    return Promotional.instance;
  }

  /**
   * Verify that the user owns this payment/playlist combination
   */
  private async verifyOwnership(
    paymentId: string,
    userHash: string,
    playlistId: string
  ): Promise<{
    verified: boolean;
    paymentDbId?: number;
    playlistDbId?: number;
    userId?: number;
    userEmail?: string;
  }> {
    const result = await this.prisma.$queryRaw<any[]>`
      SELECT
        p.id as paymentDbId,
        pl.id as playlistDbId,
        u.id as userId,
        u.email as userEmail
      FROM payments p
      JOIN users u ON p.userId = u.id
      JOIN payment_has_playlist php ON php.paymentId = p.id
      JOIN playlists pl ON pl.id = php.playlistId
      WHERE p.paymentId = ${paymentId}
      AND u.hash = ${userHash}
      AND pl.playlistId = ${playlistId}
      AND p.status = 'paid'
      LIMIT 1
    `;

    if (result.length === 0) {
      return { verified: false };
    }

    return {
      verified: true,
      paymentDbId: result[0].paymentDbId,
      playlistDbId: result[0].playlistDbId,
      userId: result[0].userId,
      userEmail: result[0].userEmail,
    };
  }

  /**
   * Get promotional setup data for a playlist
   */
  public async getPromotionalSetup(
    paymentId: string,
    userHash: string,
    playlistId: string
  ): Promise<{
    success: boolean;
    data?: {
      title: string;
      description: string;
      image: string;
      active: boolean;
      hasSubmitted: boolean;
      shareLink: string;
      discountCode: string | null;
      discountBalance: number;
      slug: string;
      playlistName: string;
      accepted: boolean;
      declined: boolean;
    };
    error?: string;
  }> {
    try {
      const ownership = await this.verifyOwnership(paymentId, userHash, playlistId);

      if (!ownership.verified) {
        return { success: false, error: 'Unauthorized' };
      }

      // Get playlist data
      const playlist = await this.prisma.playlist.findFirst({
        where: { playlistId },
        select: {
          id: true,
          name: true,
          slug: true,
          image: true,
          promotionalTitle: true,
          promotionalDescription: true,
          promotionalActive: true,
          promotionalAccepted: true,
          promotionalDeclined: true,
        },
      });

      if (!playlist) {
        return { success: false, error: 'Playlist not found' };
      }

      // Get discount code balance if exists (now user-based, not playlist-based)
      const discountCode = await this.prisma.discountCode.findFirst({
        where: {
          promotional: true,
          promotionalUserId: ownership.userId,
        },
        select: {
          code: true,
          amount: true,
        },
      });

      // Calculate amount used
      let discountBalance = 0;
      if (discountCode) {
        const totalUsed = await this.prisma.discountCodedUses.aggregate({
          where: {
            discountCode: {
              promotional: true,
              promotionalUserId: ownership.userId,
            },
          },
          _sum: { amount: true },
        });
        discountBalance = discountCode.amount - (totalUsed._sum.amount || 0);
      }

      // Generate share link using existing product page
      const shareLink = `${process.env['FRONTEND_URI']}/en/product/${playlist.slug || playlistId}`;

      // Check if this is a first-time setup (user hasn't submitted the form yet)
      const hasSubmitted = !!playlist.promotionalTitle;

      return {
        success: true,
        data: {
          title: playlist.promotionalTitle || playlist.name,
          description: playlist.promotionalDescription || '',
          image: playlist.image,
          active: hasSubmitted ? !!playlist.promotionalActive : true, // Default checkbox to true for first-time
          hasSubmitted, // New field to indicate if user has ever submitted
          shareLink,
          discountCode: discountCode?.code || null,
          discountBalance,
          slug: playlist.slug,
          playlistName: playlist.name,
          accepted: !!playlist.promotionalAccepted,
          declined: !!playlist.promotionalDeclined,
        },
      };
    } catch (error) {
      this.logger.log(`Error getting promotional setup: ${error}`);
      return { success: false, error: 'Failed to get promotional setup' };
    }
  }

  /**
   * Save promotional setup data
   */
  public async savePromotionalSetup(
    paymentId: string,
    userHash: string,
    playlistId: string,
    data: {
      title: string;
      description: string;
      image?: string;
      active: boolean;
      locale?: string;
    }
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const ownership = await this.verifyOwnership(paymentId, userHash, playlistId);

      if (!ownership.verified) {
        return { success: false, error: 'Unauthorized' };
      }

      // Update playlist with promotional data
      // Also update 'featured' field which controls visibility on the site
      await this.prisma.playlist.update({
        where: { playlistId },
        data: {
          promotionalTitle: data.title,
          promotionalDescription: data.description,
          promotionalActive: data.active,
          promotionalLocale: data.locale || 'en',
          promotionalUserId: ownership.userId,
          featured: data.active,
        },
      });

      return { success: true };
    } catch (error) {
      this.logger.log(`Error saving promotional setup: ${error}`);
      return { success: false, error: 'Failed to save promotional setup' };
    }
  }

  /**
   * Credit discount when a promotional playlist is purchased
   * Called from generator.ts after successful payment
   */
  public async creditPromotionalDiscount(
    playlistDbId: number,
    purchaserPaymentId: number
  ): Promise<{ success: boolean; credited: boolean; error?: string }> {
    try {
      // Get playlist promotional data
      const playlist = await this.prisma.playlist.findUnique({
        where: { id: playlistDbId },
        select: {
          id: true,
          playlistId: true,
          name: true,
          slug: true,
          promotionalActive: true,
          promotionalUserId: true,
        },
      });

      if (!playlist || !playlist.promotionalActive || !playlist.promotionalUserId) {
        return { success: true, credited: false };
      }

      // Get the creator's user info
      const creator = await this.prisma.user.findUnique({
        where: { id: playlist.promotionalUserId },
        select: {
          id: true,
          email: true,
          displayName: true,
          hash: true,
          locale: true,
        },
      });

      if (!creator) {
        return { success: true, credited: false };
      }

      // Get the PaymentHasPlaylist record with idempotency check
      const paymentPlaylist = await this.prisma.paymentHasPlaylist.findFirst({
        where: {
          paymentId: purchaserPaymentId,
          playlistId: playlistDbId,
        },
        select: { id: true, amount: true, promotionalCredited: true },
      });

      // Skip if not found or already credited (idempotency check)
      if (!paymentPlaylist || paymentPlaylist.promotionalCredited) {
        return { success: true, credited: false };
      }

      const quantity = paymentPlaylist.amount || 1;
      const creditAmount = PROMOTIONAL_CREDIT_AMOUNT * quantity;

      // Check if a discount code already exists for this user (not playlist)
      let discountCode = await this.prisma.discountCode.findFirst({
        where: {
          promotional: true,
          promotionalUserId: creator.id,
        },
      });

      let newTotalAmount: number;
      if (discountCode) {
        // Add to existing discount code balance
        newTotalAmount = discountCode.amount + creditAmount;
        await this.prisma.discountCode.update({
          where: { id: discountCode.id },
          data: {
            amount: newTotalAmount,
          },
        });
      } else {
        // Create new promotional discount code for this user
        const code = this.generateDiscountCode();
        newTotalAmount = creditAmount;
        discountCode = await this.prisma.discountCode.create({
          data: {
            code,
            amount: newTotalAmount,
            description: `Promotional discount for user: ${creator.displayName || creator.email}`,
            promotional: true,
            promotionalUserId: creator.id,
            general: false,
            digital: false, // Can be used for any order type
          },
        });
      }

      // Mark as credited to prevent duplicate credits
      await this.prisma.paymentHasPlaylist.update({
        where: { id: paymentPlaylist.id },
        data: {
          promotionalCredited: true,
          promotionalCreditedAt: new Date(),
        },
      });

      // Calculate new balance (total amount minus what's been used)
      const totalUsed = await this.prisma.discountCodedUses.aggregate({
        where: { discountCodeId: discountCode.id },
        _sum: { amount: true },
      });
      const newBalance = newTotalAmount - (totalUsed._sum.amount || 0);

      // Generate the promotional setup link - find the original payment via payment_has_playlist
      const paymentLink = await this.prisma.paymentHasPlaylist.findFirst({
        where: {
          playlistId: playlist.id,
          payment: {
            userId: creator.id,
            status: 'paid',
          },
        },
        select: {
          payment: {
            select: { paymentId: true },
          },
        },
        orderBy: { id: 'asc' }, // Get the first/original payment
      });

      const setupLink = paymentLink
        ? `${process.env['FRONTEND_URI']}/${creator.locale || 'en'}/promotional/${paymentLink.payment.paymentId}/${creator.hash}/${playlist.playlistId}`
        : null;

      // Send notification email to creator
      await this.sendPromotionalSaleEmail(
        creator.email,
        creator.displayName,
        playlist.name,
        creditAmount,
        newBalance,
        discountCode.code,
        `${process.env['FRONTEND_URI']}/${creator.locale || 'en'}/product/${playlist.slug || playlist.playlistId}`,
        setupLink,
        creator.locale || 'en',
        quantity
      );

      this.logger.log(
        color.blue.bold(
          `Credited ${color.white.bold(creditAmount)} EUR (${color.white.bold(quantity)}x) to promotional discount for playlist ${color.white.bold(playlist.name)} (code: ${color.white.bold(discountCode.code)})`
        )
      );

      return { success: true, credited: true };
    } catch (error) {
      this.logger.log(`Error crediting promotional discount: ${error}`);
      return { success: false, credited: false, error: 'Failed to credit discount' };
    }
  }

  /**
   * Generate a unique discount code in format XXXX-XXXX-XXXX-XXXX
   */
  private generateDiscountCode(): string {
    const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    const generatePart = () => {
      let result = '';
      for (let i = 0; i < 4; i++) {
        const idx = Math.floor(Math.random() * CHARS.length);
        result += CHARS[idx];
      }
      return result;
    };
    return [generatePart(), generatePart(), generatePart(), generatePart()].join('-');
  }

  /**
   * Replace competitor brand name with QRSong! in text
   */
  private sanitizeBrandName(text: string): string {
    return text.replace(/hitster/gi, 'QRSong!');
  }

  /**
   * Convert text to URL-friendly slug
   */
  private slugify(text: string): string {
    return text
      .toString()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/hitster/g, 'qrsong') // Replace competitor brand in slug
      .replace(/\s+/g, '-')
      .replace(/[^\w-]+/g, '')
      .replace(/--+/g, '-');
  }

  /**
   * Generate a unique slug for a playlist, adding -2, -3 etc if duplicate exists
   */
  private async generateUniqueSlug(name: string, currentPlaylistId: string): Promise<string> {
    const baseSlug = this.slugify(name);
    let slug = baseSlug;
    let counter = 1;

    while (
      await this.prisma.playlist.findFirst({
        where: {
          slug,
          playlistId: { not: currentPlaylistId }, // Exclude current playlist
        },
      })
    ) {
      counter++;
      slug = `${baseSlug}-${counter}`;
    }

    return slug;
  }

  /**
   * Clear all playlist-related caches for a given playlist
   * @param playlistId - The Spotify playlist ID
   * @param oldSlug - Optional old slug to clear (when slug has changed)
   */
  public async clearPlaylistCache(playlistId: string, oldSlug?: string): Promise<{ success: boolean; error?: string }> {
    try {
      // Get playlist to find the current slug
      const playlist = await this.prisma.playlist.findUnique({
        where: { playlistId },
        select: { slug: true },
      });

      // Clear all relevant caches
      await this.cache.delPattern(`${CACHE_KEY_FEATURED_PLAYLISTS}*`);
      await this.cache.del(`${CACHE_KEY_PLAYLIST}${playlistId}`);
      await this.cache.del(`${CACHE_KEY_PLAYLIST_DB}${playlistId}`);
      if (playlist?.slug) {
        await this.cache.del(`${CACHE_KEY_PLAYLIST}${playlist.slug}`);
        await this.cache.del(`${CACHE_KEY_PLAYLIST_DB}${playlist.slug}`);
      }
      // Clear old slug cache if provided and different from current
      if (oldSlug && oldSlug !== playlist?.slug) {
        await this.cache.del(`${CACHE_KEY_PLAYLIST}${oldSlug}`);
        await this.cache.del(`${CACHE_KEY_PLAYLIST_DB}${oldSlug}`);
      }

      this.logger.log(
        color.green.bold(`Cleared cache for playlist ${color.white.bold(playlistId)}`)
      );

      return { success: true };
    } catch (error: any) {
      this.logger.log(color.red.bold(`Error clearing playlist cache: ${error.message}`));
      return { success: false, error: error.message };
    }
  }

  /**
   * Send email notification when promotional playlist is sold
   */
  private async sendPromotionalSaleEmail(
    email: string,
    displayName: string,
    playlistName: string,
    creditedAmount: number,
    totalBalance: number,
    discountCode: string,
    shareLink: string,
    setupLink: string | null,
    locale: string,
    quantity: number
  ): Promise<void> {
    try {
      const mail = Mail.getInstance();
      await mail.sendPromotionalSaleEmail(
        email,
        displayName,
        playlistName,
        creditedAmount,
        totalBalance,
        discountCode,
        shareLink,
        setupLink,
        locale,
        quantity
      );
    } catch (error) {
      this.logger.log(`Error sending promotional sale email: ${error}`);
    }
  }

  /**
   * Get all promotional playlists (for admin dashboard)
   */
  public async getAllPromotionalPlaylists(): Promise<{
    success: boolean;
    data?: any[];
    error?: string;
  }> {
    try {
      const playlists = await this.prisma.playlist.findMany({
        where: {
          OR: [
            { promotionalActive: true },
            { promotionalUserId: { not: null } },
          ],
        },
        select: {
          id: true,
          playlistId: true,
          name: true,
          slug: true,
          image: true,
          promotionalTitle: true,
          promotionalDescription: true,
          promotionalActive: true,
          promotionalAccepted: true,
          promotionalDeclined: true,
          promotionalLocale: true,
          promotionalUserId: true,
          numberOfTracks: true,
        },
        orderBy: { id: 'desc' },
      });

      // Get user info and discount data for each playlist
      const playlistsWithDetails = await Promise.all(
        playlists.map(async (playlist) => {
          // Get user info
          let user = null;
          if (playlist.promotionalUserId) {
            user = await this.prisma.user.findUnique({
              where: { id: playlist.promotionalUserId },
              select: { email: true, displayName: true, hash: true },
            });
          }

          // Get payment info for generating setup link via payment_has_playlist
          let payment = null;
          if (playlist.promotionalUserId && user) {
            const paymentLink = await this.prisma.paymentHasPlaylist.findFirst({
              where: {
                playlistId: playlist.id,
                payment: {
                  userId: playlist.promotionalUserId,
                  status: 'paid',
                },
              },
              select: {
                payment: {
                  select: { paymentId: true },
                },
              },
              orderBy: { id: 'asc' },
            });
            payment = paymentLink?.payment || null;
          }

          // Get discount code info (now user-based)
          const discountCode = playlist.promotionalUserId
            ? await this.prisma.discountCode.findFirst({
                where: {
                  promotional: true,
                  promotionalUserId: playlist.promotionalUserId,
                },
                select: { code: true, amount: true },
              })
            : null;

          let totalSales = 0;
          if (discountCode) {
            // Count sales based on credit amount (each sale = 2.50)
            totalSales = Math.floor(discountCode.amount / PROMOTIONAL_CREDIT_AMOUNT);
          }

          return {
            ...playlist,
            user,
            payment,
            discountCode: discountCode?.code || null,
            discountBalance: discountCode?.amount || 0,
            totalSales,
            setupLink:
              payment && user
                ? `/promotional/${payment.paymentId}/${user.hash}/${playlist.playlistId}`
                : null,
          };
        })
      );

      return { success: true, data: playlistsWithDetails };
    } catch (error) {
      this.logger.log(`Error getting promotional playlists: ${error}`);
      return { success: false, error: 'Failed to get promotional playlists' };
    }
  }

  /**
   * Accept a promotional playlist:
   * 1. Translate the promotional description to all locales using ChatGPT
   * 2. Update all description_[locale] fields
   * 3. Set promotionalAccepted = 1
   * 4. Clear featured playlists cache
   * 5. Send approval email to user
   */
  public async acceptPromotionalPlaylist(
    playlistId: string
  ): Promise<{
    success: boolean;
    error?: string;
  }> {
    try {
      // Get playlist with promotional data including user info
      const playlist = await this.prisma.playlist.findUnique({
        where: { playlistId },
        select: {
          id: true,
          name: true,
          slug: true,
          promotionalTitle: true,
          promotionalDescription: true,
          promotionalLocale: true,
          promotionalUserId: true,
        },
      });

      if (!playlist) {
        return { success: false, error: 'Playlist not found' };
      }

      const description = playlist.promotionalDescription || '';
      const sourceLocale = playlist.promotionalLocale || 'en';

      // Helper to fetch email data for approval notification
      // Takes newSlug parameter in case the slug was updated during approval
      const fetchEmailData = async (newSlug?: string) => {
        if (!playlist.promotionalUserId) return undefined;

        const user = await this.prisma.user.findUnique({
          where: { id: playlist.promotionalUserId },
          select: { email: true, displayName: true, hash: true, locale: true },
        });

        if (!user) return undefined;

        const paymentLink = await this.prisma.paymentHasPlaylist.findFirst({
          where: {
            playlistId: playlist.id,
            payment: {
              userId: playlist.promotionalUserId,
              status: 'paid',
            },
          },
          select: {
            payment: {
              select: { paymentId: true },
            },
          },
          orderBy: { id: 'asc' },
        });

        const discountCode = await this.prisma.discountCode.findFirst({
          where: {
            promotional: true,
            promotionalUserId: playlist.promotionalUserId,
          },
          select: { code: true },
        });

        if (!paymentLink?.payment || !discountCode) return undefined;

        // Use the new slug if provided (admin may have changed it), otherwise fallback to original
        const currentSlug = newSlug || playlist.slug || playlistId;
        const shareLink = `${process.env['FRONTEND_URI']}/en/product/${currentSlug}`;
        const setupLink = `${process.env['FRONTEND_URI']}/promotional/${paymentLink.payment.paymentId}/${user.hash}/${playlistId}`;

        return {
          email: user.email,
          displayName: user.displayName || user.email.split('@')[0],
          playlistName: playlist.name,
          discountCode: discountCode.code,
          shareLink,
          setupLink,
          locale: user.locale || sourceLocale || 'en',
        };
      };

      if (!description.trim()) {
        // No description to translate, just accept and update name/slug if promotionalTitle exists
        const updateData: Record<string, any> = { promotionalAccepted: true };
        if (playlist.promotionalTitle) {
          const sanitizedName = this.sanitizeBrandName(playlist.promotionalTitle);
          updateData.name = sanitizedName;
          updateData.slug = await this.generateUniqueSlug(sanitizedName, playlistId);
        }
        const oldSlug = playlist.slug;
        await this.prisma.playlist.update({
          where: { playlistId },
          data: updateData,
        });

        // Clear all relevant caches (pass old slug in case it changed)
        await this.clearPlaylistCache(playlistId, oldSlug || undefined);

        // Pass the new slug to fetchEmailData so the email contains the correct URL
        const emailData = await fetchEmailData(updateData.slug);
        if (emailData) {
          await this.mail.sendPromotionalApprovedEmail(
            emailData.email,
            emailData.displayName,
            emailData.playlistName,
            emailData.discountCode,
            emailData.shareLink,
            emailData.setupLink,
            emailData.locale
          );
        } else {
          this.logger.log(
            color.yellow.bold(
              `Could not send approval email for playlist ${color.white.bold(playlistId)}: missing user/payment/discount data`
            )
          );
        }
        return { success: true };
      }

      // Sanitize description before translating (replace competitor brand name)
      const sanitizedDescription = this.sanitizeBrandName(description);

      this.logger.log(
        color.blue.bold(
          `Translating promotional description for playlist ${color.white.bold(
            playlistId
          )} from ${color.white.bold(sourceLocale)}`
        )
      );
      this.logger.log(
        color.blue.bold(`Description to translate: "${color.white.bold(sanitizedDescription.substring(0, 100))}..."`)
      );

      // Get all locales to translate to (including source for grammar/style fix)
      const allLocales = this.translation.allLocales;
      this.logger.log(
        color.blue.bold(`Target locales: ${color.white.bold(allLocales.join(', '))}`)
      );

      // Translate to all locales using ChatGPT
      const translations = await this.chatgpt.translateText(
        sanitizedDescription,
        allLocales
      );

      this.logger.log(
        color.blue.bold(`Translations received: ${color.white.bold(JSON.stringify(Object.keys(translations)))}`)
      );

      // Build update object with all description_[locale] fields
      // Also update name and slug with promotionalTitle if provided
      const updateData: Record<string, any> = {
        promotionalAccepted: true,
      };

      if (playlist.promotionalTitle) {
        const sanitizedName = this.sanitizeBrandName(playlist.promotionalTitle);
        updateData.name = sanitizedName;
        updateData.slug = await this.generateUniqueSlug(sanitizedName, playlistId);
      }

      for (const locale of allLocales) {
        const translatedText = translations[locale];
        if (translatedText) {
          // Sanitize each translated description as well (in case translation preserved brand name)
          updateData[`description_${locale}`] = this.sanitizeBrandName(translatedText);
        }
      }

      this.logger.log(
        color.green.bold(
          `Translated to ${color.white.bold(
            Object.keys(translations).length
          )} locales`
        )
      );

      // Update playlist with translations and accepted status
      const oldSlug = playlist.slug;
      await this.prisma.playlist.update({
        where: { playlistId },
        data: updateData,
      });

      // Clear all relevant caches (pass old slug in case it changed)
      await this.clearPlaylistCache(playlistId, oldSlug || undefined);

      this.logger.log(
        color.green.bold(
          `Accepted promotional playlist ${color.white.bold(playlistId)}`
        )
      );

      // Fetch data needed for approval email and send it
      // Pass the new slug to fetchEmailData so the email contains the correct URL
      const emailData = await fetchEmailData(updateData.slug);
      if (emailData) {
        await this.mail.sendPromotionalApprovedEmail(
          emailData.email,
          emailData.displayName,
          emailData.playlistName,
          emailData.discountCode,
          emailData.shareLink,
          emailData.setupLink,
          emailData.locale
        );
      } else {
        this.logger.log(
          color.yellow.bold(
            `Could not send approval email for playlist ${color.white.bold(playlistId)}: missing user/payment/discount data`
          )
        );
      }

      return { success: true };
    } catch (error: any) {
      this.logger.log(
        color.red.bold(
          `Error accepting promotional playlist ${playlistId}: ${error.message}`
        )
      );
      return { success: false, error: error.message };
    }
  }
}

export default Promotional;
