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

      // Generate blog for each locale
      const blogData: any = {};
      for (const locale of targetLocales) {
        // Pass instruction + locale to AI
        const aiResult = await openai.askBlog(
          `${instruction}\n\nWrite the blog in ${locale} language.`
        );
        if (!aiResult || !aiResult.title || !aiResult.content) {
          reply.status(500).send({ success: false, error: `AI failed to generate blog for ${locale}` });
          return;
        }
        blogData[`title_${locale}`] = aiResult.title;
        blogData[`content_${locale}`] = aiResult.content;
        blogData[`summary_${locale}`] = aiResult.summary || '';
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
