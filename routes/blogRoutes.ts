import { FastifyInstance } from 'fastify';
import Blog from '../src/blog';
import { ChatGPT } from '../src/chatgpt';
import Translation from '../src/translation';
import Logger from '../src/logger';
import { color } from 'console-log-colors';

export default async function blogRoutes(fastify: FastifyInstance) {
  const blog = Blog.getInstance();
  const openai = new ChatGPT();
  const logger = new Logger();
  const SUPPORTED_LOCALES = new Translation().allLocales;

  // Admin: Create a blog post (expects { title_xx, content_xx, summary_xx } for all supported locales)
  fastify.post(
    '/admin/blogs',
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
    async (request: any, reply: any) => {
      if (!request.body.title_en) {
        reply.status(400).send({
          success: false,
          error: 'English title (title_en) is required',
        });
        return;
      }
      const result = await blog.createBlog(request.body);
      reply.send(result);
    }
  );

  // Admin: Get all blogs (defaults to English, includes inactive blogs)
  fastify.get(
    '/admin/blogs',
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
    async (request: any, reply: any) => {
      const result = await blog.getAllBlogsAdmin('en');
      reply.send(result);
    }
  );

  // Admin: Get a single blog by id (defaults to English, includes inactive blogs)
  fastify.get(
    '/admin/blogs/:id',
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid blog id' });
        return;
      }
      const result = await blog.getBlogByIdAdmin(id, 'en');
      reply.send(result);
    }
  );

  // Admin: Get a single blog by id for a specific locale (includes inactive blogs)
  fastify.get(
    '/admin/blogs/:locale/:id',
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid blog id' });
        return;
      }
      const { locale } = request.params;
      const result = await blog.getBlogByIdAdmin(id, locale);
      reply.send(result);
    }
  );

  // Admin: Update a blog post (expects { title_xx, content_xx, summary_xx, active } for all supported locales)
  fastify.put(
    '/admin/blogs/:id',
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid blog id' });
        return;
      }
      const result = await blog.updateBlog(id, request.body);
      reply.send(result);
    }
  );

  // Admin: Delete a blog post
  fastify.delete(
    '/admin/blogs/:id',
    {
      preHandler: fastify.authenticate && fastify.authenticate(['admin']),
      preValidation: async (request: any, reply: any) => {
        // Skip body parsing for DELETE requests
        request.body = undefined;
      },
    },
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid blog id' });
        return;
      }
      const result = await blog.deleteBlog(id);
      reply.send(result);
    }
  );

  // Admin: Generate a blog post using AI (expects { instruction })
  fastify.post(
    '/admin/blogs/generate',
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
    async (request: any, reply: any) => {
      const { instruction, instructions_image } = request.body;

      if (!instruction) {
        reply
          .status(400)
          .send({ success: false, error: 'Missing instruction' });
        return;
      }

      logger.log(
        color.blue.bold(
          `[AI Blog] Starting blog generation for instruction: "${color.white.bold(
            instruction
          )}"`
        )
      );

      // 1. Generate the blog in English
      logger.log(
        color.blue.bold(
          '[AI Blog] Step 1/2: Generating blog content in English...'
        )
      );
      const aiResultEn = await openai.askBlog(instruction);
      if (!aiResultEn || !aiResultEn.title || !aiResultEn.content) {
        logger.log(
          color.red.bold(
            '[AI Blog] ERROR: AI failed to generate blog in English'
          )
        );
        reply.status(500).send({
          success: false,
          error: `AI failed to generate blog in English`,
        });
        return;
      }
      logger.log(
        color.green.bold(`[AI Blog] ✓ English blog generated successfully`)
      );
      logger.log(
        color.blue.bold(
          `[AI Blog] - Title: "${color.white.bold(aiResultEn.title)}"`
        )
      );
      logger.log(
        color.blue.bold(
          `[AI Blog] - Content length: ${color.white.bold(
            aiResultEn.content.length
          )} characters`
        )
      );
      logger.log(
        color.blue.bold(
          `[AI Blog] - Summary: ${
            aiResultEn.summary
              ? `"${color.white.bold(aiResultEn.summary.substring(0, 100))}..."`
              : color.yellow.bold('None')
          }`
        )
      );

      // 2. Create blog data with only English content
      const blogData: any = {};
      blogData['title_en'] = aiResultEn.title;
      blogData['content_en'] = aiResultEn.content;
      blogData['summary_en'] = aiResultEn.summary || '';

      logger.log(
        color.blue.bold(
          '[AI Blog] Step 2/2: Saving English blog to database...'
        )
      );

      // Generate blog image if instructions_image is provided
      if (instructions_image) {
        logger.log(color.blue.bold('[AI Blog] Generating blog image...'));
        const imageFilename = await openai.generateBlogImage(
          instructions_image
        );

        if (imageFilename) {
          blogData.image = imageFilename;
          blogData.image_instructions = instructions_image;
          logger.log(
            color.green.bold(
              `[AI Blog] ✓ Blog image generated: ${color.white.bold(
                imageFilename
              )}`
            )
          );
        } else {
          logger.log(
            color.yellow.bold('[AI Blog] ⚠ Failed to generate blog image')
          );
        }
      } else {
        logger.log(
          color.yellow.bold('[AI Blog] No image instructions provided, skipping image generation')
        );
      }

      // Save the generated blog
      const result = await blog.createBlog(blogData);

      if (result.success && result.blog) {
        logger.log(
          color.green.bold(
            `[AI Blog] ✓ Blog created successfully with ID: ${color.white.bold(
              result.blog.id
            )}`
          )
        );
        logger.log(
          color.green.bold(
            `[AI Blog] ✓ Blog generation process completed successfully`
          )
        );
        logger.log(color.blue.bold(`[AI Blog] Summary:`));
        logger.log(
          color.blue.bold(
            `[AI Blog] - Blog ID: ${color.white.bold(result.blog.id)}`
          )
        );
        logger.log(
          color.blue.bold(
            `[AI Blog] - English title: "${color.white.bold(aiResultEn.title)}"`
          )
        );
        logger.log(
          color.blue.bold(
            `[AI Blog] - Content length: ${color.white.bold(
              aiResultEn.content.length
            )} characters`
          )
        );
        logger.log(
          color.yellow.bold(
            `[AI Blog] Note: Use /admin/blogs/${result.blog.id}/translate to translate to other languages`
          )
        );
      } else {
        logger.log(
          color.red.bold(
            `[AI Blog] ✗ Failed to create blog in database: ${color.white.bold(
              result.error
            )}`
          )
        );
      }

      reply.send(result);
    }
  );

  // Admin: Translate a blog post to other languages
  fastify.post(
    '/admin/blogs/:id/translate',
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid blog id' });
        return;
      }

      const { targetLocales } = request.body;
      const locales =
        targetLocales || SUPPORTED_LOCALES.filter((l) => l !== 'en');

      logger.log(
        color.blue.bold(
          `[AI Blog Translate] Starting translation for blog ID: ${color.white.bold(
            id
          )}`
        )
      );
      logger.log(
        color.blue.bold(
          `[AI Blog Translate] Target locales: ${color.white.bold(
            locales.join(', ')
          )}`
        )
      );

      // Get the existing blog (use admin method to access inactive blogs) - use English for translation source
      const existingBlog = await blog.getBlogByIdAdmin(id, 'en');
      if (!existingBlog.success || !existingBlog.blog) {
        reply.status(404).send({ success: false, error: 'Blog not found' });
        return;
      }

      const blogData = existingBlog.blog;
      const englishTitle = blogData.title as string;
      const englishContent = blogData.content as string;
      const englishSummary = blogData.summary as string | null;

      if (!englishTitle || !englishContent) {
        reply.status(400).send({
          success: false,
          error: 'Blog must have English title and content to translate',
        });
        return;
      }

      // Translate each language one at a time with progress updates
      const titleTranslations: Record<string, string> = {};
      const summaryTranslations: Record<string, string> = {};
      const contentTranslations: Record<string, string> = {};

      for (let i = 0; i < locales.length; i++) {
        const locale = locales[i];
        const progress = `${i + 1}/${locales.length}`;

        logger.log(
          color.blue.bold(
            `[AI Blog Translate] Step ${progress}: Translating to ${color.white.bold(
              locale.toUpperCase()
            )}...`
          )
        );

        // Translate title
        logger.log(
          color.blue.bold(
            `[AI Blog Translate] ${progress} - Translating title to ${color.white.bold(
              locale
            )}...`
          )
        );
        const titleResult = await openai.translateText(englishTitle, [locale]);
        titleTranslations[locale] = titleResult[locale] || '';
        logger.log(
          color.green.bold(
            `[AI Blog Translate] ${progress} - ✓ Title translated to ${color.white.bold(
              locale
            )}`
          )
        );

        // Translate summary if it exists
        if (englishSummary && englishSummary.trim()) {
          logger.log(
            color.blue.bold(
              `[AI Blog Translate] ${progress} - Translating summary to ${color.white.bold(
                locale
              )}...`
            )
          );
          const summaryResult = await openai.translateText(englishSummary, [
            locale,
          ]);
          summaryTranslations[locale] = summaryResult[locale] || '';
          logger.log(
            color.green.bold(
              `[AI Blog Translate] ${progress} - ✓ Summary translated to ${color.white.bold(
                locale
              )}`
            )
          );
        }

        // Translate content
        logger.log(
          color.blue.bold(
            `[AI Blog Translate] ${progress} - Translating content (${color.white.bold(
              englishContent.length
            )} chars) to ${color.white.bold(locale)}...`
          )
        );
        const contentResult = await openai.translateText(englishContent, [
          locale,
        ]);
        contentTranslations[locale] = contentResult[locale] || '';
        logger.log(
          color.green.bold(
            `[AI Blog Translate] ${progress} - ✓ Content translated to ${color.white.bold(
              locale
            )}`
          )
        );

        logger.log(
          color.green.bold(
            `[AI Blog Translate] ${progress} - ✓ Completed ${color.white.bold(
              locale.toUpperCase()
            )} translation`
          )
        );
      }

      // Prepare update data
      logger.log(
        color.blue.bold(
          '[AI Blog Translate] Final step: Updating blog with all translations...'
        )
      );
      const updateData: any = {};
      for (const locale of locales) {
        updateData[`title_${locale}`] = titleTranslations[locale] || '';
        updateData[`content_${locale}`] = contentTranslations[locale] || '';
        updateData[`summary_${locale}`] =
          (summaryTranslations as any)[locale] || '';

        logger.log(
          color.blue.bold(
            `[AI Blog Translate] - ${color.white.bold(
              locale.toUpperCase()
            )}: Title="${color.white.bold(
              (titleTranslations[locale] || '').substring(0, 50)
            )}..."`
          )
        );
      }

      // Update the blog
      const result = await blog.updateBlog(id, updateData);

      if (result.success) {
        logger.log(
          color.green.bold(
            `[AI Blog Translate] ✓ Blog translations updated successfully for ID: ${color.white.bold(
              id
            )}`
          )
        );
        logger.log(
          color.green.bold(
            `[AI Blog Translate] ✓ Translation process completed successfully`
          )
        );
        logger.log(color.blue.bold(`[AI Blog Translate] Summary:`));
        logger.log(
          color.blue.bold(
            `[AI Blog Translate] - Blog ID: ${color.white.bold(id)}`
          )
        );
        logger.log(
          color.blue.bold(
            `[AI Blog Translate] - Languages translated: ${color.white.bold(
              locales.length
            )} (${color.white.bold(locales.join(', '))})`
          )
        );
      } else {
        logger.log(
          color.red.bold(
            `[AI Blog Translate] ✗ Failed to update blog translations: ${color.white.bold(
              result.error
            )}`
          )
        );
      }

      reply.send(result);
    }
  );

  // Admin: Refresh blog image
  fastify.post(
    '/admin/blogs/:id/refresh-image',
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid blog id' });
        return;
      }

      logger.log(
        color.blue.bold(
          `[AI Blog Image] Starting image refresh for blog ID: ${color.white.bold(
            id
          )}`
        )
      );

      // Get the existing blog (use admin method to access inactive blogs) - use English for image generation context
      const existingBlog = await blog.getBlogByIdAdmin(id, 'en');
      if (!existingBlog.success || !existingBlog.blog) {
        reply.status(404).send({ success: false, error: 'Blog not found' });
        return;
      }

      const blogData = existingBlog.blog;
      const imageInstructions = blogData.image_instructions as string;

      if (!imageInstructions) {
        reply.status(400).send({
          success: false,
          error: 'Blog must have image_instructions to refresh image',
        });
        return;
      }

      // Generate blog image using instructions from database
      logger.log(
        color.blue.bold('[AI Blog Image] Generating new blog image using stored instructions...')
      );
      logger.log(
        color.blue.bold(`[AI Blog Image] Instructions: "${color.white.bold(imageInstructions)}"`)
      );
      const imageFilename = await openai.generateBlogImage(
        imageInstructions
      );

      if (imageFilename) {
        logger.log(
          color.green.bold(
            `[AI Blog Image] ✓ New blog image generated: ${color.white.bold(
              imageFilename
            )}`
          )
        );
        // Save the new image to the blog
        const result = await blog.updateBlog(id, { image: imageFilename });
        if (result.success) {
          logger.log(
            color.green.bold(
              `[AI Blog Image] ✓ Blog image updated successfully for ID: ${color.white.bold(
                id
              )}`
            )
          );
        } else {
          logger.log(
            color.red.bold(
              `[AI Blog Image] ✗ Failed to update blog with new image: ${color.white.bold(
                result.error
              )}`
            )
          );
        }
        reply.send(result);
      } else {
        logger.log(
          color.yellow.bold('[AI Blog Image] ⚠ Failed to generate blog image')
        );
        reply.status(500).send({
          success: false,
          error: 'Failed to generate new blog image',
        });
      }
    }
  );

  // Public: Get all blogs for a specific locale
  fastify.get('/blogs/:locale', async (request: any, reply: any) => {
    const { locale } = request.params;
    const result = await blog.getAllBlogs(locale);
    reply.send(result);
  });

  // Public: Get a single blog by slug for a specific locale
  fastify.get('/blogs/:locale/:slug', async (request: any, reply: any) => {
    const { locale, slug } = request.params;
    const result = await blog.getBlogBySlug(slug, locale);
    reply.send(result);
  });
}
