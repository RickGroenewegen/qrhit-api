import { color } from 'console-log-colors';
import { promises as fs } from 'fs';
import path from 'path';
import * as ExcelJS from 'exceljs';
import Translation from '../translation';
import { Prisma, genre as GenrePrismaModel } from '@prisma/client';
import {
  CACHE_KEY_PLAYLIST,
  CACHE_KEY_PLAYLIST_DB,
  CACHE_KEY_TRACKS,
  CACHE_KEY_TRACK_COUNT,
} from '../spotify';
import { CACHE_KEY_FEATURED_PLAYLISTS } from './featuredPlaylists';
import { DataDeps } from './types';

export async function getPDFFilepath(
  deps: DataDeps,
  clientIp: string,
  paymentId: string,
  userHash: string,
  playlistId: string,
  type: string
): Promise<{ fileName: string; filePath: string } | null> {
  if (type == 'printer' && !deps.utils.isTrustedIp(clientIp)) {
    return null;
  }

  const cacheKey = `pdfFilePath:${paymentId}:${playlistId}:${type}`;
  const cachedFilePath = await deps.cache.get(cacheKey);

  if (cachedFilePath) {
    return JSON.parse(cachedFilePath);
  }

  const result: any[] = await deps.prisma.$queryRaw`
    SELECT
      php.filename,
      php.filenameDigital,
      php.filenameDigitalDoubleSided,
      pl.name
    FROM
      payment_has_playlist php
    INNER JOIN
      payments pm ON php.paymentId = pm.id
    INNER JOIN
      playlists pl ON php.playlistId = pl.id
    INNER JOIN
      users u ON pm.userid = u.id
    WHERE
      pm.paymentId = ${paymentId}
    AND
      pl.playlistId = ${playlistId}
    AND
      u.hash = ${userHash}
    AND
      pm.status = 'paid'
  `;

  if (result.length === 0) {
    return null;
  }

  const paymentHasPlaylist = result[0];
  let filename = '';
  let sanitizedFileName = deps.utils.generateFilename(
    paymentHasPlaylist.name
  );

  if (type == 'printer') {
    filename = paymentHasPlaylist.filename!;
    sanitizedFileName = `printer_${sanitizedFileName}`;
  } else {
    filename = paymentHasPlaylist.filenameDigital!;
  }

  const filePath = `${process.env['PUBLIC_DIR']}/pdf/${filename}`;
  const finalResult = {
    fileName: sanitizedFileName + '.pdf',
    filePath: filePath,
  };
  await deps.cache.set(cacheKey, JSON.stringify(finalResult));
  return finalResult;
}

export async function getLastPlays(deps: DataDeps): Promise<any[]> {
  const ipInfoListKey = 'ipInfoList';
  const ipInfoList = await deps.cache.executeCommand(
    'lrange',
    ipInfoListKey,
    0,
    -1
  );

  const trackIds = ipInfoList
    .map((ipInfoJson: any) => {
      const ipInfo = JSON.parse(ipInfoJson);
      return parseInt(ipInfo.trackId);
    })
    .filter((trackId: number) => !isNaN(trackId));

  const phpIds = ipInfoList
    .map((ipInfoJson: any) => {
      const ipInfo = JSON.parse(ipInfoJson);
      return ipInfo.php ? parseInt(ipInfo.php) : null;
    })
    .filter((phpId: number | null) => phpId !== null);

  // Fetch tracks
  const tracks = await deps.prisma.track.findMany({
    where: { id: { in: trackIds } },
    select: { id: true, name: true, artist: true, trackId: true },
  });

  // Fetch payment_has_playlist data with playlist names and user display names in a single query
  const phpData =
    phpIds.length > 0
      ? await deps.prisma.paymentHasPlaylist.findMany({
          where: { id: { in: phpIds } },
          select: {
            id: true,
            playlist: {
              select: {
                name: true,
              },
            },
            payment: {
              select: {
                user: {
                  select: {
                    displayName: true,
                  },
                },
              },
            },
          },
        })
      : [];

  const trackMap = new Map(tracks.map((track) => [track.id, track]));
  const phpMap = new Map(phpData.map((php) => [php.id, php]));

  const lastPlays = ipInfoList
    .map((ipInfoJson: any) => {
      const ipInfo = JSON.parse(ipInfoJson);
      const track = trackMap.get(parseInt(ipInfo.trackId));

      if (track) {
        const result: any = {
          title: track.name,
          artist: track.artist,
          city: ipInfo.city,
          region: ipInfo.region,
          country: ipInfo.country_code,
          latitude: ipInfo.latitude,
          longitude: ipInfo.longitude,
          timestamp: ipInfo.timestamp,
          trackId: track.trackId,
        };

        // Add playlist and user info if php is available
        if (ipInfo.php) {
          const phpInfo = phpMap.get(parseInt(ipInfo.php));
          if (phpInfo) {
            result.playlistName = phpInfo.playlist.name;
            result.displayName = phpInfo.payment.user?.displayName || null;
          }
        }

        return result;
      }
    })
    .filter(Boolean);

  return lastPlays;
}

