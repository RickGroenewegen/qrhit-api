import { color } from 'console-log-colors';
import axios from 'axios';
import { CronJob } from 'cron';
import cluster from 'cluster';
import Logger from './logger';
import PrismaInstance from './prisma';
import TrackingMore from 'trackingmore-sdk-nodejs';
import Utils from './utils';
import Cache from './cache';
import ExcelJS from 'exceljs';

class Shipping {
  private static instance: Shipping;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private trackingMore: TrackingMore;
  private utils = new Utils();
  private cache = Cache.getInstance();

  private constructor() {
    const apiKey = process.env['TRACKINGMORE_API_KEY'] || '';
    this.trackingMore = new TrackingMore(apiKey);

    // Schedule shipping status updates to run hourly
    if (cluster.isPrimary) {
      this.utils.isMainServer().then(async (isMainServer) => {
        if (isMainServer || process.env['ENVIRONMENT'] != 'development') {
          // Cron job to update shipping status for all Shipped payments
          // Runs every hour at minute :00
          new CronJob(
            '0 * * * *',
            async () => {
              await this.updateAllShippingStatuses();
            },
            null,
            true
          );
        }
      });
    }
  }

  public static getInstance(): Shipping {
    if (!Shipping.instance) {
      Shipping.instance = new Shipping();
    }
    return Shipping.instance;
  }

  /**
   * Creates a tracking order in TrackingMore API
   * @param trackingNumber The tracking number from the carrier
   * @param postalCode The destination postal code
   * @param destinationCountry The destination country code
   * @returns The tracking ID from TrackingMore or null if failed
   */
  private async createTrackingMoreShipment(
    trackingNumber: string,
    postalCode: string,
    destinationCountry: string
  ): Promise<string | null> {
    try {
      const apiKey = process.env['TRACKINGMORE_API_KEY'] || '';

      const options = {
        method: 'POST' as const,
        url: 'https://api.trackingmore.com/v4/trackings/create',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Tracking-Api-Key': apiKey,
        },
        data: {
          tracking_number: trackingNumber,
          courier_code: 'postnl-3s',
          tracking_postal_code: postalCode,
          tracking_destination_country: destinationCountry,
        },
      };

      const { data: result } = await axios.request(options);

      if (result?.meta?.code === 200 && result?.data?.id) {
        const trackingId = result.data.id;
        return trackingId;
      } else {
        this.logger.log(
          color.red.bold(
            `Failed to create TrackingMore shipment. Response: ${JSON.stringify(
              result
            )}`
          )
        );
        return null;
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error calling TrackingMore API: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      return null;
    }
  }

