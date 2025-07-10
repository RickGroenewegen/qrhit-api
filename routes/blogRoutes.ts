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
      // No required fields, but at least one language should be present
      const hasAnyLocale = Object.keys(request.body).some(
        (k) => k.startsWith('title_') || k.startsWith('content_')
      );
      if (!hasAnyLocale) {
        reply
          .status(400)
          .send({
            success: false,
            error: 'Missing blog content for any language',
          });
        return;
      }
      const result = await blog.createBlog(request.body);
      reply.send(result);
    }
  );

  // Admin: Get all blogs (includes inactive blogs)
  fastify.get(
    '/admin/blogs',
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
    async (_request: any, reply: any) => {
      const result = await blog.getAllBlogsAdmin();
      reply.send(result);
    }
  );

  // Admin: Get a single blog by id (includes inactive blogs)
  fastify.get(
    '/admin/blogs/:id',
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid blog id' });
        return;
      }
      const result = await blog.getBlogByIdAdmin(id);
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
      }
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
      const { instruction } = request.body;

      if (!instruction) {
        reply
          .status(400)
          .send({ success: false, error: 'Missing instruction' });
        return;
      }

      logger.log(
        color.blue.bold(
          `[AI Blog] Starting blog generation for instruction: "${color.white.bold(instruction)}"`
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
        reply
          .status(500)
          .send({
            success: false,
            error: `AI failed to generate blog in English`,
          });
        return;
      }
      logger.log(color.green.bold(`[AI Blog] ✓ English blog generated successfully`));
      logger.log(color.blue.bold(`[AI Blog] - Title: "${color.white.bold(aiResultEn.title)}"`));
      logger.log(
        color.blue.bold(
          `[AI Blog] - Content length: ${color.white.bold(aiResultEn.content.length)} characters`
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
        color.blue.bold('[AI Blog] Step 2/2: Saving English blog to database...')
      );

      // Save the generated blog
      const result = await blog.createBlog(blogData);

      if (result.success && result.blog) {
        logger.log(
          color.green.bold(
            `[AI Blog] ✓ Blog created successfully with ID: ${color.white.bold(result.blog.id)}`
          )
        );
        logger.log(
          color.green.bold(
            `[AI Blog] ✓ Blog generation process completed successfully`
          )
        );
        logger.log(color.blue.bold(`[AI Blog] Summary:`));
        logger.log(color.blue.bold(`[AI Blog] - Blog ID: ${color.white.bold(result.blog.id)}`));
        logger.log(color.blue.bold(`[AI Blog] - English title: "${color.white.bold(aiResultEn.title)}"`));
        logger.log(
          color.blue.bold(
            `[AI Blog] - Content length: ${color.white.bold(aiResultEn.content.length)} characters`
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
            `[AI Blog] ✗ Failed to create blog in database: ${color.white.bold(result.error)}`
          )
        );
      }

      reply.send(result);
    }
  );

  // Admin: Generate a blog post using AI with streaming (expects { instruction })
  fastify.post(
    '/admin/blogs/generate-stream',
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
    async (request: any, reply: any) => {
      const { instruction } = request.body;

      if (!instruction) {
        reply
          .status(400)
          .send({ success: false, error: 'Missing instruction' });
        return;
      }

      logger.log(
        color.blue.bold(
          `[AI Blog Stream] Starting streaming blog generation for instruction: "${color.white.bold(instruction)}"`
        )
      );

      // Set up Server-Sent Events
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Cache-Control'
      });

      const sendEvent = (event: string, data: any) => {
        reply.raw.write(`event: ${event}\n`);
        reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
      };

      try {
        sendEvent('status', { message: 'Starting AI blog generation...', step: 1, total: 2 });

        logger.log(
          color.blue.bold(
            '[AI Blog Stream] Step 1/2: Generating blog content in English...'
          )
        );

        // Generate the blog with streaming
        const aiResultEn = await openai.askBlogStream(instruction, (chunk: string) => {
          sendEvent('chunk', { content: chunk });
        });

        if (!aiResultEn || !aiResultEn.title || !aiResultEn.content) {
          logger.log(
            color.red.bold(
              '[AI Blog Stream] ERROR: AI failed to generate blog in English'
            )
          );
          sendEvent('error', { error: 'AI failed to generate blog in English' });
          reply.raw.end();
          return;
        }

        logger.log(color.green.bold(`[AI Blog Stream] ✓ English blog generated successfully`));
        logger.log(color.blue.bold(`[AI Blog Stream] - Title: "${color.white.bold(aiResultEn.title)}"`));
        logger.log(
          color.blue.bold(
            `[AI Blog Stream] - Content length: ${color.white.bold(aiResultEn.content.length)} characters`
          )
        );

        sendEvent('status', { message: 'Saving blog to database...', step: 2, total: 2 });

        // Create blog data with only English content
        const blogData: any = {};
        blogData['title_en'] = aiResultEn.title;
        blogData['content_en'] = aiResultEn.content;
        blogData['summary_en'] = aiResultEn.summary || '';

        logger.log(
          color.blue.bold('[AI Blog Stream] Step 2/2: Saving English blog to database...')
        );

        // Save the generated blog
        const result = await blog.createBlog(blogData);

        if (result.success && result.blog) {
          logger.log(
            color.green.bold(
              `[AI Blog Stream] ✓ Blog created successfully with ID: ${color.white.bold(result.blog.id)}`
            )
          );

          sendEvent('complete', {
            success: true,
            blog: result.blog,
            title: aiResultEn.title,
            contentLength: aiResultEn.content.length,
            summary: aiResultEn.summary,
            message: `Blog created successfully with ID: ${result.blog.id}`
          });
        } else {
          logger.log(
            color.red.bold(
              `[AI Blog Stream] ✗ Failed to create blog in database: ${color.white.bold(result.error)}`
            )
          );
          sendEvent('error', { error: `Failed to create blog in database: ${result.error}` });
        }

      } catch (error) {
        logger.log(
          color.red.bold(
            `[AI Blog Stream] ✗ Error during streaming generation: ${color.white.bold((error as Error).message)}`
          )
        );
        sendEvent('error', { error: (error as Error).message });
      }

      reply.raw.end();
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
      const locales = targetLocales || SUPPORTED_LOCALES.filter((l) => l !== 'en');

      logger.log(
        color.blue.bold(
          `[AI Blog Translate] Starting translation for blog ID: ${color.white.bold(id)}`
        )
      );
      logger.log(
        color.blue.bold(
          `[AI Blog Translate] Target locales: ${color.white.bold(locales.join(', '))}`
        )
      );

      // Get the existing blog (use admin method to access inactive blogs)
      const existingBlog = await blog.getBlogByIdAdmin(id);
      if (!existingBlog.success || !existingBlog.blog) {
        reply.status(404).send({ success: false, error: 'Blog not found' });
        return;
      }

      const blogData = existingBlog.blog;
      const englishTitle = blogData.title_en as string;
      const englishContent = blogData.content_en as string;
      const englishSummary = blogData.summary_en as string | null;

      if (!englishTitle || !englishContent) {
        reply.status(400).send({ 
          success: false, 
          error: 'Blog must have English title and content to translate' 
        });
        return;
      }

      logger.log(
        color.blue.bold(
          `[AI Blog Translate] Step 1/4: Translating title to ${color.white.bold(locales.length)} languages...`
        )
      );
      const titleTranslations = await openai.translateText(englishTitle, locales);
      logger.log(
        color.green.bold(
          `[AI Blog Translate] ✓ Title translations completed for: ${color.white.bold(Object.keys(
            titleTranslations
          ).join(', '))}`
        )
      );

      // Translate summary if it exists
      let summaryTranslations = {};
      if (englishSummary && englishSummary.trim()) {
        logger.log(
          color.blue.bold(
            `[AI Blog Translate] Step 2/4: Translating summary to ${color.white.bold(locales.length)} languages...`
          )
        );
        summaryTranslations = await openai.translateText(englishSummary, locales);
        logger.log(
          color.green.bold(
            `[AI Blog Translate] ✓ Summary translations completed for: ${color.white.bold(Object.keys(
              summaryTranslations
            ).join(', '))}`
          )
        );
      } else {
        logger.log(
          color.yellow.bold(
            '[AI Blog Translate] Step 2/4: Skipping summary translation (no summary provided)'
          )
        );
      }

      // Translate content
      logger.log(
        color.blue.bold(
          `[AI Blog Translate] Step 3/4: Translating content (${color.white.bold(englishContent.length)} chars) to ${color.white.bold(locales.length)} languages...`
        )
      );
      const contentTranslations = await openai.translateText(englishContent, locales);
      logger.log(
        color.green.bold(
          `[AI Blog Translate] ✓ Content translations completed for: ${color.white.bold(Object.keys(
            contentTranslations
          ).join(', '))}`
        )
      );

      // Prepare update data
      logger.log(
        color.blue.bold(
          '[AI Blog Translate] Step 4/4: Updating blog with translations...'
        )
      );
      const updateData: any = {};
      for (const locale of locales) {
        updateData[`title_${locale}`] = titleTranslations[locale] || '';
        updateData[`content_${locale}`] = contentTranslations[locale] || '';
        updateData[`summary_${locale}`] = (summaryTranslations as any)[locale] || '';

        logger.log(
          color.blue.bold(
            `[AI Blog Translate] - ${color.white.bold(locale.toUpperCase())}: Title="${color.white.bold((
              titleTranslations[locale] || ''
            ).substring(0, 50))}..."`
          )
        );
      }

      // Update the blog
      const result = await blog.updateBlog(id, updateData);

      if (result.success) {
        logger.log(
          color.green.bold(
            `[AI Blog Translate] ✓ Blog translations updated successfully for ID: ${color.white.bold(id)}`
          )
        );
        logger.log(
          color.green.bold(
            `[AI Blog Translate] ✓ Translation process completed successfully`
          )
        );
        logger.log(color.blue.bold(`[AI Blog Translate] Summary:`));
        logger.log(color.blue.bold(`[AI Blog Translate] - Blog ID: ${color.white.bold(id)}`));
        logger.log(
          color.blue.bold(
            `[AI Blog Translate] - Languages translated: ${color.white.bold(locales.length)} (${color.white.bold(locales.join(', '))})`
          )
        );
      } else {
        logger.log(
          color.red.bold(
            `[AI Blog Translate] ✗ Failed to update blog translations: ${color.white.bold(result.error)}`
          )
        );
      }

      reply.send(result);
    }
  );

  // Public: Get all blogs
  fastify.get('/blogs', async (_request: any, reply: any) => {
    const result = await blog.getAllBlogs();
    reply.send(result);
  });

  // Public: Get a single blog by id
  fastify.get('/blogs/:id', async (request: any, reply: any) => {
    const id = parseInt(request.params.id);
    if (isNaN(id)) {
      reply.status(400).send({ success: false, error: 'Invalid blog id' });
      return;
    }
    const result = await blog.getBlogById(id);
    reply.send(result);
  });
}
