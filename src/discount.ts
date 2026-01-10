import { PrismaClient } from '@prisma/client';
import Utils from './utils';
import Cache from './cache';
import { randomBytes } from 'crypto';
import { createPrismaAdapter } from './prisma';

class Discount {
  private cache = Cache.getInstance();
  private prisma = new PrismaClient({ adapter: createPrismaAdapter() });
  private utils = new Utils();

  /**
   * Create a discount code with all business logic.
   * @param params Object containing amount, startDate, endDate, general, playlistId, digital
   * @returns {Promise<{ success: boolean, code?: string, error?: string }>}
   */
  public async createAdminDiscountCode(params: {
    amount: number;
    code?: string;
    description?: string;
    startDate?: number | null;
    endDate?: number | null;
    general?: boolean | number | string;
    playlistId?: string;
    digital?: boolean | number | string;
  }): Promise<{ success: boolean; code?: string; error?: string }> {
    try {
      const {
        amount,
        code: manualCode,
        description,
        startDate,
        endDate,
        general,
        playlistId,
        digital,
      } = params;

      // Validate required fields
      if (
        typeof amount !== 'number' ||
        isNaN(amount) ||
        amount <= 0
      ) {
        return { success: false, error: 'Invalid amount' };
      }

      // general and digital can be boolean or 1/0
      const generalBool = general === true || general === 1 || general === '1';
      const digitalBool = digital === true || digital === 1 || digital === '1';

      // Convert unix timestamps to Date or null
      const startDateObj = startDate ? new Date(Number(startDate) * 1000) : null;
      const endDateObj = endDate ? new Date(Number(endDate) * 1000) : null;

      let code: string;
      
      if (manualCode) {
        // Use the manually provided code
        code = manualCode.trim().toUpperCase();
        
        // Check if code already exists
        const existingCode = await this.prisma.discountCode.findUnique({
          where: { code },
        });
        
        if (existingCode) {
          return { success: false, error: 'Discount code already exists' };
        }
      } else {
        // Generate random code in format XXXX-XXXX-XXXX-XXXX
        const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
        const generatePart = () => {
          let result = '';
          for (let i = 0; i < 4; i++) {
            const idx = Math.floor(Math.random() * CHARS.length);
            result += CHARS[idx];
          }
          return result;
        };
        code = [generatePart(), generatePart(), generatePart(), generatePart()].join('-');
      }

      // Create the discount code in the database
      const discount = await this.prisma.discountCode.create({
        data: {
          code,
          amount,
          description: description || null,
          startDate: startDateObj,
          endDate: endDateObj,
          general: generalBool,
          playlistId: playlistId || null,
          digital: digitalBool,
        },
      });

      return { success: true, code: discount.code };
    } catch (error) {
      return { success: false, error: 'Failed to create discount code' };
    }
  }

  /**
   * Get all discount codes from the database.
   * @returns {Promise<{ success: boolean, discounts?: any[], error?: string }>}
   */
  public async getAllDiscounts(): Promise<{ success: boolean; discounts?: any[]; error?: string }> {
    try {
      const discounts = await this.prisma.discountCode.findMany({
        orderBy: { createdAt: 'desc' },
      });

      // Calculate spent and remaining amounts for each discount
      const discountsWithBalance = await Promise.all(
        discounts.map(async (discount) => {
          const totalUsed = await this.prisma.discountCodedUses.aggregate({
            where: { discountCodeId: discount.id },
            _sum: { amount: true },
          });

          const totalSpent = totalUsed._sum.amount || 0;
          const amountLeft = discount.amount - totalSpent;

          return {
            ...discount,
            totalSpent,
            amountLeft,
          };
        })
      );

      return { success: true, discounts: discountsWithBalance };
    } catch (error) {
      return { success: false, error: 'Failed to fetch discounts' };
    }
  }

