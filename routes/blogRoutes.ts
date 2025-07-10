import { FastifyInstance } from 'fastify';
import Blog from '../src/blog';
import { ChatGPT } from '../src/chatgpt';

export default async function blogRoutes(fastify: FastifyInstance) {
  const blog = Blog.getInstance();
  const openai = new ChatGPT();

  // Admin: Create a blog post (expects { title, content (markdown), summary })
  fastify.post(
    '/admin/blogs',
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
    async (request: any, reply: any) => {
      const { title, content, summary } = request.body;
      if (!title || !content) {
        reply.status(400).send({ success: false, error: 'Missing title or content' });
        return;
      }
      const result = await blog.createBlog({ title, content, summary });
      reply.send(result);
    }
  );

  // Admin: Update a blog post (expects { title, content, summary })
  fastify.put(
    '/admin/blogs/:id',
    { preHandler: fastify.authenticate && fastify.authenticate(['admin']) },
    async (request: any, reply: any) => {
      const id = parseInt(request.params.id);
      const { title, content, summary } = request.body;
      if (isNaN(id)) {
        reply.status(400).send({ success: false, error: 'Invalid blog id' });
        return;
      }
      const result = await blog.updateBlog(id, { title, content, summary });
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
      if (!instruction) {
        reply.status(400).send({ success: false, error: 'Missing instruction' });
        return;
      }
      // Use OpenAI function calling to generate markdown blog post
      const aiResult = await openai.askBlog(instruction);
      if (!aiResult || !aiResult.title || !aiResult.content) {
        reply.status(500).send({ success: false, error: 'AI failed to generate blog' });
        return;
      }
      // Save the generated blog
      const result = await blog.createBlog({
        title: aiResult.title,
        content: aiResult.content,
        summary: aiResult.summary || '',
      });
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
