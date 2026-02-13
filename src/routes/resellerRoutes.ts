import { FastifyInstance } from 'fastify';
import swagger from '@fastify/swagger';
import swaggerUi from '@fastify/swagger-ui';
import { verifyResellerApiKey } from '../resellerAuth';
import Resellers from '../resellers';
import Logger from '../logger';
import { FONTS } from '../fonts';
import { color, white } from 'console-log-colors';

const logger = new Logger();

// -- Shared schema components --

const ErrorResponse = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    error: { type: 'string' },
  },
} as const;

const DesignObject = {
  type: 'object',
  description: 'Card design configuration. Image fields (background, backgroundBack, logo) accept either a numeric media ID (from /reseller/media/upload) or a filename string.',
  properties: {
    // -- Images (media ID or filename) --
    background: {
      description: 'Front background image. Pass a media ID (integer from upload endpoint, type=background) or a filename string. Leave empty for solid color.',
    },
    backgroundBack: {
      description: 'Back background image. Pass a media ID (integer from upload endpoint, type=background_back) or a filename string. Leave empty for solid color.',
    },
    logo: {
      description: 'Logo image overlaid on the front of the card. Pass a media ID (integer from upload endpoint, type=logo) or a filename string.',
    },

    // -- Front side settings --
    backgroundFrontType: {
      type: 'string',
      enum: ['solid', 'image'],
      default: 'image',
      description: 'Front background type. "image" uses the background image, "solid" uses backgroundFrontColor.',
    },
    backgroundFrontColor: {
      type: 'string',
      default: '#ffffff',
      description: 'Solid color for the front background (used when backgroundFrontType is "solid").',
    },
    useFrontGradient: {
      type: 'boolean',
      default: false,
      description: 'Enable gradient overlay on the front side.',
    },
    gradientFrontColor: {
      type: 'string',
      default: '#ffffff',
      description: 'Second color for the front gradient.',
    },
    gradientFrontDegrees: {
      type: 'integer',
      default: 180,
      minimum: 0,
      maximum: 360,
      description: 'Gradient angle in degrees for the front side.',
    },
    gradientFrontPosition: {
      type: 'integer',
      default: 50,
      minimum: 0,
      maximum: 100,
      description: 'Gradient color stop position (0-100) for the front side.',
    },
    frontOpacity: {
      type: 'integer',
      default: 100,
      minimum: 0,
      maximum: 100,
      description: 'Front background image opacity (0 = transparent, 100 = fully visible).',
    },

    // -- Back side settings --
    backgroundBackType: {
      type: 'string',
      enum: ['solid', 'image'],
      default: 'image',
      description: 'Back background type. "image" uses the backgroundBack image, "solid" uses backgroundBackColor.',
    },
    backgroundBackColor: {
      type: 'string',
      default: '#ffffff',
      description: 'Solid color for the back background (used when backgroundBackType is "solid").',
    },
    fontColor: {
      type: 'string',
      default: '#000000',
      description: 'Text color for the back side (track name, artist, year).',
    },
    useGradient: {
      type: 'boolean',
      default: false,
      description: 'Enable gradient overlay on the back side.',
    },
    gradientBackgroundColor: {
      type: 'string',
      default: '#ffffff',
      description: 'Second color for the back gradient.',
    },
    gradientDegrees: {
      type: 'integer',
      default: 180,
      minimum: 0,
      maximum: 360,
      description: 'Gradient angle in degrees for the back side.',
    },
    gradientPosition: {
      type: 'integer',
      default: 50,
      minimum: 0,
      maximum: 100,
      description: 'Gradient color stop position (0-100) for the back side.',
    },
    backOpacity: {
      type: 'integer',
      default: 50,
      minimum: 0,
      maximum: 100,
      description: 'Back background image opacity (0 = transparent, 100 = fully visible).',
    },

    // -- QR code settings --
    qrColor: {
      type: 'string',
      default: '#000000',
      description: 'Color of the QR code dots.',
    },
    qrBackgroundColor: {
      type: 'string',
      default: '#ffffff',
      description: 'Background color of the QR code area.',
    },
    qrBackgroundType: {
      type: 'string',
      enum: ['none', 'circle', 'square'],
      default: 'square',
      description: 'Shape of the background behind the QR code. "none" for transparent, "circle" or "square" for a colored shape.',
    },
    hideCircle: {
      type: 'boolean',
      default: false,
      description: 'Legacy field. When true, sets qrBackgroundType to "none".',
    },

    // -- Typography --
    emoji: {
      type: 'string',
      default: '',
      description: 'Emoji displayed on the front of the card (e.g. "🎵").',
    },
    selectedFont: {
      type: 'string',
      default: '',
      description: 'Google Font name for the back side text (e.g. "Oswald", "Caveat"). Leave empty for Arial. See GET /reseller/fonts for available options.',
    },
    selectedFontSize: {
      type: 'string',
      default: '16px',
      description: 'CSS font size for the back side text.',
    },

    // -- Card options --
    doubleSided: {
      type: 'boolean',
      default: false,
      description: 'Generate double-sided cards (front + back). When false, only front is generated.',
    },
    eco: {
      type: 'boolean',
      default: false,
      description: 'Eco mode - reduces ink usage by simplifying the design.',
    },
  },
} as const;

