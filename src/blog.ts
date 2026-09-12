import fs from 'fs/promises';
import path from 'path';
import { marked } from 'marked';

import Translation from './translation';
import Cache from './cache';

/**
 * File-backed blog.
 *
 * Posts used to live in a 60-column `blogs` table (slug/title/content/summary
 * times twelve locales) edited through a back-office CMS. They now live as
 * markdown on disk:
 *
 *   src/_data/blog/index.json           metadata for every post, all locales
 *   src/_data/blog/blog_<id>_<lang>.md  one post body in one locale
 *
 * The public API shape is deliberately unchanged, so the frontend, the SSR
 * renderer and the sitemap all keep working without edits: `getAllBlogs` and
 * `getBlogBySlug` return the same fields they always did, with `content` as
 * rendered HTML. What is new is `faq`, extracted from a trailing `## FAQ`
 * section, which the SSR layer turns into FAQPage JSON-LD.
 *
 * The `blogs` table is intentionally left in place and unread. Dropping it in
 * the same change that migrates off it would mean the rollback path is a
 * database restore.
 *
 * Authoring happens in the growth-oracle `blog` pillar (`growth blog …`), not
 * here. This class only reads.
 */

const CACHE_PREFIX = 'blog3';
const SUPPORTED_LOCALES = Translation.ALL_LOCALES;
const FALLBACK_LOCALE = 'en';

/**
 * Where the markdown lives. Resolved from this file rather than from cwd so it
 * works the same under tsx, under the compiled build and under pm2, none of
 * which agree on the working directory.
 *
 * The posts ship with the deploy: `npm run build` ends with `ncp ./src ./build`,
 * which copies non-TypeScript files across, so `_data/blog` lands next to the
 * compiled `blog.js` at `build/src/_data/blog`. `__dirname` is `src/` in dev and
 * `build/src/` in production and the first candidate covers both; the second is
 * a fallback for running the compiled entry point from the repo root.
 */
const CONTENT_DIRS = [
  // tsx/dev: __dirname is <repo>/src. Production: `npm run build` ends with
  // `ncp ./src ./build`, so __dirname is <repo>/build/src and the copy lands here.
  path.join(__dirname, '_data', 'blog'),
  // `npm run start:dev` runs `tsc -w`, which compiles but never runs that ncp
  // step, so under the watcher the copy does NOT exist and __dirname is
  // <repo>/build/src. Reach back to the real source tree instead of crashing.
  path.join(__dirname, '..', '..', 'src', '_data', 'blog'),
  // Last resort for any entry point started from the repo root.
  path.join(process.cwd(), 'src', '_data', 'blog'),
];

export interface BlogFaqEntry {
  question: string;
  answer: string;
}

interface BlogPostMeta {
  id: number;
  date: string;
  updated?: string;
  author: string;
  image?: string | null;
  tags?: string[];
  slugs: Record<string, string>;
  titles: Record<string, string>;
  summaries: Record<string, string>;
}

class Blog {
  private static instance: Blog;
  private cache = Cache.getInstance();
  private contentDir: string | null = null;
  private indexPromise: Promise<BlogPostMeta[]> | null = null;
  /**
   * Content version, mixed into every cache key.
   *
   * Posts are files now, so "has the content changed" is answerable exactly:
   * it is the modification time of index.json, which is rewritten by every
   * authoring verb. Putting it in the key means a deploy or an edit invalidates
   * the cache on its own.
   *
   * Without this, editing content left Redis serving the previous version for
   * up to 24 hours: a removed post kept appearing in the overview and newly
   * generated images never showed up, because the cached rows still had
   * `image: null`. Manually flushing after every change is not a system.
   */
  private versionPromise: Promise<string> | null = null;

  public static getInstance(): Blog {
    if (!Blog.instance) {
      Blog.instance = new Blog();
    }
    return Blog.instance;
  }

  /* ------------------------------------------------------------ loading -- */

  private async resolveContentDir(): Promise<string> {
    if (this.contentDir) return this.contentDir;
    for (const candidate of CONTENT_DIRS) {
      try {
        await fs.access(path.join(candidate, 'index.json'));
        this.contentDir = candidate;
        return candidate;
      } catch {
        // try the next candidate
      }
    }
    throw new Error(
      `no blog index.json found in: ${CONTENT_DIRS.join(', ')}`
    );
  }

