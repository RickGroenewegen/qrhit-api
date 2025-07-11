import PrismaInstance from './prisma';
import Translation from './translation';

const SUPPORTED_LOCALES = new Translation().allLocales;

type BlogInput = {
  [key: string]: any;
};

class Blog {
  private static instance: Blog;
  private prisma = PrismaInstance.getInstance();

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
          while (await this.prisma.blog.findFirst({ 
            where: { [`slug_${locale}`]: slug } 
          })) {
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
            while (await this.prisma.blog.findFirst({ 
              where: { 
                [`slug_${locale}`]: slug,
                id: { not: id } // Exclude current blog from check
              } 
            })) {
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
      return { success: true, blog };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // Delete a blog post
  public async deleteBlog(id: number) {
    try {
      await this.prisma.blog.delete({ where: { id } });
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

      const blogs = await this.prisma.blog.findMany({
        where: { active: true },
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

  // Get a single blog by slug (public)
  public async getBlogBySlug(slug: string, locale: string) {
    try {
      // Validate locale
      if (!SUPPORTED_LOCALES.includes(locale)) {
        return { success: false, error: 'Invalid locale' };
      }

      const blog = await this.prisma.blog.findFirst({
        where: { [`slug_${locale}`]: slug },
        select: this.getSelectObject(true),
      });
      if (!blog) {
        return { success: false, error: 'Blog not found' };
      }
      if (!blog.active) {
        return { success: false, error: 'Blog not found' };
      }

      // Transform blog to include localized content
      const localizedBlog = this.transformBlogForLocale(blog, locale);

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
