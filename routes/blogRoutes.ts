import { FastifyInstance } from 'fastify';
import Blog from '../src/blog';
import { ChatGPT } from '../src/chatgpt';
import Translation from '../src/translation';

export default async function blogRoutes(fastify: FastifyInstance) {
  const blog = Blog.getInstance();
  const openai = new ChatGPT();
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
        reply.status(400).send({ success: false, error: 'Missing blog content for any language' });
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

  // Admin: Generate a blog post using AI (expects { instruction, locales?: string[] })
  fastify.post(
    '/admin/blogs/generate',
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
    async (request: any, reply: any) => {
      const { instruction, locales } = request.body;
      const targetLocales: string[] = Array.isArray(locales) && locales.length > 0
        ? locales.filter((l: string) => SUPPORTED_LOCALES.includes(l))
        : SUPPORTED_LOCALES;

      if (!instruction) {
        reply.status(400).send({ success: false, error: 'Missing instruction' });
        return;
      }

      // 1. Generate the blog in English
      const aiResultEn = await openai.askBlog(instruction);
      if (!aiResultEn || !aiResultEn.title || !aiResultEn.content) {
        reply.status(500).send({ success: false, error: `AI failed to generate blog in English` });
        return;
      }

      // 2. Translate the blog to all other locales
      // We'll translate title, summary, and content separately
      const blogData: any = {};
      blogData['title_en'] = aiResultEn.title;
      blogData['content_en'] = aiResultEn.content;
      blogData['summary_en'] = aiResultEn.summary || '';

      // Only translate to non-English locales
      const localesToTranslate = targetLocales.filter((l) => l !== 'en');

      // Translate title
      const titleTranslations = await openai.translateText(aiResultEn.title, localesToTranslate);
      // Translate summary
      const summaryTranslations = aiResultEn.summary
        ? await openai.translateText(aiResultEn.summary, localesToTranslate)
        : {};
      // Translate content (markdown)
      const contentTranslations = await openai.translateText(aiResultEn.content, localesToTranslate);

      for (const locale of localesToTranslate) {
        blogData[`title_${locale}`] = titleTranslations[locale] || '';
        blogData[`content_${locale}`] = contentTranslations[locale] || '';
        blogData[`summary_${locale}`] = summaryTranslations[locale] || '';
      }

      // Save the generated blog
      const result = await blog.createBlog(blogData);
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
