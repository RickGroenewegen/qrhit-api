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

  // Admin: Update a blog post (expects { title_xx, content_xx, summary_xx } for all supported locales)
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
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
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

      console.log(111, instruction);

      const targetLocales: string[] = SUPPORTED_LOCALES;

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
      logger.log(
        color.blue.bold(
          `[AI Blog] Target locales: ${color.white.bold(targetLocales.join(', '))}`
        )
      );

      // 1. Generate the blog in English
      logger.log(
        color.blue.bold(
          '[AI Blog] Step 1/4: Generating blog content in English...'
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

      // 2. Translate the blog to all other locales
      // We'll translate title, summary, and content separately
      const blogData: any = {};
      blogData['title_en'] = aiResultEn.title;
      blogData['content_en'] = aiResultEn.content;
      blogData['summary_en'] = aiResultEn.summary || '';

      // Only translate to non-English locales
      const localesToTranslate = targetLocales.filter((l) => l !== 'en');

      logger.log(
        color.blue.bold(
          `[AI Blog] Step 2/4: Translating blog to ${color.white.bold(
            localesToTranslate.length
          )} locales: ${color.white.bold(localesToTranslate.join(', '))}`
        )
      );

      // Translate title
      logger.log(
        color.blue.bold(
          `[AI Blog] Step 2a/4: Translating title to ${color.white.bold(localesToTranslate.length)} languages...`
        )
      );
      const titleTranslations = await openai.translateText(
        aiResultEn.title,
        localesToTranslate
      );
      logger.log(
        color.green.bold(
          `[AI Blog] ✓ Title translations completed for: ${color.white.bold(Object.keys(
            titleTranslations
          ).join(', '))}`
        )
      );

      // Translate summary
      let summaryTranslations = {};
      if (aiResultEn.summary) {
        logger.log(
          color.blue.bold(
            `[AI Blog] Step 2b/4: Translating summary to ${color.white.bold(localesToTranslate.length)} languages...`
          )
        );
        summaryTranslations = await openai.translateText(
          aiResultEn.summary,
          localesToTranslate
        );
        logger.log(
          color.green.bold(
            `[AI Blog] ✓ Summary translations completed for: ${color.white.bold(Object.keys(
              summaryTranslations
            ).join(', '))}`
          )
        );
      } else {
        logger.log(
          color.yellow.bold(
            '[AI Blog] Step 2b/4: Skipping summary translation (no summary provided)'
          )
        );
      }

      // Translate content (markdown)
      logger.log(
        color.blue.bold(
          `[AI Blog] Step 2c/4: Translating content (${color.white.bold(aiResultEn.content.length)} chars) to ${color.white.bold(localesToTranslate.length)} languages...`
        )
      );
      const contentTranslations = await openai.translateText(
        aiResultEn.content,
        localesToTranslate
      );
      logger.log(
        color.green.bold(
          `[AI Blog] ✓ Content translations completed for: ${color.white.bold(Object.keys(
            contentTranslations
          ).join(', '))}`
        )
      );

      logger.log(
        color.blue.bold(
          '[AI Blog] Step 3/4: Assembling blog data with all translations...'
        )
      );
      for (const locale of localesToTranslate) {
        blogData[`title_${locale}`] = titleTranslations[locale] || '';
        blogData[`content_${locale}`] = contentTranslations[locale] || '';
        blogData[`summary_${locale}`] =
          (summaryTranslations as any)[locale] || '';

        logger.log(
          color.blue.bold(
            `[AI Blog] - ${color.white.bold(locale.toUpperCase())}: Title="${color.white.bold((
              titleTranslations[locale] || ''
            ).substring(0, 50))}..."`
          )
        );
      }

      logger.log(
        color.blue.bold('[AI Blog] Step 4/4: Saving blog to database...')
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
        logger.log(
          color.blue.bold(
            `[AI Blog] - Languages: ${color.white.bold(targetLocales.length)} (${color.white.bold(targetLocales.join(
              ', '
            ))})`
          )
        );
        logger.log(color.blue.bold(`[AI Blog] - English title: "${color.white.bold(aiResultEn.title)}"`));
        logger.log(
          color.blue.bold(
            `[AI Blog] - Content length: ${color.white.bold(aiResultEn.content.length)} characters`
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