  /**
   * Delete a discount code by id.
   * @param id Discount code id
   */
  public async deleteDiscountCode(id: number): Promise<{ success: boolean; error?: string }> {
    try {
      await this.prisma.discountCode.delete({
        where: { id },
      });
      return { success: true };
    } catch (error) {
      return { success: false, error: 'Failed to delete discount code' };
    }
  }

  /**
   * Update a discount code by id.
   * @param id Discount code id
   * @param params Same params as create
   */
  public async updateDiscountCode(
    id: number,
    params: {
      amount: number;
      code?: string;
      description?: string;
      startDate?: number | null;
      endDate?: number | null;
      general?: boolean | number | string;
      playlistId?: string;
      digital?: boolean | number | string;
    }
  ): Promise<{ success: boolean; code?: string; error?: string }> {
    try {
      const {
        amount,
        code: newCode,
        description,
        startDate,
        endDate,
        general,
        playlistId,
        digital,
      } = params;

      if (
        typeof amount !== 'number' ||
        isNaN(amount) ||
        amount <= 0
      ) {
        return { success: false, error: 'Invalid amount' };
      }

      const generalBool = general === true || general === 1 || general === '1';
      const digitalBool = digital === true || digital === 1 || digital === '1';
      const startDateObj = startDate ? new Date(Number(startDate) * 1000) : null;
      const endDateObj = endDate ? new Date(Number(endDate) * 1000) : null;

      const updateData: any = {
        amount,
        description: description !== undefined ? description : undefined,
        startDate: startDateObj,
        endDate: endDateObj,
        general: generalBool,
        playlistId: playlistId || null,
        digital: digitalBool,
      };

      // If a new code is provided, validate it's unique
      if (newCode) {
        const trimmedCode = newCode.trim().toUpperCase();
        
        // Check if this code exists for a different discount
        const existingCode = await this.prisma.discountCode.findUnique({
          where: { code: trimmedCode },
        });
        
        if (existingCode && existingCode.id !== id) {
          return { success: false, error: 'Discount code already exists' };
        }
        
        updateData.code = trimmedCode;
      }

      const updated = await this.prisma.discountCode.update({
        where: { id },
        data: updateData,
      });

      return { success: true, code: updated.code };
    } catch (error) {
      return { success: false, error: 'Failed to update discount code' };
    }
  }

  public async createDiscountCode(
    amount: number,
    from: string,
    message: string
  ): Promise<{ id: number; code: string }> {
    try {
      const CHARS = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';

      // Generate 4 groups of 4 characters
      const generatePart = () => {
        const bytes = randomBytes(4);
        let result = '';
        for (let i = 0; i < 4; i++) {
          result += CHARS[bytes[i] % CHARS.length];
        }
        return result;
      };

      const parts = Array.from({ length: 4 }, generatePart);
      const code = parts.join('-');

      const discount = await this.prisma.discountCode.create({
        data: {
          code,
          amount,
          from,
          message,
        },
      });

      return {
        id: discount.id,
        code: code,
      };
    } catch (error) {
      throw new Error(`Failed to create discount code: ${error}`);
    }
  }

  private async calculateAmountLeft(
    discountId: number,
    discountAmount: number
  ): Promise<number> {
    const totalUsed = await this.prisma.discountCodedUses.aggregate({
      where: { discountCodeId: discountId },
      _sum: { amount: true },
    });

    const amountUsed = totalUsed._sum.amount || 0;
    return discountAmount - amountUsed;
  }

  public async calculateTotalDiscountForPayment(
    paymentId: number
  ): Promise<number> {
    const totalDiscount = await this.prisma.discountCodedUses.aggregate({
      where: { paymentId: paymentId },
      _sum: { amount: true },
    });

    return totalDiscount._sum.amount || 0;
  }

  public async removeDiscountUsesByPaymentId(paymentId: number): Promise<any> {
    try {
      await this.prisma.discountCodedUses.deleteMany({
        where: {
          paymentId: paymentId,
        },
      });
      return { success: true, message: 'discountUsesRemovedSuccessfully' };
    } catch (error) {
      return { success: false, message: 'errorRemovingDiscountUses', error };
    }
  }