// -- Route definitions --

export default async function resellerRoutes(fastify: FastifyInstance) {
  // Register Swagger docs only in development
  if (process.env['ENVIRONMENT'] === 'development') {
    await fastify.register(swagger, {
      openapi: {
        info: {
          title: 'QRSong! Reseller API',
          description:
            'API for third-party resellers to create card orders and download printer PDFs.\n\n' +
            '## Authentication\n' +
            'All endpoints require an API key passed as a Bearer token:\n' +
            '```\nAuthorization: Bearer rk_your_api_key_here\n```\n\n' +
            '## Workflow\n' +
            '1. **Upload media** (optional) - Upload background/logo images via `POST /reseller/media/upload`\n' +
            '2. **Create order** - Submit a playlist URL + design JSON via `POST /reseller/orders`\n' +
            '3. **Poll for status** - Check order progress via `GET /reseller/orders/:orderId` until status is `done`\n' +
            '4. **Download PDF** - Use the `pdfUrl` from the status response to download the printer-ready PDF\n\n' +
            '## Design JSON\n' +
            'The `design` object controls the visual appearance of the cards. Key concepts:\n' +
            '- **Front side**: The side with the QR code and optional emoji/logo\n' +
            '- **Back side**: The side with the track name, artist, and year\n' +
            '- **Media IDs**: Upload images first, then reference them by their returned `mediaId` (integer)\n' +
            '- **Colors**: All colors are CSS hex strings (e.g. `#ff0000`)\n' +
            '- **Gradients**: Optional gradient overlays on front/back with configurable angle and position',
          version: '1.0.0',
        },
        components: {
          securitySchemes: {
            apiKey: {
              type: 'http',
              scheme: 'bearer',
              bearerFormat: 'API Key',
              description: 'API key starting with rk_',
            },
          },
        },
        security: [{ apiKey: [] }],
        tags: [
          { name: 'Backgrounds', description: 'Available preset background images for card designs' },
          { name: 'Fonts', description: 'Available font options for card designs' },
          { name: 'Media', description: 'Upload images for card designs' },
          { name: 'Orders', description: 'Create and track orders' },
          { name: 'Preview', description: 'Preview card designs before ordering' },
        ],
      },
    });

    await fastify.register(swaggerUi, {
      routePrefix: '/reseller/docs',
      uiConfig: {
        docExpansion: 'list',
        deepLinking: true,
      },
    });
  }

  const resellers = Resellers.getInstance();
  await resellers.init();

  // -- POST /reseller/media/upload --
  fastify.post(
    '/reseller/media/upload',
    {
      preHandler: verifyResellerApiKey,
      schema: {
        tags: ['Media'],
        summary: 'Upload a media image',
        description:
          'Upload a background, back background, or logo image for use in card designs. ' +
          'Send as `multipart/form-data` with an `image` file field and a `type` text field. ' +
          'Returns a `mediaId` that can be referenced in the design JSON when creating orders.',
        consumes: ['multipart/form-data'],
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  mediaId: { type: 'integer', description: 'Use this ID in the design JSON when creating orders.' },
                  type: { type: 'string' },
                },
              },
            },
          },
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request: any, reply: any) => {
      try {
        const validTypes = ['background', 'background_back', 'logo'];
        let imageBuffer: Buffer | null = null;
        let type: string | null = null;

        const parts = request.parts();
        for await (const part of parts) {
          if (part.type === 'file' && part.fieldname === 'image') {
            imageBuffer = await part.toBuffer();
          } else if (part.type === 'field' && part.fieldname === 'type') {
            type = part.value as string;
          }
        }

        if (!imageBuffer || !type) {
          reply.status(400);
          return { success: false, error: 'Missing required fields: image (file), type (field)' };
        }

        if (!validTypes.includes(type)) {
          reply.status(400);
          return { success: false, error: `Invalid type. Must be one of: ${validTypes.join(', ')}` };
        }

        // Convert file buffer to base64 for the designer methods
        const base64Image = imageBuffer.toString('base64');

        const result = await resellers.uploadMedia(
          request.resellerUser.id,
          base64Image,
          type as 'background' | 'background_back' | 'logo'
        );

        if (!result.success) {
          reply.status(400);
        }

        return result;
      } catch (error: any) {
        logger.log(color.red.bold(`[${white.bold('Reseller')}] ${error.message || error}`));
        reply.status(500);
        return { success: false, error: 'Internal server error' };
      }
    }
  );

  // -- POST /reseller/orders --
  fastify.post(
    '/reseller/orders',
    {
      preHandler: verifyResellerApiKey,
      schema: {
        tags: ['Orders'],
        summary: 'Create a new card order',
        description:
          'Create a physical card order from a music playlist URL. The order is processed asynchronously - ' +
          'poll `GET /reseller/orders/:orderId` to track progress and get the printer PDF URL when done.\n\n' +
          'Supported music services: Spotify, YouTube Music, Apple Music, Deezer, Tidal.',
        body: {
          type: 'object',
          required: ['playlistUrl', 'design'],
          properties: {
            playlistUrl: {
              type: 'string',
              description: 'Full URL of a playlist from any supported music service (e.g. https://open.spotify.com/playlist/5WxLJfgeVeifVtyX0cIFZY).',
            },
            serviceType: {
              type: 'string',
              enum: ['spotify', 'youtube_music', 'apple_music', 'deezer', 'tidal'],
              description: 'Music service type. Auto-detected from the URL if not provided.',
            },
            design: DesignObject,
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  orderId: { type: 'string', description: 'Unique order ID for tracking.' },
                  status: { type: 'string', enum: ['processing'] },
                },
              },
            },
          },
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request: any, reply: any) => {
      try {
        const { playlistUrl, serviceType, design } = request.body;

        if (!playlistUrl || !design) {
          reply.status(400);
          return { success: false, error: 'Missing required fields: playlistUrl, design' };
        }

        const result = await resellers.createOrder(request.resellerUser, {
          playlistUrl,
          serviceType,
          design,
        });

        if (!result.success) {
          reply.status(400);
        }

        return result;
      } catch (error: any) {
        logger.log(color.red.bold(`[${white.bold('Reseller')}] ${error.message || error}`));
        reply.status(500);
        return { success: false, error: 'Internal server error' };
      }
    }
  );

  // -- GET /reseller/orders/:orderId --
  fastify.get(
    '/reseller/orders/:orderId',
    {
      preHandler: verifyResellerApiKey,
      schema: {
        tags: ['Orders'],
        summary: 'Get order status',
        description:
          'Poll this endpoint to check order progress. Status transitions:\n\n' +
          '- **processing** - PDF is being generated\n' +
          '- **finalizing** - PDF generation almost complete\n' +
          '- **done** - PDF is ready, `pdfUrl` is included\n' +
          '- **failed** - Order failed\n\n' +
          'Recommended polling interval: every 5-10 seconds.',
        params: {
          type: 'object',
          properties: {
            orderId: { type: 'string', description: 'The orderId returned from POST /reseller/orders.' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  orderId: { type: 'string' },
                  status: { type: 'string', enum: ['processing', 'finalizing', 'done', 'failed'] },
                  createdAt: { type: 'string', format: 'date-time' },
                  pdfUrl: {
                    type: 'string',
                    description: 'URL to download the printer-ready PDF. Only present when status is "done".',
                  },
                },
              },
            },
          },
          404: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request: any, reply: any) => {
      try {
        const { orderId } = request.params;

        const result = await resellers.getOrderStatus(
          request.resellerUser.id,
          orderId
        );

        if (!result.success) {
          reply.status(404);
        }

        return result;
      } catch (error: any) {
        logger.log(color.red.bold(`[${white.bold('Reseller')}] ${error.message || error}`));
        reply.status(500);
        return { success: false, error: 'Internal server error' };
      }
    }
  );

  // -- POST /reseller/preview --
  fastify.post(
    '/reseller/preview',
    {
      preHandler: verifyResellerApiKey,
      schema: {
        tags: ['Preview'],
        summary: 'Create a card design preview',
        description:
          'Generate a preview URL to visualize a card design before creating an order. ' +
          'The preview shows the front and back of the card with the specified design settings. ' +
          'Preview URLs expire after 24 hours.',
        body: {
          type: 'object',
          required: ['design'],
          properties: {
            design: DesignObject,
            sampleTrackName: {
              type: 'string',
              default: 'Sample Track',
              description: 'Track name displayed on the back side of the preview card.',
            },
            sampleTrackArtist: {
              type: 'string',
              default: 'Sample Artist',
              description: 'Artist name displayed on the back side of the preview card.',
            },
            sampleTrackYear: {
              type: 'string',
              default: '2025',
              description: 'Year displayed on the back side of the preview card.',
            },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                properties: {
                  previewUrlFront: { type: 'string', description: 'URL to view the front side of the card preview.' },
                  previewUrlBack: { type: 'string', description: 'URL to view the back side of the card preview.' },
                  token: { type: 'string', description: 'Preview token (can also be used with GET /reseller/preview/:token).' },
                },
              },
            },
          },
          400: ErrorResponse,
          401: ErrorResponse,
          403: ErrorResponse,
        },
      },
    },
    async (request: any, reply: any) => {
      try {
        const { design, sampleTrackName, sampleTrackArtist, sampleTrackYear } = request.body;

        if (!design) {
          reply.status(400);
          return { success: false, error: 'Missing required field: design' };
        }

        const result = await resellers.createPreview(request.resellerUser, {
          design,
          sampleTrackName,
          sampleTrackArtist,
          sampleTrackYear,
        });

        if (!result.success) {
          reply.status(400);
        }

        return result;
      } catch (error: any) {
        logger.log(color.red.bold(`[${white.bold('Reseller')}] ${error.message || error}`));
        reply.status(500);
        return { success: false, error: 'Internal server error' };
      }
    }
  );

  // -- GET /reseller/preview/:token (public, no auth) --
  fastify.get(
    '/reseller/preview/:token',
    {
      schema: {
        tags: ['Preview'],
        summary: 'Get preview design data',
        description:
          'Retrieve the design data for a preview. This endpoint is public (no authentication required) ' +
          'and is used by the frontend to render the card preview page. Returns 404 if the token has expired.',
        params: {
          type: 'object',
          properties: {
            token: { type: 'string', description: 'Preview token from POST /reseller/preview.' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'object',
                additionalProperties: true,
                description: 'The resolved design JSON with full image URLs and sample track data.',
              },
            },
          },
          404: ErrorResponse,
        },
        security: [],
      },
    },
    async (request: any, reply: any) => {
      try {
        const { token } = request.params;

        const result = await resellers.getPreview(token);

        if (!result.success) {
          reply.status(404);
        }

        return result;
      } catch (error: any) {
        logger.log(color.red.bold(`[${white.bold('Reseller')}] ${error.message || error}`));
        reply.status(500);
        return { success: false, error: 'Internal server error' };
      }
    }
  );

  // -- GET /reseller/fonts --
  fastify.get(
    '/reseller/fonts',
    {
      preHandler: verifyResellerApiKey,
      schema: {
        tags: ['Fonts'],
        summary: 'List available fonts',
        description:
          'Returns all available fonts that can be used in the `design.selectedFont` field when creating orders. ' +
          'Pass the `googleFontName` value as `design.selectedFont`. Use an empty string for the default font (Arial).',
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    id: { type: 'string', description: 'Value to use in design.selectedFont (empty string = Arial).' },
                    displayName: { type: 'string', description: 'Human-readable font name.' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      reply.header('Cache-Control', 'public, max-age=86400');
      return { success: true, data: FONTS.map((f) => ({ id: f.googleFontName, displayName: f.displayName })) };
    }
  );

  // -- GET /reseller/backgrounds --
  fastify.get(
    '/reseller/backgrounds',
    {
      preHandler: verifyResellerApiKey,
      schema: {
        tags: ['Backgrounds'],
        summary: 'List available preset backgrounds',
        description:
          'Returns all available preset background images that can be used in card designs. ' +
          'Each background includes full URLs to the thumbnail and full-size image, plus a `mediaId` that can be ' +
          'passed directly as `design.background` or `design.backgroundBack` when creating orders.',
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    mediaId: { type: 'integer', description: 'Media ID usable in design.background or design.backgroundBack when creating orders.' },
                    thumbnail: { type: 'string', description: 'Full URL to the thumbnail image (150x150px).' },
                    full: { type: 'string', description: 'Full URL to the background image (1000x1000px).' },
                  },
                },
              },
            },
          },
        },
      },
    },
    async (_request, reply) => {
      reply.header('Cache-Control', 'public, max-age=86400');
      const data = await resellers.getPresetBackgrounds();
      return { success: true, data };
    }
  );
}
