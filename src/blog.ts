import PrismaInstance from './prisma';
import Translation from './translation';
import Cache from './cache';

const CACHE_PREFIX = 'blog2';
const SUPPORTED_LOCALES = Translation.ALL_LOCALES;

type BlogInput = {
  [key: string]: any;
};

class Blog {
  private static instance: Blog;
  private prisma = PrismaInstance.getInstance();
  private cache = Cache.getInstance();

  public static getInstance(): Blog {
    if (!Blog.instance) {
      Blog.instance = new Blog();
    }
    return Blog.instance;
  }

  // Get all blogs for admin (includes inactive blogs)
  public async getAllBlogsAdmin(locale: string) {
    try {
      // Validate locale
      if (!SUPPORTED_LOCALES.includes(locale)) {
        return { success: false, error: 'Invalid locale' };
      }

      const blogs = await this.prisma.blog.findMany({
        orderBy: { createdAt: 'desc' },
        select: this.getSelectObject(),
      });

      // Transform blogs to include localized content
      const localizedBlogs = blogs.map((blog) =>
        this.transformBlogForLocale(blog, locale)
      );

      return { success: true, blogs: localizedBlogs };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // Get a single blog by id for admin (includes inactive blogs)
  public async getBlogByIdAdmin(id: number, locale: string) {
    try {
      // Validate locale
      if (!SUPPORTED_LOCALES.includes(locale)) {
        return { success: false, error: 'Invalid locale' };
      }

      const blog = await this.prisma.blog.findUnique({
        where: { id },
        select: this.getSelectObject(true),
      });
      if (!blog) {
        return { success: false, error: 'Blog not found' };
      }

      // Transform blog to include localized content (admin can see inactive blogs)
      const localizedBlog = this.transformBlogForLocale(blog, locale);

      return { success: true, blog: localizedBlog };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // Create a new blog post (expects keys like title_en, content_en, summary_en, etc.)
  public async createBlog(input: BlogInput) {
    try {
      if (!input.title_en) {
        return {
          success: false,
          error: 'English title (title_en) is required',
        };
      }

      const data: any = {};

      // Create and ensure unique slugs for each locale
      for (const locale of SUPPORTED_LOCALES) {
        const title = input[`title_${locale}`];
        if (title) {
          const baseSlug = this.slugify(title);
          let slug = baseSlug;
          let counter = 1;
          while (
            await this.prisma.blog.findFirst({
              where: { [`slug_${locale}`]: slug },
            })
          ) {
            slug = `${baseSlug}-${counter}`;
            counter++;
          }
          data[`slug_${locale}`] = slug;
        }
      }

      data.active = input.active !== undefined ? input.active : false;
      if (input.image) {
        data.image = input.image;
      }
      if (input.image_instructions) {
        data.image_instructions = input.image_instructions;
      }
      for (const locale of SUPPORTED_LOCALES) {
        data[`title_${locale}`] = input[`title_${locale}`] || '';
        data[`content_${locale}`] = input[`content_${locale}`] || '';
        data[`summary_${locale}`] = input[`summary_${locale}`] || '';
      }
      const blog = await this.prisma.blog.create({ data });

      // Clear blog caches after creating a new blog
      await this.clearBlogCaches();

      return { success: true, blog };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // Update an existing blog post
  public async updateBlog(id: number, input: BlogInput) {
    try {
      const data: any = {};
      if (input.hasOwnProperty('active')) {
        data.active = input.active;
      }
      if (input.hasOwnProperty('image')) {
        data.image = input.image;
      }
      if (input.hasOwnProperty('image_instructions')) {
        data.image_instructions = input.image_instructions;
      }

      // Handle slug updates for each locale
      for (const locale of SUPPORTED_LOCALES) {
        if (input.hasOwnProperty(`title_${locale}`)) {
          data[`title_${locale}`] = input[`title_${locale}`];

          // Update slug if title changed
          const title = input[`title_${locale}`];
          if (title) {
            const baseSlug = this.slugify(title);
            let slug = baseSlug;
            let counter = 1;
            while (
              await this.prisma.blog.findFirst({
                where: {
                  [`slug_${locale}`]: slug,
                  id: { not: id }, // Exclude current blog from check
                },
              })
            ) {
              slug = `${baseSlug}-${counter}`;
              counter++;
            }
            data[`slug_${locale}`] = slug;
          }
        }
        if (input.hasOwnProperty(`content_${locale}`)) {
          data[`content_${locale}`] = input[`content_${locale}`];
        }
        if (input.hasOwnProperty(`summary_${locale}`)) {
          data[`summary_${locale}`] = input[`summary_${locale}`];
        }
      }
      const blog = await this.prisma.blog.update({
        where: { id },
        data,
      });

      // Clear blog caches after updating a blog
      await this.clearBlogCaches();

      return { success: true, blog };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // Delete a blog post
  public async deleteBlog(id: number) {
    try {
      await this.prisma.blog.delete({ where: { id } });

      // Clear blog caches after deleting a blog
      await this.clearBlogCaches();

      return { success: true };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // Get all blogs (public)
  public async getAllBlogs(locale: string) {
    try {
      // Validate locale
      if (!SUPPORTED_LOCALES.includes(locale)) {
        return { success: false, error: 'Invalid locale' };
      }

      // Check cache first
      const cacheKey = `${CACHE_PREFIX}s:all:${locale}`;
      const cachedBlogs = await this.cache.get(cacheKey);

      if (cachedBlogs) {
        return { success: true, blogs: JSON.parse(cachedBlogs) };
      }

      const blogs = await this.prisma.blog.findMany({
        where: { active: true },
        orderBy: { createdAt: 'desc' },
        select: this.getSelectObject(),
      });

      // Transform blogs to include localized content
      const localizedBlogs = blogs.map((blog) =>
        this.transformBlogForLocale(blog, locale)
      );

      // Cache the result for 24 hours (86400 seconds)
      await this.cache.set(cacheKey, JSON.stringify(localizedBlogs), 86400);

      return { success: true, blogs: localizedBlogs };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // Get a single blog by slug (public)
  public async getBlogBySlug(slug: string, locale: string) {
    try {
      // Validate locale
      if (!SUPPORTED_LOCALES.includes(locale)) {
        return { success: false, error: 'Invalid locale' };
      }

      // Check cache first
      const cacheKey = `${CACHE_PREFIX}:${slug}:${locale}`;
      const cachedBlog = await this.cache.get(cacheKey);

      if (cachedBlog) {
        return { success: true, blog: JSON.parse(cachedBlog) };
      }

      // First, try to find the blog by the locale-specific slug
      let blog = await this.prisma.blog.findFirst({
        where: {
          [`slug_${locale}`]: slug,
          active: true,
        },
        select: this.getSelectObject(true),
      });

      // If not found, try to find the blog by any slug across all locales
      if (!blog) {
        const orConditions = SUPPORTED_LOCALES.map((loc) => ({
          [`slug_${loc}`]: slug,
        }));

        blog = await this.prisma.blog.findFirst({
          where: {
            AND: [{ OR: orConditions }, { active: true }],
          },
          select: this.getSelectObject(true),
        });

        if (blog) {
          // Log which locale's slug matched
          for (const loc of SUPPORTED_LOCALES) {
            if (blog[`slug_${loc}`] === slug) {
              break;
            }
          }
        }
      }

      if (!blog) {
        return { success: false, error: 'Blog not found' };
      }

      // Transform blog to include localized content
      const localizedBlog = this.transformBlogForLocale(blog, locale);

      // Add all language slugs to support proper hreflang tags
      const allSlugs: { [key: string]: string } = {};
      for (const loc of SUPPORTED_LOCALES) {
        if (blog[`slug_${loc}`]) {
          allSlugs[loc] = blog[`slug_${loc}`];
        }
      }
      localizedBlog.allSlugs = allSlugs;

      // Add a flag to indicate if a redirect is needed
      const correctSlug = blog[`slug_${locale}`];
      if (correctSlug && correctSlug !== slug) {
        localizedBlog.shouldRedirect = true;
        localizedBlog.correctSlug = correctSlug;
      }

      // Cache the result for 24 hours (86400 seconds)
      await this.cache.set(cacheKey, JSON.stringify(localizedBlog), 86400);

      return { success: true, blog: localizedBlog };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  private slugify(text: string): string {
    return text
      .toString()
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .trim()
      .replace(/\s+/g, '-')
      .replace(/[^\w-]+/g, '')
      .replace(/--+/g, '-');
  }

  // Helper: clear blog-related caches
  private async clearBlogCaches(): Promise<void> {
    // Clear all cached blog lists for all locales
    for (const locale of SUPPORTED_LOCALES) {
      await this.cache.del(`${CACHE_PREFIX}s:all:${locale}`);
    }

    // Clear all individual blog caches using pattern
    await this.cache.delPattern(`${CACHE_PREFIX}:*`);
  }

  // Helper: select all language fields
  private getSelectObject(includeContent = false) {
    const select: any = {
      id: true,
      active: true,
      image: true,
      image_instructions: true,
      createdAt: true,
      updatedAt: true,
    };
    for (const locale of SUPPORTED_LOCALES) {
      select[`slug_${locale}`] = true;
      select[`title_${locale}`] = true;
      select[`summary_${locale}`] = true;
      if (includeContent) select[`content_${locale}`] = true;
    }
    return select;
  }

  // Helper: transform blog data to include localized content without language suffixes
  private transformBlogForLocale(blog: any, locale: string) {
    // Create the transformed blog object
    const transformedBlog: any = {
      id: blog.id,
      slug: blog[`slug_${locale}`] || blog.slug_en || '',
      active: blog.active,
      image: blog.image,
      image_instructions: blog.image_instructions,
      createdAt: blog.createdAt,
      updatedAt: blog.updatedAt,
      title: blog[`title_${locale}`] || blog.title_en || '',
      summary: blog[`summary_${locale}`] || blog.summary_en || '',
    };

    // Include content if it exists in the original blog
    if (
      blog.hasOwnProperty(`content_${locale}`) ||
      blog.hasOwnProperty('content_en')
    ) {
      transformedBlog.content =
        blog[`content_${locale}`] || blog.content_en || '';
    }

    return transformedBlog;
  }
}

export default Blog;