  public async associatePaymentWithDiscountUse(
    discountUseId: number,
    paymentId: number
  ): Promise<any> {
    try {
      await this.prisma.discountCodedUses.update({
        where: {
          id: discountUseId,
        },
        data: {
          paymentId: paymentId,
        },
      });
      return { success: true, message: 'paymentAssociatedSuccessfully' };
    } catch (error) {
      return { success: false, message: 'errorAssociatingPayment', error };
    }
  }

  public async checkDiscount(
    code: string,
    token: string,
    digital: boolean
  ): Promise<any> {
    // Verify reCAPTCHA token
    const isHuman = await this.utils.verifyRecaptcha(token);

    if (!isHuman) {
      throw new Error('Request failed');
    }

    try {
      const discount = await this.prisma.discountCode.findUnique({
        where: { code },
      });

      if (!discount) {
        return { success: false, message: 'discountCodeNotFound' };
      }

      if (!digital && discount.digital) {
        return { success: false, message: 'notApplicableForRealOrders' };
      }

      const now = new Date();
      if (
        (discount.startDate && discount.startDate > now) ||
        (discount.endDate && discount.endDate < now)
      ) {
        return { success: false, message: 'discountNotActive' };
      }

      const amountLeft = await this.calculateAmountLeft(
        discount.id,
        discount.amount
      );

      if (amountLeft <= 0) {
        return {
          success: false,
          message: 'discountCodeExhausted',
          fullAmount: discount.amount,
          amountLeft: parseFloat(amountLeft.toFixed(2)),
        };
      }

      return {
        success: true,
        fullAmount: discount.amount,
        amountLeft: parseFloat(amountLeft.toFixed(2)),
      };
    } catch (error: any) {
      return { success: false, message: 'errorCheckingDiscountCode', error };
    }
  }

  public async redeemDiscount(
    code: string,
    amount: number,
    cart: any
  ): Promise<any> {
    const cache = Cache.getInstance();
    const lockKey = `lock:discount:${code}`;
    const lockTimeout = 5000; // 5 seconds

    let lockAcquired = false;
    try {
      lockAcquired = await cache.executeCommand(
        'set',
        lockKey,
        'locked',
        'NX',
        'PX',
        lockTimeout
      );
      if (!lockAcquired) {
        return { success: false, message: 'discountCodeInUse' };
      }

      return await this.prisma.$transaction(async (prisma) => {
        const discount = await prisma.discountCode.findUnique({
          where: { code },
        });

        if (!discount) {
          return { success: false, message: 'discountCodeNotFound' };
        }

        const now = new Date();
        if (
          (discount.startDate && discount.startDate > now) ||
          (discount.endDate && discount.endDate < now)
        ) {
          return { success: false, message: 'discountNotActive' };
        }

        const amountLeft = await this.calculateAmountLeft(
          discount.id,
          discount.amount
        );

        if (amountLeft < amount && !discount.general) {
          return {
            success: false,
            message: 'insufficientDiscountAmountLeft',
            fullAmount: discount.amount,
            amountLeft: parseFloat(amountLeft.toFixed(2)),
          };
        }

        if (!discount.general) {
          const insertResult = await prisma.discountCodedUses.create({
            data: {
              amount: parseFloat(amount.toFixed(2)),
              discountCodeId: discount.id,
            },
          });
          return {
            success: true,
            message: 'discountRedeemedSuccessfully',
            fullAmount: discount.amount,
            amountLeft: parseFloat((amountLeft - amount).toFixed(2)),
            discountUseId: insertResult.id,
          };
        } else {
          if (cart.items.length == 1) {
            let usePlaylistId = cart.items[0].playlistId;
            const dbPlaylist = await this.prisma.playlist.findFirst({
              where: { slug: cart.items[0].playlistId },
            });
            if (dbPlaylist) {
              usePlaylistId = dbPlaylist.playlistId;
            }

            if (
              usePlaylistId == discount.playlistId &&
              ((cart.items[0].type == 'digital' && discount.digital) ||
                (cart.items[0].type == 'physical' && !discount.digital))
            ) {
              return {
                success: true,
                message: 'discountRedeemedSuccessfully',
                fullAmount: discount.amount,
                amountLeft: parseFloat(amount.toFixed(2)),
                discountUseId: 0,
              };
            } else {
              return {
                success: false,
                message: 'notApplicable',
                fullAmount: discount.amount,
                amountLeft: parseFloat(amountLeft.toFixed(2)),
              };
            }
          }
        }
      });
    } catch (error) {
      console.log(error);

      return {
        success: false,
        message: 'errorRedeemingDiscountCode',
        error,
      };
    } finally {
      if (lockAcquired) {
        await cache.executeCommand('del', lockKey);
      }
    }
  }

