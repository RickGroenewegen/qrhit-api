import { PrismaClient } from '@prisma/client';
import PrismaInstance from './prisma';
import Logger from './logger';
import Mail from './mail';
import { ChatGPT } from './chatgpt';
import Cache from './cache';
import Translation from './translation';
import { color } from 'console-log-colors';
import { CACHE_KEY_FEATURED_PLAYLISTS } from './data';

const PROMOTIONAL_CREDIT_AMOUNT = parseFloat(process.env['PROMOTIONAL_CREDIT_AMOUNT'] || '2.5');

class Promotional {
  private static instance: Promotional;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
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
      shareLink: string;
      discountCode: string | null;
      discountBalance: number;
      slug: string;
      playlistName: string;
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
        },
      });

      if (!playlist) {
        return { success: false, error: 'Playlist not found' };
      }

      // Get discount code balance if exists
      const discountCode = await this.prisma.discountCode.findFirst({
        where: {
          promotional: true,
          promotionalPlaylistId: playlist.id,
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
              promotionalPlaylistId: playlist.id,
            },
          },
          _sum: { amount: true },
        });
        discountBalance = discountCode.amount - (totalUsed._sum.amount || 0);
      }

      // Generate share link using existing product page
      const shareLink = `${process.env['FRONTEND_URI']}/en/product/${playlist.slug || playlistId}`;

      // For new setups (where promotionalTitle is null), default active to true
      // This ensures the checkbox is checked by default on first visit
      const isFirstTimeSetup = !playlist.promotionalTitle;
      const activeState = isFirstTimeSetup ? true : playlist.promotionalActive;

      return {
        success: true,
        data: {
          title: playlist.promotionalTitle || playlist.name,
          description: playlist.promotionalDescription || '',
          image: playlist.image,
          active: activeState,
          shareLink,
          discountCode: discountCode?.code || null,
          discountBalance,
          slug: playlist.slug,
          playlistName: playlist.name,
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

      // Check if a discount code already exists for this promotional playlist
      let discountCode = await this.prisma.discountCode.findFirst({
        where: {
          promotional: true,
          promotionalPlaylistId: playlist.id,
        },
      });

      if (discountCode) {
        // Add to existing discount code balance
        await this.prisma.discountCode.update({
          where: { id: discountCode.id },
          data: {
            amount: discountCode.amount + PROMOTIONAL_CREDIT_AMOUNT,
          },
        });
      } else {
        // Create new promotional discount code
        const code = this.generateDiscountCode();
        discountCode = await this.prisma.discountCode.create({
          data: {
            code,
            amount: PROMOTIONAL_CREDIT_AMOUNT,
            description: `Promotional discount for playlist: ${playlist.name}`,
            promotional: true,
            promotionalPlaylistId: playlist.id,
            general: false,
            digital: false, // Can be used for any order type
          },
        });
      }

      // Calculate new balance
      const totalUsed = await this.prisma.discountCodedUses.aggregate({
        where: { discountCodeId: discountCode.id },
        _sum: { amount: true },
      });
      const newBalance = discountCode.amount + PROMOTIONAL_CREDIT_AMOUNT - (totalUsed._sum.amount || 0);

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
        PROMOTIONAL_CREDIT_AMOUNT,
        newBalance,
        discountCode.code,
        `${process.env['FRONTEND_URI']}/${creator.locale || 'en'}/product/${playlist.slug || playlist.playlistId}`,
        setupLink,
        creator.locale || 'en'
      );

      this.logger.log(
        `Credited ${PROMOTIONAL_CREDIT_AMOUNT} EUR to promotional discount for playlist ${playlist.name} (code: ${discountCode.code})`
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
    locale: string
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
        locale
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

          // Get discount code info
          const discountCode = await this.prisma.discountCode.findFirst({
            where: {
              promotional: true,
              promotionalPlaylistId: playlist.id,
            },
            select: { code: true, amount: true },
          });

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
   */
  public async acceptPromotionalPlaylist(
    playlistId: string
  ): Promise<{ success: boolean; error?: string }> {
    try {
      // Get playlist with promotional data
      const playlist = await this.prisma.playlist.findUnique({
        where: { playlistId },
        select: {
          id: true,
          promotionalDescription: true,
          promotionalLocale: true,
        },
      });

      if (!playlist) {
        return { success: false, error: 'Playlist not found' };
      }

      const description = playlist.promotionalDescription || '';
      const sourceLocale = playlist.promotionalLocale || 'en';

      if (!description.trim()) {
        // No description to translate, just accept
        await this.prisma.playlist.update({
          where: { playlistId },
          data: { promotionalAccepted: true },
        });
        await this.cache.delPattern(`${CACHE_KEY_FEATURED_PLAYLISTS}*`);
        return { success: true };
      }

      this.logger.log(
        color.blue.bold(
          `Translating promotional description for playlist ${color.white.bold(
            playlistId
          )} from ${color.white.bold(sourceLocale)}`
        )
      );
      this.logger.log(
        color.blue.bold(`Description to translate: "${color.white.bold(description.substring(0, 100))}..."`)
      );

      // Get all locales to translate to (including source for grammar/style fix)
      const allLocales = this.translation.allLocales;
      this.logger.log(
        color.blue.bold(`Target locales: ${color.white.bold(allLocales.join(', '))}`)
      );

      // Translate to all locales using ChatGPT
      const translations = await this.chatgpt.translateText(
        description,
        allLocales
      );

      this.logger.log(
        color.blue.bold(`Translations received: ${color.white.bold(JSON.stringify(Object.keys(translations)))}`)
      );

      // Build update object with all description_[locale] fields
      const updateData: Record<string, any> = {
        promotionalAccepted: true,
      };

      for (const locale of allLocales) {
        const translatedText = translations[locale];
        if (translatedText) {
          updateData[`description_${locale}`] = translatedText;
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
      await this.prisma.playlist.update({
        where: { playlistId },
        data: updateData,
      });

      // Clear featured playlists cache
      await this.cache.delPattern(`${CACHE_KEY_FEATURED_PLAYLISTS}*`);

      this.logger.log(
        color.green.bold(
          `Accepted promotional playlist ${color.white.bold(playlistId)}`
        )
      );

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