  /**
   * Creates a shipment by parsing the tracking URL and updating shipping information
   * @param paymentId The payment ID to process
   * @returns The updated payment object or null if no update needed
   */
  public async createShipment(paymentId: string) {
    // Retrieve the payment
    const payment = await this.prisma.payment.findUnique({
      where: { paymentId },
    });

    if (!payment) {
      throw new Error(`Payment with ID ${paymentId} not found`);
    }

    // Check if shippingId is already filled
    if (payment.shippingId) {
      this.logger.log(
        color.yellow.bold(
          `Shipping information already exists for payment ${color.white.bold(
            paymentId
          )} with TrackingMore ID: ${color.white.bold(payment.shippingId)}`
        )
      );
      return null;
    }

    // Check if tracking link exists
    if (!payment.printApiTrackingLink) {
      throw new Error(`No tracking link found for payment ${paymentId}`);
    }

    // Parse the URL to extract shipping information
    // URL format: https://jouw.postnl.nl/track-and-trace/{shippingCode}/{shippingCountry}/{shippingPostalCode}
    const url = payment.printApiTrackingLink;
    const urlParts = url.split('/').filter((part) => part.length > 0);

    // Get the last 3 parts
    if (urlParts.length < 3) {
      throw new Error(`Invalid tracking URL format: ${url}`);
    }

    const shippingPostalCode = urlParts[urlParts.length - 1];
    const shippingCountry = urlParts[urlParts.length - 2];
    const shippingCode = urlParts[urlParts.length - 3];

    // Update the payment with shipping information
    await this.prisma.payment.update({
      where: { paymentId },
      data: {
        shippingCode,
        shippingCountry,
        shippingPostalCode,
      },
    });

    this.logger.log(
      color.blue.bold(
        `Parsed shipping information for payment ${color.white.bold(
          paymentId
        )}: ${color.white.bold(shippingCode)} / ${color.white.bold(
          shippingCountry
        )} / ${color.white.bold(shippingPostalCode)}`
      )
    );

    // Create tracking order in TrackingMore
    const trackingMoreId = await this.createTrackingMoreShipment(
      shippingCode,
      shippingPostalCode,
      shippingCountry
    );

    if (!trackingMoreId) {
      this.logger.log(
        color.yellow.bold(
          `Failed to create TrackingMore shipment for payment ${color.white.bold(
            paymentId
          )}, but shipping info was saved`
        )
      );
      return await this.prisma.payment.findUnique({
        where: { paymentId },
      });
    }

    // Update payment with TrackingMore ID
    const updatedPayment = await this.prisma.payment.update({
      where: { paymentId },
      data: {
        shippingId: trackingMoreId,
      },
    });

    this.logger.log(
      color.green.bold(
        `Successfully created shipment for payment ${color.white.bold(
          paymentId
        )} with TrackingMore ID: ${color.white.bold(trackingMoreId)}`
      )
    );

    return updatedPayment;
  }