  /**
   * The index is read once per process and held in memory. It is a ~30 KB file
   * that only changes on deploy, so re-reading it per request would buy nothing.
   * Held as the promise rather than the value so concurrent first requests share
   * one read instead of racing.
   */
  private loadIndex(): Promise<BlogPostMeta[]> {
    if (!this.indexPromise) {
      this.indexPromise = (async () => {
        const dir = await this.resolveContentDir();
        const raw = await fs.readFile(path.join(dir, 'index.json'), 'utf8');
        const parsed = JSON.parse(raw);
        const posts: BlogPostMeta[] = Array.isArray(parsed?.posts)
          ? parsed.posts
          : [];
        // Newest first, which is the order the blog index renders in.
        return posts.sort((a, b) =>
          a.date === b.date ? b.id - a.id : b.date.localeCompare(a.date)
        );
      })().catch((error) => {
        // Do not cache a failed read: a deploy that lands index.json a moment
        // late would otherwise leave the process permanently blogless.
        this.indexPromise = null;
        throw error;
      });
    }
    return this.indexPromise;
  }

  /** Modification time of index.json, as a short cache-key fragment. */
  private contentVersion(): Promise<string> {
    if (!this.versionPromise) {
      this.versionPromise = (async () => {
        const dir = await this.resolveContentDir();
        const stat = await fs.stat(path.join(dir, 'index.json'));
        return String(Math.floor(stat.mtimeMs));
      })().catch(() => {
        this.versionPromise = null;
        // A version we cannot read must not become a stable key, or a transient
        // failure would pin the cache to a bogus version for a day.
        return `nover-${Date.now()}`;
      });
    }
    return this.versionPromise;
  }

  private async readBody(id: number, locale: string): Promise<string | null> {
    const dir = await this.resolveContentDir();
    try {
      return await fs.readFile(
        path.join(dir, `blog_${id}_${locale}.md`),
        'utf8'
      );
    } catch {
      return null;
    }
  }

  /* ----------------------------------------------------------- rendering -- */

  /** Replace the `[lang]` placeholder in internal links with the real locale. */
  private replaceLangPlaceholders(content: string, locale: string): string {
    if (!content) return content;
    return content.split('[lang]').join(locale);
  }

  /**
   * Split a body into prose and its trailing FAQ section.
   *
   * The convention is a final `## …` heading whose children are all `### `
   * questions and nothing else. Matching on structure rather than on the word
   * "FAQ" is what makes it work in twelve languages without a translated
   * keyword list. Mirrors `splitFaq` in the growth-oracle blog pillar, which is
   * what `growth blog lint` validates against.
   */
  private splitFaq(markdown: string): { body: string; faq: BlogFaqEntry[] } {
    const h2Re = /^##\s+(.+)$/gm;
    const starts: number[] = [];
    let match: RegExpExecArray | null;
    while ((match = h2Re.exec(markdown))) starts.push(match.index);
    if (!starts.length) return { body: markdown, faq: [] };

    const lastStart = starts[starts.length - 1];
    const section = markdown.slice(lastStart);

    const questionRe = /^###\s+(.+)$/gm;
    const marks: { title: string; index: number; length: number }[] = [];
    while ((match = questionRe.exec(section))) {
      marks.push({
        title: match[1].trim(),
        index: match.index,
        length: match[0].length,
      });
    }
    if (marks.length < 2) return { body: markdown, faq: [] };

    const preamble = section.slice(section.indexOf('\n'), marks[0].index).trim();
    if (preamble) return { body: markdown, faq: [] };

    const faq: BlogFaqEntry[] = [];
    for (let i = 0; i < marks.length; i++) {
      const start = marks[i].index + marks[i].length;
      const end = i + 1 < marks.length ? marks[i + 1].index : section.length;
      const answer = section.slice(start, end).trim();
      if (answer) faq.push({ question: marks[i].title, answer });
    }

    return { body: markdown.slice(0, lastStart).trim(), faq };
  }

  /**
   * Markdown to HTML.
   *
   * Headings start at h2 in the source because the post title is the page's h1,
   * so nothing here needs to demote them. `marked` is configured without
   * `gfm.breaks` so a single newline stays a space, which is what the migrated
   * content assumes.
   */
  private render(markdown: string): string {
    return marked.parse(markdown, { async: false }) as string;
  }

  /* ------------------------------------------------------------- public -- */

  private metaFor(post: BlogPostMeta, locale: string) {
    const pick = (map: Record<string, string> = {}) =>
      map[locale] ?? map[FALLBACK_LOCALE] ?? '';
    return {
      id: post.id,
      slug: pick(post.slugs),
      active: true,
      image: post.image ?? null,
      image_instructions: null,
      createdAt: post.date,
      updatedAt: post.updated ?? post.date,
      title: pick(post.titles),
      summary: pick(post.summaries),
    };
  }

