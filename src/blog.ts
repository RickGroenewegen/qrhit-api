import PrismaInstance from './prisma';
import { marked } from 'marked';

const SUPPORTED_LOCALES = [
  'en', 'nl', 'de', 'fr', 'es', 'it', 'pt', 'pl', 'hin', 'jp', 'cn', 'ru'
];

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

  // Create a new blog post (expects keys like title_en, content_en, summary_en, etc.)
  public async createBlog(input: BlogInput) {
    try {
      const data: any = {};
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
  public async getAllBlogs() {
    try {
      const blogs = await this.prisma.blog.findMany({
        orderBy: { createdAt: 'desc' },
        select: this.getSelectObject(),
      });
      // Add html fields for each locale
      const blogsWithHtml = blogs.map((blog: any) => ({
        ...blog,
        html: this.getHtmlForAllLocales(blog),
      }));
      return { success: true, blogs: blogsWithHtml };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // Get a single blog by id (public)
  public async getBlogById(id: number) {
    try {
      const blog = await this.prisma.blog.findUnique({
        where: { id },
        select: this.getSelectObject(true),
      });
      if (!blog) {
        return { success: false, error: 'Blog not found' };
      }
      // Render markdown to HTML for all locales
      const html = this.getHtmlForAllLocales(blog);
      return { success: true, blog: { ...blog, html } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // Helper: select all language fields
  private getSelectObject(includeContent = false) {
    const select: any = { id: true, createdAt: true, updatedAt: true };
    for (const locale of SUPPORTED_LOCALES) {
      select[`title_${locale}`] = true;
      select[`summary_${locale}`] = true;
      if (includeContent) select[`content_${locale}`] = true;
    }
    return select;
  }

  // Helper: render markdown to HTML for all locales
  private getHtmlForAllLocales(blog: any) {
    const html: any = {};
    for (const locale of SUPPORTED_LOCALES) {
      if (blog[`content_${locale}`]) {
        html[locale] = marked.parse(blog[`content_${locale}`]);
      } else {
        html[locale] = '';
      }
    }
    return html;
  }
}

export default Blog;
