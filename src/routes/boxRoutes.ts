import { FastifyInstance } from 'fastify';
import Designer from '../designer';
import Logger from '../logger';

// Box configuration constants
const BOX_PRICE_PER_UNIT = 6.90;
const BOX_CAPACITY = 200; // cards per box

export default async function boxRoutes(fastify: FastifyInstance) {
  const designer = Designer.getInstance();
  const logger = new Logger();

  /**
   * Get box pricing information
   * Returns the price per box and capacity (backend-driven)
   */
  fastify.get('/box/pricing', async (_request, _reply) => {
    return {
      success: true,
      data: {
        pricePerBox: BOX_PRICE_PER_UNIT,
        capacity: BOX_CAPACITY,
      },
    };
  });

  /**
   * Calculate box requirements based on card count
   * Returns number of boxes needed and total price
   */
  fastify.get('/box/calculate/:cardCount', async (request: any, _reply) => {
    const cardCount = parseInt(request.params.cardCount, 10);

    if (isNaN(cardCount) || cardCount < 0) {
      return {
        success: false,
        error: 'Invalid card count',
      };
    }

    // If no cards, no boxes needed
    if (cardCount === 0) {
      return {
        success: true,
        data: {
          boxesRequired: 0,
          pricePerBox: BOX_PRICE_PER_UNIT,
          totalPrice: 0,
          capacity: BOX_CAPACITY,
        },
      };
    }

    const boxesRequired = Math.ceil(cardCount / BOX_CAPACITY);
    const totalPrice = parseFloat((boxesRequired * BOX_PRICE_PER_UNIT).toFixed(2));

    return {
      success: true,
      data: {
        boxesRequired,
        pricePerBox: BOX_PRICE_PER_UNIT,
        totalPrice,
        capacity: BOX_CAPACITY,
      },
    };
  });

  /**
   * Upload box insert image
   * Accepts base64 encoded image and saves it to the box-inserts directory
   */
  fastify.post('/box/upload/insert', async (request: any, reply: any) => {
    try {
      const { image } = request.body;

      if (!image) {
        return reply.status(400).send({
          success: false,
          error: 'No image provided',
        });
      }

      const result = await designer.uploadBoxInsertImage(image);

      if (result.success) {
        return {
          success: true,
          data: {
            filename: result.filename,
          },
        };
      } else {
        return reply.status(400).send({
          success: false,
          error: result.error || 'Failed to upload image',
        });
      }
    } catch (error) {
      logger.log(`Error uploading box insert image: ${error}`);
      return reply.status(500).send({
        success: false,
        error: 'Internal server error',
      });
    }
  });
}
