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
      const localizedBlogs = blogs.map(blog => this.transformBlogForLocale(blog, locale));
      
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
      const data: any = {};
      data.active = input.active !== undefined ? input.active : false;
      if (input.image) {
        data.image = input.image;
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
      for (const locale of SUPPORTED_LOCALES) {
        if (input.hasOwnProperty(`title_${locale}`)) {
          data[`title_${locale}`] = input[`title_${locale}`];
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
      const localizedBlogs = blogs.map(blog => this.transformBlogForLocale(blog, locale));
      
      return { success: true, blogs: localizedBlogs };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // Get a single blog by id (public)
  public async getBlogById(id: number, locale: string) {
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

  // Helper: select all language fields
  private getSelectObject(includeContent = false) {
    const select: any = { id: true, active: true, image: true, createdAt: true, updatedAt: true };
    for (const locale of SUPPORTED_LOCALES) {
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
      active: blog.active,
      image: blog.image,
      createdAt: blog.createdAt,
      updatedAt: blog.updatedAt,
      title: blog[`title_${locale}`] || blog.title_en || '',
      summary: blog[`summary_${locale}`] || blog.summary_en || '',
    };

    // Include content if it exists in the original blog
    if (blog.hasOwnProperty(`content_${locale}`) || blog.hasOwnProperty('content_en')) {
      transformedBlog.content = blog[`content_${locale}`] || blog.content_en || '';
    }

    return transformedBlog;
  }
}

export default Blog;
