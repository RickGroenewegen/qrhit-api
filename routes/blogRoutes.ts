import { FastifyInstance } from 'fastify';
import Blog from '../src/blog';

/**
 * Public blog routes.
 *
 * The admin half of this file is gone. Posts used to be created, edited,
 * translated and illustrated through `/admin/blogs*` endpoints backed by a
 * 60-column table; they are now markdown files in `src/_data/blog`, authored
 * through the growth-oracle blog pillar (`growth blog …`) and shipped with the
 * deploy. There is nothing left to write at runtime, so there is nothing left
 * to authenticate.
 *
 * Removed with it: the ChatGPT translation calls, the sharp image pipeline and
 * the image-upload endpoints. Image generation is an authoring-time concern now
 * and lives with the rest of the authoring tools.
 */
export default async function blogRoutes(fastify: FastifyInstance) {
  const blog = Blog.getInstance();

  // Public: every post that exists in this locale, newest first.
  fastify.get('/blogs/:locale', async (request: any, reply: any) => {
    const { locale } = request.params;
    const result = await blog.getAllBlogs(locale);
    reply.send(result);
  });

  // Public: one post by its slug in this locale.
  fastify.get('/blogs/:locale/:slug', async (request: any, reply: any) => {
    const { locale, slug } = request.params;
    const result = await blog.getBlogBySlug(slug, locale);
    reply.send(result);
  });
}