export async function translateGenres(deps: DataDeps): Promise<{
  processed: number;
  updated: number;
  errors: number;
}> {
  deps.logger.log(color.blue.bold('Starting genre translation process...'));
  const allLocales = new Translation().allLocales;
  const genres = await deps.prisma.genre.findMany();

  let processedCount = 0;
  let updatedCount = 0;
  let errorCount = 0;

  for (const genre of genres) {
    processedCount++;
    if (!genre.name_en || genre.name_en.trim() === '') {
      deps.logger.log(
        color.yellow.bold(
          `Skipping genre ID ${genre.id} (${color.white.bold(
            genre.slug || 'no-slug'
          )}) as English name (name_en) is missing.`
        )
      );
      continue;
    }

    const localesToTranslate: string[] = [];
    const updateData: Prisma.genreUpdateInput = {};

    for (const locale of allLocales) {
      if (locale === 'en') continue; // Skip English itself

      const localeFieldName = `name_${locale}` as keyof GenrePrismaModel;
      // Check if the property exists on the genre object and if it's null or empty
      if (
        !(localeFieldName in genre) || // Property might not exist if schema changed
        (genre as any)[localeFieldName] === null ||
        ((genre as any)[localeFieldName] as string)?.trim() === ''
      ) {
        localesToTranslate.push(locale);
      }
    }

    if (localesToTranslate.length > 0) {
      deps.logger.log(
        color.blue.bold(
          `Genre ID ${color.white.bold(genre.id)} ("${color.white.bold(
            genre.name_en
          )}") needs translation for: ${color.white.bold(
            localesToTranslate.join(', ')
          )}`
        )
      );
      try {
        const translations = await deps.openai.translateGenreNames(
          genre.name_en,
          localesToTranslate
        );

        let translationsFound = false;
        for (const locale of localesToTranslate) {
          if (translations[locale] && translations[locale].trim() !== '') {
            const localeFieldName =
              `name_${locale}` as keyof Prisma.genreUpdateInput;
            (updateData as any)[localeFieldName] = translations[locale];
            translationsFound = true;
          } else {
            deps.logger.log(
              color.yellow.bold(
                `No valid translation received for genre ID ${color.white.bold(
                  genre.id
                )} ("${color.white.bold(
                  genre.name_en
                )}") in locale ${color.white.bold(locale)}.`
              )
            );
          }
        }

        if (translationsFound) {
          await deps.prisma.genre.update({
            where: { id: genre.id },
            data: updateData,
          });
          updatedCount++;
          deps.logger.log(
            color.blue.bold(
              `Successfully updated translations for genre ID ${color.white.bold(
                genre.id
              )} ("${color.white.bold(genre.name_en)}").`
            )
          );
        }
      } catch (error) {
        errorCount++;
        deps.logger.log(
          color.red.bold(
            `Error translating genre ID ${color.white.bold(
              genre.id
            )} ("${color.white.bold(genre.name_en)}"): ${
              (error as Error).message
            }`
          )
        );
        console.error(error);
      }

      await new Promise((resolve) => setTimeout(resolve, 1000));
    } else {
      deps.logger.log(
        color.blue.bold(
          `Genre ID ${color.white.bold(genre.id)} ("${color.white.bold(
            genre.name_en
          )}") is already fully translated.`
        )
      );
    }
  }

  deps.logger.log(
    color.blue.bold(
      `Genre translation process finished. Processed: ${processedCount}, Updated: ${updatedCount}, Errors: ${errorCount}`
    )
  );
  return {
    processed: processedCount,
    updated: updatedCount,
    errors: errorCount,
  };
}