  /**
   * Creates shipments for all payments with printApiStatus = 'Shipped' and no shippingId
   * Processes all payments from the last 3 months with 500ms delay between each
   * @returns Summary of processing results
   */
  public async createAllShipments() {
    this.logger.log(
      color.blue.bold('Starting bulk shipment creation process...')
    );

    // Calculate date 3 months ago
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

    // Query payments with printApiStatus = 'Shipped' and no shippingId
    const payments = await this.prisma.payment.findMany({
      where: {
        printApiStatus: 'Shipped',
        shippingId: null,
        createdAt: {
          gte: threeMonthsAgo,
        },
      },
      orderBy: {
        createdAt: 'asc',
      },
    });

    this.logger.log(
      color.blue.bold(
        `Found ${color.white.bold(payments.length)} payment(s) to process`
      )
    );

    if (payments.length === 0) {
      this.logger.log(
        color.yellow.bold('No payments found that need shipping creation')
      );
      return {
        processed: 0,
        successful: 0,
        failed: 0,
        errors: [],
      };
    }

    let successful = 0;
    let failed = 0;
    const errors: string[] = [];

    for (let i = 0; i < payments.length; i++) {
      const payment = payments[i];
      this.logger.log(
        color.blue.bold(
          `Processing ${color.white.bold(
            i + 1
          )}/${color.white.bold(payments.length)}: Payment ${color.white.bold(
            payment.paymentId
          )}`
        )
      );

      try {
        await this.createShipment(payment.paymentId);
        successful++;
      } catch (error) {
        failed++;
        const errorMessage = `Payment ${payment.paymentId}: ${
          error instanceof Error ? error.message : 'Unknown error'
        }`;
        errors.push(errorMessage);
        this.logger.log(
          color.red(
            `✗ Failed to process payment ${color.white.bold(
              payment.paymentId
            )}: ${error instanceof Error ? error.message : 'Unknown error'}`
          )
        );
      }

      // Add 500ms delay between iterations (except for last one)
      if (i < payments.length - 1) {
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }

    const summary = {
      processed: payments.length,
      successful,
      failed,
      errors,
    };

    this.logger.log(
      color.green.bold(
        `Bulk shipment creation complete: ${color.white.bold(successful)} successful, ${color.white.bold(failed)} failed out of ${color.white.bold(payments.length)} total`
      )
    );

    return summary;
  }

  /**
   * Retrieves tracking information from TrackingMore by payment ID
   * @param paymentId The payment ID to retrieve tracking for
   * @returns The tracking response or null if not found
   */
  public async getTrackingInfo(paymentId: string) {
    // Retrieve the payment
    const payment = await this.prisma.payment.findUnique({
      where: { paymentId },
    });

    if (!payment) {
      this.logger.log(color.red.bold(`Payment ${paymentId} not found`));
      throw new Error(`Payment with ID ${paymentId} not found`);
    }

    if (!payment.shippingCode) {
      this.logger.log(
        color.yellow.bold(
          `Payment ${paymentId} has no tracking number (shippingCode)`
        )
      );
      throw new Error(`Payment ${paymentId} has no tracking number`);
    }

    // If already delivered, don't overwrite
    if (payment.shippingStatus === 'delivered') {
      // Still return the tracking info but don't update the database
      try {
        const apiKey = process.env['TRACKINGMORE_API_KEY'] || '';
        const options = {
          method: 'GET' as const,
          url: 'https://api.trackingmore.com/v4/trackings/get',
          params: {
            tracking_numbers: payment.shippingCode,
            courier_code: 'postnl-3s',
          },
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            'Tracking-Api-Key': apiKey,
          },
        };
        const { data: result } = await axios.request(options);
        return { result, updatedPayment: payment };
      } catch (error) {
        // this.logger.log(
        //   color.red.bold(
        //     `Error retrieving tracking info: ${
        //       error instanceof Error ? error.message : 'Unknown error'
        //     }`
        //   )
        // );
        throw error;
      }
    }

    try {
      const apiKey = process.env['TRACKINGMORE_API_KEY'] || '';

      const options = {
        method: 'GET' as const,
        url: 'https://api.trackingmore.com/v4/trackings/get',
        params: {
          tracking_numbers: payment.shippingCode,
          courier_code: 'postnl-3s',
        },
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'Tracking-Api-Key': apiKey,
        },
      };

      const { data: result } = await axios.request(options);

      if (result?.meta?.code === 200 && result?.data?.length > 0) {
        // Extract delivery status and latest tracking message
        const trackingData = result.data[0];
        const shippingStatus = trackingData.delivery_status || null;
        const shippingMessage = trackingData.origin_info?.trackinfo?.[0]?.tracking_detail || null;

        // Extract pickup/start date/time
        let shippingStartDateTime = null;
        const pickupDate = trackingData.origin_info?.milestone_date?.pickup_date;
        if (pickupDate) {
          shippingStartDateTime = new Date(pickupDate);
        }

        // Extract delivery date/time if status is 'delivered'
        let shippingDeliveryDateTime = null;
        if (shippingStatus === 'delivered') {
          const checkpointDate = trackingData.origin_info?.trackinfo?.[0]?.checkpoint_date;
          if (checkpointDate) {
            shippingDeliveryDateTime = new Date(checkpointDate);
          }
        }

        // Check if data actually changed
        const oldStartTime = payment.shippingStartDateTime?.getTime();
        const newStartTime = shippingStartDateTime?.getTime();
        const oldDeliveryTime = payment.shippingDeliveryDateTime?.getTime();
        const newDeliveryTime = shippingDeliveryDateTime?.getTime();

        const dataChanged =
          payment.shippingStatus !== shippingStatus ||
          payment.shippingMessage !== shippingMessage ||
          oldStartTime !== newStartTime ||
          oldDeliveryTime !== newDeliveryTime;

        // Update payment with shipping status, message, start date, and delivery date
        const updatedPayment = await this.prisma.payment.update({
          where: { paymentId },
          data: {
            shippingStatus,
            shippingMessage,
            shippingStartDateTime,
            shippingDeliveryDateTime,
          },
        });

        // Only log if data actually changed
        if (dataChanged) {
          this.logger.log(
            color.green.bold(
              `Updated tracking for ${color.white.bold(paymentId)} - Status: ${color.white.bold(shippingStatus || 'N/A')}${shippingStartDateTime ? `, Picked up: ${color.white.bold(shippingStartDateTime.toISOString())}` : ''}${shippingDeliveryDateTime ? `, Delivered: ${color.white.bold(shippingDeliveryDateTime.toISOString())}` : ''}`
            )
          );
        }

        return { result, updatedPayment };
      } else {
        return { result, updatedPayment: payment };
      }
    } catch (error) {
      // this.logger.log(
      //   color.red.bold(
      //     `Error retrieving tracking info: ${
      //       error instanceof Error ? error.message : 'Unknown error'
      //     }`
      //   )
      // );
      throw error;
    }
  }

  /**
   * Cron job method to update shipping statuses for all Shipped payments
   * Runs through all payments with printApiStatus = 'Shipped' and updates their tracking info
   * If status is 'delivered', also updates printApiStatus to 'Delivered'
   */
  public async updateAllShippingStatuses() {
    

    try {
      // Query all payments with printApiStatus = 'Shipped'
      const shippedPayments = await this.prisma.payment.findMany({
        where: {
          printApiStatus: 'Shipped',
          shippingCode: {
            not: null,
          },
        },
        orderBy: {
          createdAt: 'desc',
        },
      });

      // this.logger.log(
      //   color.blue.bold(
      //     `Found ${color.white.bold(shippedPayments.length)} payment(s) with status 'Shipped'`
      //   )
      // );

      if (shippedPayments.length === 0) {
        this.logger.log(
          color.yellow.bold('No shipped payments found to process')
        );
        return {
          processed: 0,
          delivered: 0,
          failed: 0,
          errors: [],
        };
      }

      let delivered = 0;
      let failed = 0;
      const errors: string[] = [];

      for (let i = 0; i < shippedPayments.length; i++) {
        const payment = shippedPayments[i];
        
        try {
          const { updatedPayment } = await this.getTrackingInfo(
            payment.paymentId
          );

          // If the shipping status is 'delivered', also update printApiStatus
          if (updatedPayment.shippingStatus === 'delivered') {
            await this.prisma.payment.update({
              where: { paymentId: payment.paymentId },
              data: {
                printApiStatus: 'Delivered',
              },
            });

            // this.logger.log(
            //   color.green.bold(
            //     `✓ Payment ${color.white.bold(
            //       payment.paymentId
            //     )} marked as Delivered`
            //   )
            // );
            delivered++;
          }
        } catch (error) {
          failed++;
          const errorMessage = `Payment ${payment.paymentId}: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`;
          errors.push(errorMessage);
          // this.logger.log(
          //   color.red(
          //     `✗ Failed to process payment ${color.white.bold(
          //       payment.paymentId
          //     )}: ${error instanceof Error ? error.message : 'Unknown error'}`
          //   )
          // );
        }

        // Add 500ms delay between iterations (except for last one)
        if (i < shippedPayments.length - 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }

      const summary = {
        processed: shippedPayments.length,
        delivered,
        failed,
        errors,
      };

      this.logger.log(
        color.green.bold(
          `Shipping status update job complete: ${color.white.bold(
            delivered
          )} marked as delivered, ${color.white.bold(
            failed
          )} failed out of ${color.white.bold(shippedPayments.length)} total`
        )
      );

      return summary;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error in shipping status update job: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      throw error;
    }
  }

  /**
   * Get tracking information for payments with pagination
   * Used by admin dashboard tracking page
   * @param status - 'Shipped' or 'Delivered'
   * @param page - Current page number
   * @param itemsPerPage - Number of items per page
   * @param textSearch - Optional text search for customer name
   * @param countryCode - Optional country code filter
   * @returns Paginated tracking data
   */
  public async getTracking(
    status: 'Shipped' | 'Delivered',
    page: number = 1,
    itemsPerPage: number = 100,
    textSearch?: string,
    countryCode?: string
  ) {
    try {
      // Calculate 3 months ago date
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

      // Build where clause - exclude ignored shipments for "Shipped" status
      const whereClause: any = {
        printApiStatus: status,
        createdAt: {
          gte: threeMonthsAgo,
        },
        shippingCode: {
          not: null,
        },
      };

      // Only filter out ignored shipments for "Shipped" status (In Transit tab)
      if (status === 'Shipped') {
        whereClause.shippingIgnore = false;
      }

      // Add text search filter if provided
      if (textSearch && textSearch.trim().length > 0) {
        whereClause.fullname = {
          contains: textSearch.trim(),
        };
      }

      // Add country code filter if provided
      if (countryCode && countryCode.trim().length > 0) {
        whereClause.countrycode = countryCode.trim();
      }

      // Determine sort order based on status
      // For in-transit (Shipped): sort by pickup date ascending (oldest/longest in transit first)
      // For delivered: sort by delivery date descending (most recently delivered first)
      const orderBy: any = status === 'Shipped'
        ? [
            { shippingStartDateTime: 'asc' as const }, // Oldest pickups first
            { createdAt: 'asc' as const } // Fallback to creation date if no pickup date
          ]
        : [
            { shippingDeliveryDateTime: 'desc' as const }, // Most recently delivered first
            { createdAt: 'desc' as const } // Fallback to creation date if no delivery date
          ];

      // Query payments with pagination
      const [payments, totalCount] = await Promise.all([
        this.prisma.payment.findMany({
          where: whereClause,
          select: {
            paymentId: true,
            orderId: true,
            shippingCode: true,
            fullname: true,
            zipcode: true,
            countrycode: true,
            printApiTrackingLink: true,
            printApiOrderId: true,
            shippingStatus: true,
            shippingMessage: true,
            shippingStartDateTime: true,
            shippingDeliveryDateTime: true,
            shippingIgnore: true,
            createdAt: true,
          },
          orderBy: orderBy,
          skip: (page - 1) * itemsPerPage,
          take: itemsPerPage,
        }),
        this.prisma.payment.count({
          where: whereClause,
        }),
      ]);

      const totalPages = Math.ceil(totalCount / itemsPerPage);

      return {
        data: payments,
        totalItems: totalCount,
        currentPage: page,
        itemsPerPage,
        totalPages,
      };
    } catch (error) {
      throw error;
    }
  }

  /**
   * Get list of available country codes from recent shipments
   * @returns Array of unique country codes
   */
  public async getAvailableCountryCodes(): Promise<string[]> {
    try {
      // Get unique country codes from last 3 months of shipped/delivered orders
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

      const payments = await this.prisma.payment.findMany({
        where: {
          printApiStatus: {
            in: ['Shipped', 'Delivered'],
          },
          createdAt: {
            gte: threeMonthsAgo,
          },
          countrycode: {
            not: null,
          },
        },
        select: {
          countrycode: true,
        },
        distinct: ['countrycode'],
        orderBy: {
          countrycode: 'asc',
        },
      });

      return payments
        .map(p => p.countrycode)
        .filter((code): code is string => code !== null)
        .sort();
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error fetching available country codes: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      throw error;
    }
  }

  /**
   * Generate Excel export of tracking data
   * @param status - 'Shipped' or 'Delivered'
   * @param textSearch - Optional text search for customer name
   * @param countryCode - Optional country code filter
   * @returns Excel buffer
   */
  public async exportTrackingToExcel(
    status: 'Shipped' | 'Delivered',
    textSearch?: string,
    countryCode?: string
  ): Promise<Buffer> {
    try {
      // Get all matching data (no pagination)
      const threeMonthsAgo = new Date();
      threeMonthsAgo.setMonth(threeMonthsAgo.getMonth() - 3);

      const whereClause: any = {
        printApiStatus: status,
        createdAt: {
          gte: threeMonthsAgo,
        },
        shippingCode: {
          not: null,
        },
      };

      // Only filter out ignored shipments for "Shipped" status (In Transit tab)
      if (status === 'Shipped') {
        whereClause.shippingIgnore = false;
      }

      // Add text search filter if provided
      if (textSearch && textSearch.trim().length > 0) {
        whereClause.fullname = {
          contains: textSearch.trim(),
        };
      }

      // Add country code filter if provided
      if (countryCode && countryCode.trim().length > 0) {
        whereClause.countrycode = countryCode.trim();
      }

      // Determine sort order based on status
      const orderBy: any = status === 'Shipped'
        ? [
            { shippingStartDateTime: 'asc' as const },
            { createdAt: 'asc' as const }
          ]
        : [
            { shippingDeliveryDateTime: 'desc' as const },
            { createdAt: 'desc' as const }
          ];

      // Fetch all matching payments
      const payments = await this.prisma.payment.findMany({
        where: whereClause,
        select: {
          printApiOrderId: true,
          fullname: true,
          shippingStartDateTime: true,
          shippingDeliveryDateTime: true,
        },
        orderBy: orderBy,
      });

      // Create workbook and worksheet
      const workbook = new ExcelJS.Workbook();
      const worksheet = workbook.addWorksheet(
        status === 'Shipped' ? 'In Transit' : 'Delivered'
      );

      // Add header row
      worksheet.columns = [
        { header: 'Print API Order ID', key: 'printApiOrderId', width: 25 },
        { header: 'Customer', key: 'customer', width: 30 },
        { header: 'Shipping Start Date', key: 'shippingStartDate', width: 20 },
        { header: 'Shipping Delivery Date', key: 'shippingDeliveryDate', width: 20 },
        { header: 'Days', key: 'days', width: 10 },
      ];

      // Style header row
      worksheet.getRow(1).font = { bold: true };
      worksheet.getRow(1).fill = {
        type: 'pattern',
        pattern: 'solid',
        fgColor: { argb: 'FFE0E0E0' },
      };

      // Add data rows
      payments.forEach((payment) => {
        let days: number | null = null;

        if (status === 'Shipped') {
          // For in-transit: days since pickup
          if (payment.shippingStartDateTime) {
            const now = new Date();
            const startDate = new Date(payment.shippingStartDateTime);
            const diffInMs = now.getTime() - startDate.getTime();
            let diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
            days = diffInDays === 0 ? 1 : diffInDays;
          }
        } else {
          // For delivered: delivery time (pickup to delivery)
          if (payment.shippingStartDateTime && payment.shippingDeliveryDateTime) {
            const startDate = new Date(payment.shippingStartDateTime);
            const deliveryDate = new Date(payment.shippingDeliveryDateTime);
            const diffInMs = deliveryDate.getTime() - startDate.getTime();
            let diffInDays = Math.floor(diffInMs / (1000 * 60 * 60 * 24));
            days = diffInDays === 0 ? 1 : diffInDays;
          }
        }

        const formatDateTime = (date: Date | null): string => {
          if (!date) return '-';
          const d = new Date(date);
          const day = String(d.getDate()).padStart(2, '0');
          const month = String(d.getMonth() + 1).padStart(2, '0');
          const year = d.getFullYear();
          const hours = String(d.getHours()).padStart(2, '0');
          const minutes = String(d.getMinutes()).padStart(2, '0');
          return `${day}-${month}-${year} ${hours}:${minutes}`;
        };

        worksheet.addRow({
          printApiOrderId: payment.printApiOrderId || '-',
          customer: payment.fullname || '-',
          shippingStartDate: formatDateTime(payment.shippingStartDateTime),
          shippingDeliveryDate: formatDateTime(payment.shippingDeliveryDateTime),
          days: days !== null ? days : '-',
        });
      });

      // Generate Excel buffer
      const buffer = await workbook.xlsx.writeBuffer();
      return Buffer.from(buffer);
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error generating tracking Excel export: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      throw error;
    }
  }

  /**
   * Toggle shippingIgnore status for a payment
   * @param paymentId - The payment ID to update
   * @param ignore - Whether to ignore (true) or unignore (false) the shipment
   * @returns Updated payment with shippingIgnore status
   */
  public async toggleIgnoreStatus(paymentId: string, ignore: boolean) {
    this.logger.log(
      color.blue.bold(
        `Toggling shipping ignore for payment ${color.white.bold(
          paymentId
        )} to ${color.white.bold(ignore ? 'ignored' : 'unignored')}`
      )
    );

    try {
      const updatedPayment = await this.prisma.payment.update({
        where: { paymentId },
        data: { shippingIgnore: ignore },
        select: {
          paymentId: true,
          orderId: true,
          shippingIgnore: true,
        },
      });

      this.logger.log(
        color.green.bold(
          `Successfully ${ignore ? 'ignored' : 'unignored'} shipment for payment ${color.white.bold(
            paymentId
          )}`
        )
      );

      return updatedPayment;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error toggling shipping ignore for payment ${paymentId}: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      throw error;
    }
  }

  /**
   * Get average delivery times per country for orders delivered in the past 2 weeks
   * Results are cached in Redis for 1 hour
   * @returns Array of { countryCode, averageDays, orderCount }
   */
  public async getAverageDeliveryTimes(): Promise<{ countryCode: string; averageDays: number; orderCount: number }[]> {
    try {
      // Check cache first
      const cacheKey = 'average_delivery_times';
      const cachedData = await this.cache.get(cacheKey);

      if (cachedData) {       
        return JSON.parse(cachedData);
      }

      // Calculate date 2 weeks ago
      const twoWeeksAgo = new Date();
      twoWeeksAgo.setDate(twoWeeksAgo.getDate() - 14);

      // Query delivered orders from the past 2 weeks
      const payments = await this.prisma.payment.findMany({
        where: {
          printApiStatus: 'Delivered',
          shippingDeliveryDateTime: {
            gte: twoWeeksAgo,
          },
          shippingStartDateTime: {
            not: null,
          },
          test: false,
          vibe: false,
          shippingIgnore: false,
          countrycode: {
            not: null,
          },
        },
        select: {
          countrycode: true,
          shippingStartDateTime: true,
          shippingDeliveryDateTime: true,
        },
      });

      // Group by country and calculate averages with standard deviation
      const countryStats: { [key: string]: { totalDays: number; count: number; days: number[] } } = {};

      for (const payment of payments) {
        if (payment.countrycode && payment.shippingStartDateTime && payment.shippingDeliveryDateTime) {
          const startTime = new Date(payment.shippingStartDateTime).getTime();
          const deliveryTime = new Date(payment.shippingDeliveryDateTime).getTime();
          const days = (deliveryTime - startTime) / (1000 * 60 * 60 * 24);

          if (!countryStats[payment.countrycode]) {
            countryStats[payment.countrycode] = { totalDays: 0, count: 0, days: [] };
          }

          countryStats[payment.countrycode].totalDays += days;
          countryStats[payment.countrycode].count += 1;
          countryStats[payment.countrycode].days.push(days);
        }
      }

      // Calculate averages, standard deviation, and format result
      const result = Object.entries(countryStats)
        .map(([countryCode, stats]) => {
          const average = stats.totalDays / stats.count;
          let averageDays = Math.round(average);
          // If rounded to 0, set to 1
          if (averageDays === 0) {
            averageDays = 1;
          }

          // Calculate standard deviation
          const variance = stats.days.reduce((acc, day) => acc + Math.pow(day - average, 2), 0) / stats.count;
          const standardDeviation = Math.round(Math.sqrt(variance));

          // Calculate range (ensuring min is at least 1)
          const minDays = Math.max(1, averageDays);
          const maxDays = averageDays + standardDeviation + 1;

          return {
            countryCode,
            averageDays,
            standardDeviation,
            minDays,
            maxDays,
            orderCount: stats.count,
          };
        })
        .sort((a, b) => a.averageDays - b.averageDays);

      // Cache for 1 hour (3600 seconds)
      await this.cache.set(cacheKey, JSON.stringify(result), 3600);

      return result;
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error calculating average delivery times: ${
            error instanceof Error ? error.message : 'Unknown error'
          }`
        )
      );
      throw error;
    }
  }
}

export default Shipping;
