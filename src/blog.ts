import PrismaInstance from './prisma';
import { marked } from 'marked';

interface BlogInput {
  title: string;
  content: string; // markdown
  summary?: string;
}

class Blog {
  private static instance: Blog;
  private prisma = PrismaInstance.getInstance();

  public static getInstance(): Blog {
    if (!Blog.instance) {
      Blog.instance = new Blog();
    }
    return Blog.instance;
  }

  // Create a new blog post
  public async createBlog({ title, content, summary }: BlogInput) {
    try {
      const blog = await this.prisma.blog.create({
        data: {
          title,
          content,
          summary: summary || '',
        },
      });
      return { success: true, blog };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // Update an existing blog post
  public async updateBlog(id: number, { title, content, summary }: BlogInput) {
    try {
      const blog = await this.prisma.blog.update({
        where: { id },
        data: {
          title,
          content,
          summary: summary || '',
        },
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
        select: {
          id: true,
          title: true,
          summary: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      return { success: true, blogs };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  // Get a single blog by id (public)
  public async getBlogById(id: number) {
    try {
      const blog = await this.prisma.blog.findUnique({
        where: { id },
        select: {
          id: true,
          title: true,
          content: true,
          summary: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      if (!blog) {
        return { success: false, error: 'Blog not found' };
      }
      // Optionally, render markdown to HTML
      const html = marked.parse(blog.content);
      return { success: true, blog: { ...blog, html } };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }
}

export default Blog;