export async function createSiteMap(deps: DataDeps): Promise<void> {
  // Get all available locales from Translation class
  const locales = deps.translate.allLocales;

  // Get featured playlists with non-empty slugs
  const featuredPlaylists = await deps.prisma.playlist.findMany({
    where: {
      featured: true,
      slug: {
        not: '',
      },
    },
    select: {
      slug: true,
      updatedAt: true,
    },
  });

  // Get active blogs with non-empty slugs for all locales
  const activeBlogs = await deps.prisma.blog.findMany({
    where: {
      active: true,
      OR: locales.map((locale) => ({
        [`slug_${locale}`]: {
          not: null,
        },
      })),
    },
    select: {
      ...Object.fromEntries(
        locales.map((locale) => [`slug_${locale}`, true])
      ),
      updatedAt: true,
    },
  });

  // Define standard paths with default values
  const standardPaths = [
    '/faq',
    '/pricing',
    '/reviews',
    '/blog',
    '/giftcard',
    '/music-match',
    '/examples',
    '/generate/playlist',
    '/contact',
    '/privacy-policy',
    '/terms-and-conditions',
    '/playlists',
    '/onzevibe',
    '/qr-cards-as-a-service',
    '/pubquiz',
    '/shipping-info',
    '/earn-discount',
    '/supported-platforms'
  ];

  // Get current date in YYYY-MM-DD format for lastmod
  const currentDate = new Date().toISOString().split('T')[0];

  // Create sitemap index file that references language-specific sitemaps
  const sitemapIndexContent = `<?xml version="1.0" encoding="UTF-8"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${locales
    .map(
      (locale) => `
  <sitemap>
    <loc>${process.env['FRONTEND_URI']}/sitemap_${locale}.xml</loc>
    <lastmod>${currentDate}</lastmod>
  </sitemap>`
    )
    .join('')}
</sitemapindex>`;

  const sitemapIndexPath = path.join(
    process.env['FRONTEND_ROOT']!,
    '/sitemap.xml'
  );

  await fs.writeFile(sitemapIndexPath, sitemapIndexContent, 'utf8');

  // Create language-specific sitemaps
  for (const locale of locales) {
    // Create paths with default properties for this locale
    const paths = [
      // Homepage has special properties
      {
        loc: `/${locale}`,
        lastmod: currentDate,
        changefreq: 'daily',
        priority: '1.0',
      },
      // Standard pages with common properties
      ...standardPaths.map((pagePath) => ({
        loc: `/${locale}${pagePath}`,
        lastmod: currentDate,
        changefreq: 'monthly',
        priority: '0.8',
      })),
      // Add product pages for featured playlists
      ...featuredPlaylists.map((playlist) => ({
        loc: `/${locale}/product/${playlist.slug}`,
        lastmod: playlist.updatedAt.toISOString().split('T')[0],
        changefreq: 'daily',
        priority: '0.9',
      })),
      // Add blog pages for this locale
      ...activeBlogs
        .filter((blog) => blog[`slug_${locale}` as keyof typeof blog])
        .map((blog) => ({
          loc: `/${locale}/blog/${
            blog[`slug_${locale}` as keyof typeof blog]
          }`,
          lastmod: blog.updatedAt.toISOString().split('T')[0],
          changefreq: 'weekly',
          priority: '0.7',
        })),
    ];

    const localeSitemapContent = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${paths
    .map(
      (path) => `
  <url>
    <loc>${process.env['FRONTEND_URI']}${path.loc}</loc>
    <lastmod>${path.lastmod}</lastmod>
    <changefreq>${path.changefreq}</changefreq>
    <priority>${path.priority}</priority>
  </url>`
    )
    .join('')}
</urlset>`;

    const localeSitemapPath = path.join(
      process.env['FRONTEND_ROOT']!,
      `/sitemap_${locale}.xml`
    );

    await fs.writeFile(localeSitemapPath, localeSitemapContent, 'utf8');
  }

  deps.logger.log(
    color.blue.bold(
      `Generated sitemap index with ${color.white.bold(
        locales.length
      )} language-specific sitemaps`
    )
  );
}

export async function generatePlaylistExcel(
  deps: DataDeps,
  paymentId: string,
  paymentHasPlaylistId: number
): Promise<Buffer | null> {
  try {
    // Fetch the payment with its playlists and tracks
    const paymentHasPlaylist = await deps.prisma.paymentHasPlaylist.findFirst(
      {
        where: {
          id: paymentHasPlaylistId,
          payment: {
            paymentId: paymentId,
          },
        },
      }
    );

    if (!paymentHasPlaylist) {
      deps.logger.log(
        `PaymentHasPlaylist not found for payment ${paymentId} and id ${paymentHasPlaylistId}`
      );
      return null;
    }

    // Fetch the tracks for this playlist
    const playlistTracks = await deps.prisma.playlistHasTrack.findMany({
      where: {
        playlistId: paymentHasPlaylist.playlistId,
      },
      include: {
        track: true,
      },
      orderBy: {
        trackId: 'asc',
      },
    });

    if (!playlistTracks || playlistTracks.length === 0) {
      deps.logger.log(
        `No tracks found for playlistId ${paymentHasPlaylist.playlistId}`
      );
      return null;
    }

    const tracks = playlistTracks.map((pht: any) => pht.track);

    // Create a new workbook and worksheet
    const workbook = new ExcelJS.Workbook();
    const worksheet = workbook.addWorksheet('Playlist Songs');

    // Add header row
    worksheet.columns = [
      { header: 'ID', key: 'id', width: 15 },
      { header: 'Artist', key: 'artist', width: 30 },
      { header: 'Title', key: 'title', width: 30 },
      { header: 'Year', key: 'year', width: 10 },
      { header: 'Spotify Link', key: 'spotifyLink', width: 50 },
      { header: 'QRSong! Link', key: 'qrsongLink', width: 50 },
    ];

    // Style the header row
    worksheet.getRow(1).font = { bold: true };
    worksheet.getRow(1).fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE0E0E0' },
    };

    // Add data rows
    tracks.forEach((track: any) => {
      const spotifyLink = track.trackId
        ? `https://open.spotify.com/track/${track.trackId}`
        : '';
      const qrsongLink = `https://api.qrsong.io/qr2/${track.id}/${paymentHasPlaylistId}`;

      worksheet.addRow({
        id: track.id,
        artist: track.artist || '',
        title: track.name || '',
        year: track.year || '',
        spotifyLink: spotifyLink,
        qrsongLink: qrsongLink,
      });
    });

    // Add borders to all cells
    worksheet.eachRow((row, rowNumber) => {
      row.eachCell((cell) => {
        cell.border = {
          top: { style: 'thin' },
          left: { style: 'thin' },
          bottom: { style: 'thin' },
          right: { style: 'thin' },
        };
      });
    });

    // Generate buffer
    const buffer = await workbook.xlsx.writeBuffer();
    return Buffer.from(buffer);
  } catch (error) {
    deps.logger.log(`Error generating Excel file: ${error}`);
    return null;
  }
}