  /** Every post that exists in this locale, newest first. */
  public async getAllBlogs(locale: string) {
    try {
      if (!SUPPORTED_LOCALES.includes(locale)) {
        return { success: false, error: 'Invalid locale' };
      }

      const cacheKey = `${CACHE_PREFIX}s:all:${locale}:${await this.contentVersion()}`;
      const cached = await this.cache.get(cacheKey);
      if (cached) return { success: true, blogs: JSON.parse(cached) };

      const index = await this.loadIndex();

      // A post is listed only where it has a body in this locale. Listing an
      // untranslated post would link to a slug that does not exist, which is
      // how you get 404s inside your own blog index.
      const blogs = [];
      for (const post of index) {
        if (!post.slugs?.[locale]) continue;
        const body = await this.readBody(post.id, locale);
        if (!body) continue;
        blogs.push(this.metaFor(post, locale));
      }

      await this.cache.set(cacheKey, JSON.stringify(blogs), 86400);
      return { success: true, blogs };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /** One post, by its slug in this locale. */
  public async getBlogBySlug(slug: string, locale: string) {
    try {
      if (!SUPPORTED_LOCALES.includes(locale)) {
        return { success: false, error: 'Invalid locale' };
      }

      const cacheKey = `${CACHE_PREFIX}:${slug}:${locale}:${await this.contentVersion()}`;
      const cached = await this.cache.get(cacheKey);
      if (cached) return { success: true, blog: JSON.parse(cached) };

      const index = await this.loadIndex();

      // Match this locale's slug first. Falling back to a match on ANY locale's
      // slug keeps old inbound links alive: before the per-locale slugs existed
      // every locale used the English one, and those URLs are still linked from
      // the wild.
      let post = index.find((p) => p.slugs?.[locale] === slug);
      if (!post) {
        post = index.find((p) =>
          Object.values(p.slugs ?? {}).includes(slug)
        );
      }
      if (!post) return { success: false, error: 'Blog not found' };

      const markdown =
        (await this.readBody(post.id, locale)) ??
        (await this.readBody(post.id, FALLBACK_LOCALE));
      if (!markdown) return { success: false, error: 'Blog not found' };

      const { body, faq } = this.splitFaq(markdown);
      const localized = this.replaceLangPlaceholders(body, locale);

      const blog = {
        ...this.metaFor(post, locale),
        author: post.author,
        tags: post.tags ?? [],
        content: this.render(localized),
        faq: faq.map((entry) => ({
          question: entry.question,
          // Answers are markdown too, and can contain links. Rendering them
          // keeps formatting in the visible accordion; the SSR layer strips
          // tags again for the JSON-LD, where plain text is required.
          answer: this.render(
            this.replaceLangPlaceholders(entry.answer, locale)
          ),
        })),
        allSlugs: post.slugs,
      };

      await this.cache.set(cacheKey, JSON.stringify(blog), 86400);
      return { success: true, blog };
    } catch (error) {
      return { success: false, error: (error as Error).message };
    }
  }

  /**
   * Post metadata for the sitemap: one entry per post/locale pair that actually
   * has a body file. Used by `createSiteMap` in place of the old Prisma query.
   */
  public async getSitemapEntries(
    locale: string
  ): Promise<{ slug: string; lastmod: string }[]> {
    let index: BlogPostMeta[];
    try {
      index = await this.loadIndex();
    } catch (error) {
      // The sitemap is generated at boot. Throwing here took the whole API down
      // when the content directory was missing, which is a bad trade: losing the
      // blog URLs from one sitemap generation is recoverable, not starting is
      // not. Loud, because a silent empty blog section is how this goes
      // unnoticed for a week.
      console.error(
        `[blog] sitemap entries unavailable for "${locale}": ${
          (error as Error).message
        } — blog URLs will be missing from this sitemap`
      );
      return [];
    }

    const entries: { slug: string; lastmod: string }[] = [];
    for (const post of index) {
      const slug = post.slugs?.[locale];
      if (!slug) continue;
      if (!(await this.readBody(post.id, locale))) continue;
      entries.push({ slug, lastmod: post.updated ?? post.date });
    }
    return entries;
  }

  /** Drop the rendered-post caches. Call after a deploy that changes content. */
  public async clearCaches(): Promise<void> {
    this.indexPromise = null;
    this.versionPromise = null;
    await this.cache.del(`${CACHE_PREFIX}*`);
  }
}

export default Blog;