  public async getDiscountDetails(code: string): Promise<any> {
    try {
      const discount = await this.prisma.discountCode.findUnique({
        where: { code },
        select: {
          id: true,
          code: true,
          amount: true,
          description: true,
          from: true,
          message: true,
        },
      });

      if (!discount) {
        return { success: false, message: 'discountCodeNotFound' };
      }

      return {
        success: true,
        ...discount,
      };
    } catch (error) {
      return { success: false, message: 'errorRetrievingDiscountCode', error };
    }
  }

  public async calculateDiscounts(
    cart: any,
    totalAmount: number
  ): Promise<{
    discountAmount: number;
    discountUseIds: number[];
    discountUsed: boolean;
  }> {
    let discountAmount = 0;
    let discountUseIds: number[] = [];
    let discountUsed = false;

    if (cart.discounts && cart.discounts.length > 0) {
      let remainingTotal = totalAmount;

      for (const discount of cart.discounts) {
        const usableAmount = Math.min(discount.amountLeft, remainingTotal);

        if (usableAmount > 0) {
          const discountResult = await this.redeemDiscount(
            discount.code,
            usableAmount,
            cart
          );

          if (discountResult.success) {
            discountAmount += usableAmount;
            discountUseIds.push(discountResult.discountUseId);
            discountUsed = true;
            remainingTotal -= usableAmount;
          }
        }

        if (remainingTotal <= 0) {
          break;
        }
      }
    }

    return {
      discountAmount,
      discountUseIds,
      discountUsed,
    };
  }

  /**
   * Calculate volume discount for digital cards without creating a discount code
   * @param cart Cart object containing items
   * @returns Volume discount amount (0 if no discount applicable)
   */
  public async calculateVolumeDiscount(cart: any): Promise<number> {
    // Import Order class to access calculateDigitalCardPrice
    const Order = (await import('./order')).default;
    const order = Order.getInstance();

    // Filter digital card items only
    const digitalCardItems = cart.items.filter(
      (item: any) => item.type === 'digital' && item.productType === 'cards'
    );

    // Need at least 2 digital playlists for volume discount
    if (digitalCardItems.length < 2) {
      return 0;
    }

    // Calculate total cards across all digital playlists
    const totalCards = digitalCardItems.reduce(
      (sum: number, item: any) => sum + parseInt(item.numberOfTracks || 0),
      0
    );

    // Calculate ideal volume price for total cards
    const volumePricing = await order.calculateDigitalCardPrice(13, totalCards);

    // Calculate current price (each playlist priced individually at base €13)
    const currentPrice = digitalCardItems.reduce(
      (sum: number, item: any) => sum + (item.price * item.amount),
      0
    );

    // Calculate discount amount
    const discountAmount = currentPrice - volumePricing.totalPrice;

    // Return discount only if positive
    return discountAmount > 0 ? parseFloat(discountAmount.toFixed(2)) : 0;
  }
}

export default Discount;