export async function clearPlaylistCache(
  deps: DataDeps,
  playlistId: string,
  oldSlug?: string
): Promise<{ success: boolean; error?: string }> {
  try {
    // Get playlist to find the current slug
    const playlist = await deps.prisma.playlist.findUnique({
      where: { playlistId },
      select: { slug: true },
    });

    // Clear all relevant caches
    await deps.cache.delPattern(`${CACHE_KEY_FEATURED_PLAYLISTS}*`);
    await deps.cache.del(`${CACHE_KEY_PLAYLIST}${playlistId}`);
    await deps.cache.del(`${CACHE_KEY_PLAYLIST_DB}${playlistId}`);
    // Clear tracks and track count caches (use pattern since they include track count in key)
    await deps.cache.delPattern(`${CACHE_KEY_TRACKS}${playlistId}*`);
    await deps.cache.delPattern(`${CACHE_KEY_TRACK_COUNT}${playlistId}*`);
    if (playlist?.slug) {
      await deps.cache.del(`${CACHE_KEY_PLAYLIST}${playlist.slug}`);
      await deps.cache.del(`${CACHE_KEY_PLAYLIST_DB}${playlist.slug}`);
    }
    // Clear old slug cache if provided and different from current
    if (oldSlug && oldSlug !== playlist?.slug) {
      await deps.cache.del(`${CACHE_KEY_PLAYLIST}${oldSlug}`);
      await deps.cache.del(`${CACHE_KEY_PLAYLIST_DB}${oldSlug}`);
    }

    deps.logger.log(
      color.green.bold(`Cleared cache for playlist ${color.white.bold(playlistId)}`)
    );

    return { success: true };
  } catch (error: any) {
    deps.logger.log(color.red.bold(`Error clearing playlist cache: ${error.message}`));
    return { success: false, error: error.message };
  }
}

export async function clearNonFeaturedPlaylistCaches(
  deps: DataDeps
): Promise<{ success: boolean; processed: number; error?: string }> {
  try {
    // Get all non-featured playlists that have been accessed (have cache entries)
    const nonFeaturedPlaylists = await deps.prisma.playlist.findMany({
      where: {
        featured: false,
      },
      select: {
        playlistId: true,
        slug: true,
      },
    });

    let processed = 0;
    for (const playlist of nonFeaturedPlaylists) {
      await clearPlaylistCache(deps, playlist.playlistId, playlist.slug || undefined);
      processed++;
    }

    deps.logger.log(
      color.green.bold(`Cleared cache for ${color.white.bold(processed)} non-featured playlists`)
    );

    return { success: true, processed };
  } catch (error: any) {
    deps.logger.log(color.red.bold(`Error clearing non-featured playlist caches: ${error.message}`));
    return { success: false, processed: 0, error: error.message };
  }
}
