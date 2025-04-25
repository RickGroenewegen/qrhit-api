import PrismaInstance from './prisma';
import Logger from './logger';
import { color } from 'console-log-colors';
import Cache from './cache';
import Utils from './utils';
import Spotify from './spotify';
import { Music } from './music';
import Settings from './settings'; // Import the new Settings class
import Data from './data';
import Mail from './mail';
import Vibe from './vibe'; // Import the Vibe class
import Translation from './translation'; // Import Translation
import { Prisma } from '@prisma/client'; // Import Prisma for raw query join
import axios, { AxiosResponse } from 'axios'; // Import AxiosResponse
import { format } from 'date-fns'; // Add date-fns format import
class Hitlist {
  private static instance: Hitlist;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private cache = Cache.getInstance();
  private utils = new Utils();
  private music: Music = new Music();
  private data = Data.getInstance();
  private spotify = new Spotify();
  private mail = Mail.getInstance();
  private settings = Settings.getInstance(); // Instantiate Settings
  private vibe = Vibe.getInstance(); // Instantiate Vibe
  private translation = new Translation(); // Instantiate Translation

  private constructor() {
    this.initDir();
  }

  public static getInstance(): Hitlist {
    if (!Hitlist.instance) {
      Hitlist.instance = new Hitlist();
    }
    return Hitlist.instance;
  }

  private async initDir(): Promise<void> {
    try {
      const backgroundDir = `${process.env['PUBLIC_DIR']}/companydata`;
      await this.utils.createDir(backgroundDir);
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error initializing company data dir: ${color.white.bold(error)}`
        )
      );
    }
  }

  public async submit(hitlist: any) {
    try {
      // Check if we have a company list submission hash in the first track
      const submissionHash = hitlist[0]?.submissionHash;
      const companyListId = hitlist[0]?.companyListId;
      const fullname = hitlist[0]?.fullname;
      const email = hitlist[0]?.email;

      if (!submissionHash || !companyListId) {
        return {
          success: false,
          error: 'Missing submission hash or company list ID',
        };
      }

      // Check if there's already a submission with this email for this company list
      if (email) {
        const existingSubmission =
          await this.prisma.companyListSubmission.findFirst({
            where: {
              companyListId: parseInt(companyListId),
              email: email,
              NOT: {
                hash: submissionHash, // Exclude the current submission
              },
            },
          });

        if (existingSubmission) {
          return {
            success: false,
            error: 'playlistAlreadySubmitted',
          };
        }
      }

      // Get company list information, including dates and company details
      const companyList = await this.prisma.companyList.findUnique({
        where: { id: parseInt(companyListId) },
        // Select necessary fields including dates and nested Company fields
        select: {
          id: true,
          name: true,
          startAt: true,
          endAt: true,
          Company: {
            select: {
              name: true, // Select company name for email context
            },
          },
          slug: true, // Select slug for verification email link
          // Add other fields if needed later
        },
      });

      if (!companyList) {
        return {
          success: false,
          error: 'Company list not found',
        };
      }

      // Check if voting is open based on startAt and endAt dates
      const now = new Date();
      const startAt = companyList.startAt;
      const endAt = companyList.endAt;
      let votingOpen = true; // Default to true

      if (startAt && endAt) {
        votingOpen = now >= startAt && now <= endAt;
      } else if (startAt && !endAt) {
        votingOpen = now >= startAt;
      } else if (!startAt && endAt) {
        votingOpen = now <= endAt;
      }

      if (!votingOpen) {
        this.logger.log(
          color.yellow.bold(
            `Submission attempt outside voting period for list ${color.white.bold(
              companyList.name
            )} (ID: ${companyList.id})`
          )
        );
        return {
          success: false,
          error: 'votingClosed', // Specific error key for frontend
        };
      }

      // Find or create the company list submission
      let submission = await this.prisma.companyListSubmission.findUnique({
        where: { hash: submissionHash },
      });

      const verificationHash = this.utils.generateRandomString(32);

      if (!submission) {
        // Generate a unique verification hash

        submission = await this.prisma.companyListSubmission.create({
          data: {
            companyListId: parseInt(companyListId),
            hash: submissionHash,
            verificationHash: verificationHash,
            status: 'pending_verification', // Changed from 'submitted' to 'pending_verification'
            name: fullname || null,
            email: email || null,
          },
        });

        this.logger.log(
          color.blue.bold(
            `Created new company list submission with hash ${color.white.bold(
              submissionHash
            )} and verification hash ${color.white.bold(verificationHash)}`
          )
        );
      } else {
        // Update the existing submission with the new status and user info
        submission = await this.prisma.companyListSubmission.update({
          where: { id: submission.id },
          data: {
            status: 'pending_verification', // Changed from 'submitted' to 'pending_verification'
            name: fullname || submission.name,
            email: email || submission.email,
            verificationHash: verificationHash,
          },
        });
      }

      // Send verification email if we have an email address
      if (email && submission.verificationHash) {
        await this.mail.sendVerificationEmail(
          email,
          fullname || email.split('@')[0],
          companyList.Company.name,
          submission.verificationHash,
          companyList.slug!
        );
      }

      // Process the rest of the submission asynchronously
      this.processSubmissionAsync(hitlist, submission.id);

      return {
        success: true,
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error submitting hitlist: ${error}`));
      return { success: false, error: 'Error submitting hitlist' };
    }
  }

  private async processSubmissionAsync(
    hitlist: any[],
    submissionId: number
  ): Promise<void> {
    try {
      if (!hitlist || hitlist.length === 0) {
        this.logger.log(
          color.yellow.bold(
            `Empty hitlist received for submission ${submissionId}`
          )
        );
        return;
      }

      // --- Start: Filter hitlist based on ranking within the submission ---
      const companyListId = hitlist[0]?.companyListId;
      if (!companyListId) {
        this.logger.log(
          color.red.bold(
            `Missing companyListId in hitlist for submission ${submissionId}`
          )
        );
        return;
      }

      // 1. Get Company List details
      const companyList = await this.prisma.companyList.findUnique({
        where: { id: parseInt(companyListId) },
        select: { numberOfTracks: true, numberOfCards: true, name: true },
      });

      if (!companyList) {
        this.logger.log(
          color.red.bold(
            `Company list ${companyListId} not found for submission ${submissionId}`
          )
        );
        return;
      }

      const maxPoints = companyList.numberOfTracks;
      const maxTracksToKeep = companyList.numberOfCards;

      if (maxPoints <= 0 || maxTracksToKeep <= 0) {
        this.logger.log(
          color.yellow.bold(
            `List ${companyList.name} (ID: ${companyListId}) has invalid numberOfTracks (${maxPoints}) or numberOfCards (${maxTracksToKeep}). Processing all submitted tracks.`
          )
        );
        // If limits are invalid, proceed without filtering (or decide on alternative behavior)
      }

      // 2. Calculate score for each track in the submission
      const scoredHitlist = hitlist.map((track) => ({
        ...track,
        score: maxPoints > 0 ? Math.max(0, maxPoints - track.position + 1) : 1, // Ensure score is non-negative, default to 1 if maxPoints is invalid
      }));

      // 3. Sort by score descending
      scoredHitlist.sort((a, b) => b.score - a.score);

      // 4. Filter to keep only top tracks within the limit
      const filteredHitlist = scoredHitlist.slice(0, maxTracksToKeep);

      if (filteredHitlist.length === 0) {
        this.logger.log(
          color.yellow.bold(
            `No tracks left after filtering for submission ${submissionId}`
          )
        );
        // Update submission status to indicate it's processed but empty? Or handle as needed.
        // For now, just return. Consider updating status later if required.
        // await this.prisma.companyListSubmission.update({ where: { id: submissionId }, data: { status: 'processed_empty' } });
        return;
      }
      // --- End: Filter hitlist ---

      // Extract Spotify track IDs from the *filtered* hitlist
      const trackIds = filteredHitlist.map((track: any) => track.trackId);

      // Use the new getTracksByIds method to get detailed track information
      const data = Data.getInstance();
      const tracksResult = await this.spotify.getTracksByIds(trackIds);

      if (tracksResult.success && tracksResult.data) {
        // Array to store newly created track IDs
        const newTrackIds: string[] = [];
        const trackDbIds: Map<string, number> = new Map(); // Map to store trackId -> DB id

        // Store tracks in the database (using data from Spotify response)
        for (const trackData of tracksResult.data) {
          // Check if track already exists in the database
          let track = await this.prisma.track.findUnique({
            where: { trackId: trackData.trackId },
          });

          const spotifyYear = trackData.releaseDate
            ? parseInt(trackData.releaseDate.substring(0, 4))
            : null;

          if (!track) {
            // Create new track if it doesn't exist
            track = await this.prisma.track.create({
              data: {
                trackId: trackData.trackId,
                name: trackData.name,
                artist: trackData.artist,
                album: trackData.album,
                preview: trackData.preview,
                isrc: trackData.isrc,
                spotifyYear: spotifyYear,
                spotifyLink: trackData.link,
                youtubeLink: '',
                manuallyChecked: false,
              },
            });

            const youtubeId = await this.data.getYouTubeLink(
              track.artist,
              track.name
            );
            if (youtubeId) {
              await this.prisma.track.update({
                where: { trackId: track.trackId },
                data: { youtubeLink: youtubeId },
              });
            }

            // Add to the list of newly created tracks
            newTrackIds.push(trackData.trackId);
          }

          // Store the DB id for this track
          trackDbIds.set(trackData.trackId, track.id);
        }

        this.logger.log(
          color.blue.bold(
            `Hitlist has ${color.white.bold(newTrackIds.length)} new tracks`
          )
        );

        // If we have new tracks, update their years
        if (newTrackIds.length > 0) {
          await this.data.updateTrackYear(newTrackIds, tracksResult.data);
        }

        // Delete any existing tracks for this submission
        await this.prisma.companyListSubmissionTrack.deleteMany({
          where: {
            companyListSubmissionId: submissionId,
          },
        });

        // Create CompanyListSubmissionTrack entries for each *filtered* track
        // Use the original position from the filteredHitlist object
        for (const filteredTrack of filteredHitlist) {
          const trackDbId = trackDbIds.get(filteredTrack.trackId); // Get DB ID using Spotify ID

          if (trackDbId) {
            await this.prisma.companyListSubmissionTrack.create({
              data: {
                companyListSubmissionId: submissionId,
                trackId: trackDbId, // The DB ID of the track
                position: filteredTrack.position, // The original position from the submission
              },
            });
          } else {
            this.logger.log(
              color.yellow.bold(
                `Could not find DB ID for Spotify track ${filteredTrack.trackId} while saving submission tracks for ${submissionId}`
              )
            );
          }
        }

        this.logger.log(
          color.green.bold(
            `Created ${color.white.bold(
              filteredHitlist.length // Log the count of tracks actually saved
            )} submission tracks for submission ${color.white.bold(
              submissionId
            )}`
          )
        );
      } else {
        this.logger.log(
          color.red.bold(
            `Failed to get track details for submission ${color.white.bold(
              submissionId
            )}`
          )
        );
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(
          `Error processing submission ${color.white.bold(
            submissionId
          )} asynchronously: ${error}`
        )
      );
    }
  }

  public async verifySubmission(verificationHash: string): Promise<boolean> {
    try {
      const submission = await this.prisma.companyListSubmission.findUnique({
        where: { verificationHash: verificationHash },
      });

      if (!submission) {
        this.logger.log(
          color.red.bold(
            `Submission with verification hash ${color.white.bold(
              verificationHash
            )} not found`
          )
        );
        return false;
      }

      // Update the submission status to verified
      await this.prisma.companyListSubmission.update({
        where: { id: submission.id },
        data: {
          status: 'submitted', // Change from pending_verification to submitted
          verified: true,
          verifiedAt: new Date(),
        },
      });

      this.logger.log(
        color.green.bold(
          `Verified submission with hash ${color.white.bold(
            submission.hash
          )} using verification hash ${color.white.bold(verificationHash)}`
        )
      );
      return true;
    } catch (error) {
      this.logger.log(color.red.bold(`Error verifying submission: ${error}`));
      return false;
    }
  }

  public async finalizeList(companyListId: number): Promise<any> {
    try {
      // Get the company list
      const companyList = await this.prisma.companyList.findUnique({
        where: { id: companyListId },
        include: { Company: true },
      });

      if (!companyList) {
        return { success: false, error: 'Company list not found' };
      }

      // Get all verified submissions for this company list
      const submissions = await this.prisma.companyListSubmission.findMany({
        where: {
          companyListId: companyListId,
          verified: true,
          status: 'submitted',
        },
        orderBy: { createdAt: 'asc' },
        include: {
          CompanyListSubmissionTrack: {
            include: {
              Track: true,
            },
            orderBy: { position: 'asc' },
          },
        },
      });

      // --- Use Vibe's getRanking method ---
      const rankingResult = await this.vibe.getRanking(companyListId);

      if (!rankingResult.success || !rankingResult.data) {
        this.logger.log(
          color.red.bold(
            `Failed to get ranking for list ${companyListId}: ${rankingResult.error}`
          )
        );
        return {
          success: false,
          error: `Failed to calculate ranking: ${rankingResult.error}`,
        };
      }

      const allRankedTracks = rankingResult.data.ranking; // This is already sorted by score
      const totalSubmissionsCount = submissions.length; // Keep the count of submissions

      if (allRankedTracks.length === 0) {
        this.logger.log(
          color.yellow.bold(
            `No tracks found in ranking for list ${companyListId}.`
          )
        );
        // Optionally update status or handle differently
        // For now, proceed to potentially create empty playlists or return success with empty data
      }

      // Use numberOfCards from companyList
      const maxTracks = companyList.numberOfCards;

      // Filter the ranked tracks to get the top ones based on numberOfCards
      // The 'withinLimit' flag from getRanking already tells us this.
      const topTracks = allRankedTracks.filter(
        (track: any) => track.withinLimit
      );

      // If maxTracks was 0 or invalid in the DB, getRanking might not set withinLimit correctly.
      // As a fallback, slice if needed, though relying on withinLimit is preferred.
      if (
        topTracks.length === 0 &&
        maxTracks > 0 &&
        allRankedTracks.length > 0
      ) {
        this.logger.log(
          color.yellow.bold(
            `Fallback: Slicing top ${maxTracks} tracks as 'withinLimit' was not set.`
          )
        );
        // Ensure we don't try to slice more than available tracks
        const actualSlice = Math.min(maxTracks, allRankedTracks.length);
        // Reassign topTracks based on slice
        // Note: This fallback might indicate an issue in getRanking's withinLimit logic if maxTracks is valid.
        // topTracks = allRankedTracks.slice(0, actualSlice);
        // Let's stick to the withinLimit flag for consistency for now. If it's empty, it's empty.
      }

      this.logger.log(
        color.blue.bold(
          `Creating playlist for company ${color.white.bold(
            companyList.Company.name
          )} with ${color.white.bold(topTracks.length)}`
        )
      );

      // --- Create/Update Limited Playlist ---
      const limitedPlaylistResult = await this.createPlaylist(
        companyList.Company.name,
        companyList.name, // Original name
        topTracks.map((track: any) => track.spotifyLink!.split('/').pop()!) // Use spotifyLink from ranked data
      );

      // --- Update CompanyList with Limited Playlist URL ---
      if (
        limitedPlaylistResult.success &&
        limitedPlaylistResult.data?.playlistUrl
      ) {
        try {
          await this.prisma.companyList.update({
            where: { id: companyListId },
            data: { playlistUrl: limitedPlaylistResult.data.playlistUrl }, // Update the standard playlistUrl field
          });
        } catch (dbError) {
          this.logger.log(
            color.red.bold(
              `Failed to update playlistUrl for CompanyList ID ${companyListId}: ${dbError}`
            )
          );
          // Decide if this should be a critical error or just logged
        }
      } else {
        this.logger.log(
          color.yellow.bold(
            `Skipping update of playlistUrl for CompanyList ID ${companyListId} due to limited playlist creation/update failure.`
          )
        );
      }
      // --- End Update ---

      // --- Create/Update Full Playlist ---
      const fullPlaylistName = `${companyList.name} (FULL)`;
      const fullPlaylistResult = await this.createPlaylist(
        companyList.Company.name,
        fullPlaylistName, // Name with suffix
        allRankedTracks.map(
          (track: any) => track.spotifyLink!.split('/').pop()!
        ) // All ranked tracks
      );

      // --- Update CompanyList with Full Playlist URL ---
      if (fullPlaylistResult.success && fullPlaylistResult.data?.playlistUrl) {
        try {
          await this.prisma.companyList.update({
            where: { id: companyListId },
            data: { playlistUrlFull: fullPlaylistResult.data.playlistUrl },
          });
        } catch (dbError) {
          this.logger.log(
            color.red.bold(
              `Failed to update playlistUrlFull for CompanyList ID ${companyListId}: ${dbError}`
            )
          );
          // Decide if this should be a critical error or just logged
        }
      } else {
        this.logger.log(
          color.yellow.bold(
            `Skipping update of playlistUrlFull for CompanyList ID ${companyListId} due to playlist creation/update failure.`
          )
        );
      }

      // Update the list status to:  spotify_list_generated
      await this.prisma.companyList.update({
        where: { id: companyListId },
        data: { status: 'spotify_list_generated' },
      });

      // --- End Update ---

      return {
        success: true,
        data: {
          companyName: companyList.Company.name,
          companyListName: companyList.name,
          totalSubmissions: totalSubmissionsCount, // Use the stored count
          // Map the topTracks (those within limit) based on the ranking result structure
          tracks: topTracks.map((track: any, index: number) => ({
            position: index + 1, // Position based on the final sorted limited list
            trackId: track.id, // DB track ID
            spotifyTrackId: track.spotifyLink!.split('/').pop()!, // Extract Spotify ID
            artist: track.artist,
            title: track.name, // Field name is 'name' in Track model
            score: track.score, // Include the score from ranking
            voteCount: track.voteCount, // Include the vote count from ranking
          })),
          // Include results for both playlists
          playlistLimited: limitedPlaylistResult.success
            ? limitedPlaylistResult.data
            : { error: limitedPlaylistResult.error }, // Include error if failed
          playlistFull: fullPlaylistResult.success
            ? fullPlaylistResult.data
            : { error: fullPlaylistResult.error }, // Include error if failed
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error finalizing list: ${error}`));
      return { success: false, error: 'Error finalizing list' };
    }
  }

  public async getCompanyListByDomain(
    domain: string,
    hash: string,
    slug: string
  ) {
    try {
      const companyList = await this.prisma.companyList.findFirst({
        where: { slug },
        // Select specific fields including the new date fields and nested Company fields
        select: {
          id: true,
          name: true,
          description: true,
          numberOfTracks: true,
          numberOfCards: true,
          votingBackground: true,
          votingLogo: true,
          startAt: true, // Added startAt
          endAt: true, // Added endAt
          Company: {
            // Keep selecting company name
            select: {
              name: true, // Select only the company name
            },
          },
          slug: true, // Keep slug if needed elsewhere
        },
      });

      if (!companyList) {
        return { success: false, error: 'Company list not found' };
      }

      let submissionStatus = 'open';

      if (hash && hash.length > 0) {
        // Find the submission with this hash
        const submission = await this.prisma.companyListSubmission.findUnique({
          where: { hash },
        });

        if (submission) {
          submissionStatus = submission.status;
        }
      }

      // Calculate votingOpen status
      const now = new Date();
      const startAt = companyList.startAt;
      const endAt = companyList.endAt;
      let votingOpen = true; // Default to true

      if (startAt && endAt) {
        // Both dates are set
        votingOpen = now >= startAt && now <= endAt;
      } else if (startAt && !endAt) {
        // Only start date is set (open indefinitely after start)
        votingOpen = now >= startAt;
      } else if (!startAt && endAt) {
        // Only end date is set (open indefinitely until end)
        votingOpen = now <= endAt;
      }
      // If both are null, votingOpen remains true

      return {
        success: true,
        data: {
          id: companyList.id,
          name: companyList.name,
          description: companyList.description,
          numberOfTracks: companyList.numberOfTracks,
          numberOfCards: companyList.numberOfCards,
          companyName: companyList.Company.name,
          votingBackground: companyList.votingBackground,
          votingLogo: companyList.votingLogo,
          startAt: companyList.startAt, // Added startAt
          endAt: companyList.endAt, // Added endAt
          votingOpen: votingOpen, // Added calculated votingOpen
          submissionStatus: submissionStatus,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error getting company list: ${error}`));
      return { success: false, error: 'Error getting company list' };
    }
  }

  /**
   * Creates a Spotify playlist with the given tracks
   * @param companyName The name of the company
   * @param listName The name of the list
   * @param trackIds Array of Spotify track IDs to add to the playlist
   * @returns Object with success status and playlist data
   */
  public async createPlaylist(
    companyName: string,
    listName: string,
    trackIds: string[]
  ): Promise<any> {
    try {
      if (!trackIds || trackIds.length === 0) {
        return { success: false, error: 'No tracks provided' };
      }

      // Construct the playlist name
      const playlistName = `${companyName} - ${listName}`;

      // Call the new method in SpotifyApi via this.spotify.api
      // This method now handles token acquisition and API calls internally.
      const result = await this.spotify.api.createOrUpdatePlaylist(
        playlistName,
        trackIds
      );

      // Handle the result
      if (result.success) {
        // Return the success data directly
        return {
          success: true,
          data: result.data, // Contains playlistId, playlistUrl, playlistName
        };
      } else if (result.needsReAuth) {
        // If re-authentication is needed, construct the auth URL
        const clientId = process.env['SPOTIFY_CLIENT_ID'];
        if (!clientId) {
          this.logger.log(
            color.red.bold(
              'Missing Spotify Client ID for generating auth URL.'
            )
          );
          return {
            success: false,
            error: 'Configuration error: Missing Spotify Client ID',
          };
        }
        const redirectUri =
          process.env['SPOTIFY_REDIRECT_URI'] ||
          'http://localhost:3004/spotify_callback'; // Use the same default
        const scope = 'playlist-modify-public';
        const authUrl = `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(
          redirectUri
        )}&scope=${encodeURIComponent(scope)}`;

        this.logger.log(
          color.yellow.bold(
            'Spotify authorization required. Please visit the following URL:'
          )
        );
        this.logger.log(color.white.bold(authUrl));

        return {
          success: false,
          error: 'Authorization required',
          message: 'Please check the server logs for the authorization URL',
          authUrl: authUrl, // Provide the auth URL to the caller
        };
      } else {
        // Handle other errors returned by createOrUpdatePlaylist
        this.logger.log(
          color.red.bold(
            `Error creating/updating Spotify playlist: ${result.error}`
          )
        );
        return {
          success: false,
          error: result.error || 'Failed to create/update Spotify playlist',
        };
      }
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error creating Spotify playlist: ${error}`)
      );
      return { success: false, error: 'Error creating Spotify playlist' };
    }
  }

  // Modified to remove state parameter
  public async completeSpotifyAuth(authCode: string): Promise<any> {
    try {
      // Retrieve the playlistJobId from the fixed cache key
      const latestJobIdKey = 'latest_spotify_playlist_job_id';
      const playlistJobId = await this.cache.get(latestJobIdKey);

      if (!playlistJobId) {
        this.logger.log(
          color.red.bold(
            `Could not retrieve latest playlistJobId from key: ${latestJobIdKey}`
          )
        );
        return {
          success: false,
          error: 'Could not find pending playlist job ID. Please try again.',
        };
      }

      // Clean up the fixed job ID key
      await this.cache.del(latestJobIdKey);

      // Get the client ID and secret
      const clientId = process.env['SPOTIFY_CLIENT_ID'];
      const clientSecret = process.env['SPOTIFY_CLIENT_SECRET'];
      // Use the exact redirect URI that was registered with Spotify
      const redirectUri =
        process.env['SPOTIFY_REDIRECT_URI'] ||
        'http://localhost:3004/hitlist/spotify-callback';

      if (!clientId || !clientSecret) {
        this.logger.log(color.red.bold('Missing Spotify API credentials'));
        return { success: false, error: 'Missing Spotify API credentials' };
      }

      // NOTE: The logic below attempts to reuse existing tokens if available.
      // This might be unexpected if the user explicitly went through the auth flow again.
      // --- Use Settings class for tokens ---
      const accessToken = await this.settings.getSetting(
        'spotify_access_token'
      );
      const refreshToken = await this.settings.getSetting(
        'spotify_refresh_token'
      );
      const expiresAtStr = await this.settings.getSetting(
        'spotify_token_expires_at'
      );
      const expiresAt = expiresAtStr ? parseInt(expiresAtStr, 10) : 0;

      // Check if access token is valid and not expired
      if (accessToken && Date.now() < expiresAt) {
        this.logger.log(
          color.blue(
            'Using existing valid Spotify access token from DB during callback.'
          )
        );
        // Pass the retrieved playlistJobId
        return this.createPlaylistWithToken(accessToken, playlistJobId);
      }

      // If access token is invalid/expired, try using the refresh token
      if (refreshToken) {
        this.logger.log(
          color.blue(
            'Spotify access token expired or invalid during callback, attempting refresh...'
          )
        );
        try {
          // Try to get a new access token using the refresh token
          const refreshResponse = await axios({
            method: 'post',
            url: 'https://accounts.spotify.com/api/token',
            headers: {
              'Content-Type': 'application/x-www-form-urlencoded',
              Authorization:
                'Basic ' +
                Buffer.from(clientId + ':' + clientSecret).toString('base64'),
            },
            data: new URLSearchParams({
              grant_type: 'refresh_token',
              refresh_token: refreshToken,
            }).toString(),
          });

          if (refreshResponse.data.access_token) {
            const newAccessToken = refreshResponse.data.access_token;
            const newRefreshToken = refreshResponse.data.refresh_token; // Spotify might return a new refresh token
            const expiresIn = refreshResponse.data.expires_in || 3600;
            const newExpiresAt = Date.now() + (expiresIn - 60) * 1000; // Calculate expiry in ms

            // Store the new tokens and expiry time in the database
            await this.settings.setSetting(
              'spotify_access_token',
              newAccessToken
            );
            await this.settings.setSetting(
              'spotify_token_expires_at',
              newExpiresAt.toString()
            );
            if (newRefreshToken) {
              await this.settings.setSetting(
                'spotify_refresh_token',
                newRefreshToken
              );
              this.logger.log(
                color.blue(
                  'Stored new Spotify refresh token during callback refresh.'
                )
              );
            } else {
              this.logger.log(
                color.blue(
                  'Re-using existing Spotify refresh token during callback refresh.'
                )
              );
            }

            this.logger.log(
              color.green(
                'Successfully refreshed Spotify token during callback.'
              )
            );
            // Pass the retrieved playlistJobId
            return this.createPlaylistWithToken(newAccessToken, playlistJobId);
          }
        } catch (error) {
          this.logger.log(
            color.yellow.bold(
              `Error refreshing token, will try with auth code: ${error}`
            )
          );
          // Continue with the auth code flow if refresh token failed
        }
      }

      // If refresh failed or no refresh token, use the auth code provided

      if (!authCode) {
        this.logger.log(
          color.red.bold(
            'No auth code provided and refresh failed/unavailable.'
          )
        );
        return { success: false, error: 'Authorization code missing' };
      }

      // Exchange the authorization code for an access token
      const tokenResponse = await axios({
        method: 'post',
        url: 'https://accounts.spotify.com/api/token',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization:
            'Basic ' +
            Buffer.from(clientId + ':' + clientSecret).toString('base64'),
        },
        data: new URLSearchParams({
          grant_type: 'authorization_code',
          code: authCode,
          redirect_uri: redirectUri,
        }).toString(),
      });

      // Rename this variable to avoid conflict
      const accessTokenFromAuthCode = tokenResponse.data.access_token;
      const newRefreshToken = tokenResponse.data.refresh_token;
      const expiresIn = tokenResponse.data.expires_in || 3600;
      // Calculate expiry time based on expiresIn
      const receivedExpiresAt = Date.now() + (expiresIn - 60) * 1000;

      if (!accessTokenFromAuthCode) {
        this.logger.log(
          color.red.bold('Failed to get Spotify access token from auth code')
        );
        return {
          success: false,
          error: 'Failed to get Spotify access token from auth code',
        };
      }

      // Store the new tokens and expiry time in the database
      await this.settings.setSetting(
        'spotify_access_token',
        accessTokenFromAuthCode
      );
      await this.settings.setSetting(
        'spotify_token_expires_at',
        receivedExpiresAt.toString()
      );
      if (newRefreshToken) {
        await this.settings.setSetting(
          'spotify_refresh_token',
          newRefreshToken
        );
      } else {
        this.logger.log(
          color.yellow('No refresh token received from auth code grant.')
        );
        // Consider deleting the old refresh token if one existed? Or keep it?
        // await this.settings.deleteSetting('spotify_refresh_token');
      }

      this.logger.log(
        color.green.bold(
          'Successfully obtained Spotify tokens using auth code.'
        )
      );
      // Pass the retrieved playlistJobId and the newly obtained token
      return this.createPlaylistWithToken(
        accessTokenFromAuthCode,
        playlistJobId
      );
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error completing Spotify authorization: ${error}`)
      );
      return {
        success: false,
        error: 'Error completing Spotify authorization',
      };
    }
  }

  /**
   * Creates a playlist using an existing access token
   * Creates a playlist using an existing access token and a specific job ID
   * @param accessToken Spotify access token
   * @param playlistJobId The unique ID for this playlist creation job
   * @returns Object with success status and playlist data
   */
  private async createPlaylistWithToken(
    accessToken: string,
    playlistJobId: string
  ): Promise<any> {
    const playlistInfoKey = `pending_playlist_info:${playlistJobId}`;
    try {
      // Get the pending playlist info from cache using the job ID
      const pendingPlaylistInfoStr = await this.cache.get(playlistInfoKey);
      if (!pendingPlaylistInfoStr) {
        this.logger.log(
          color.red.bold(
            `No pending playlist information found for key: ${playlistInfoKey}`
          )
        );
        return {
          success: false,
          error: 'No pending playlist information found',
        };
      }

      const pendingPlaylistInfo = JSON.parse(pendingPlaylistInfoStr);
      const { companyName, listName, trackIds } = pendingPlaylistInfo;

      // Create a new playlist
      const playlistName = `${companyName} - ${listName}`;
      const playlistDescription = `Top tracks for ${companyName} - ${listName}. Created automatically.`;

      // Get the user profile to get the user ID
      const profileResponse = await axios({
        method: 'get',
        url: 'https://api.spotify.com/v1/me',
        headers: {
          Authorization: `Bearer ${accessToken!}`, // Added non-null assertion
        },
      });

      const userId = profileResponse.data.id;

      // --- Check for existing playlist ---
      let existingPlaylistId: string | null = null;
      let playlistUrl: string | null = null;
      const maxPlaylistsToCheck = 50; // Spotify API limit per request

      try {
        const userPlaylistsResponse = await axios({
          method: 'get',
          url: `https://api.spotify.com/v1/users/${userId}/playlists?limit=${maxPlaylistsToCheck}`,
          headers: {
            Authorization: `Bearer ${accessToken!}`, // Added non-null assertion
          },
        });

        const userPlaylists = userPlaylistsResponse.data.items;
        const foundPlaylist = userPlaylists.find(
          (p: any) => p.name === playlistName && p.owner.id === userId // Ensure correct owner
        );

        if (foundPlaylist) {
          existingPlaylistId = foundPlaylist.id;
          playlistUrl = foundPlaylist.external_urls.spotify;
          this.logger.log(
            color.blue.bold(
              `Found existing playlist "${color.white.bold(
                playlistName
              )}" with ID ${color.white.bold(
                existingPlaylistId
              )}. Will update tracks.`
            )
          );
        }
      } catch (playlistFetchError) {
        this.logger.log(
          color.yellow.bold(
            `Could not fetch user playlists to check for existing one: ${playlistFetchError}`
          )
        );
        // Continue to create a new playlist if fetching fails
      }
      // --- End Check for existing playlist ---

      let playlistId: string;

      if (existingPlaylistId) {
        playlistId = existingPlaylistId;
        // Replace tracks in the existing playlist
        const trackUris = trackIds.map((id: string) => `spotify:track:${id}`);

        // Spotify API for replacing tracks handles pagination internally if needed,
        // but it's better to chunk if trackIds > 100 for the PUT request body.
        const chunkSize = 100;
        for (let i = 0; i < trackUris.length; i += chunkSize) {
          const chunk = trackUris.slice(i, i + chunkSize);
          const method = i === 0 ? 'put' : 'post'; // First chunk replaces, subsequent chunks add

          await axios({
            method: method,
            url: `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            data: JSON.stringify({
              uris: chunk,
            }),
          });
        }
        this.logger.log(
          color.green.bold(
            `Updated tracks in existing Spotify playlist "${color.white.bold(
              playlistName
            )}"`
          )
        );
      } else {
        // Create a new playlist if none found
        this.logger.log(
          color.blue.bold(
            `No existing playlist found named "${color.white.bold(
              playlistName
            )}". Creating new playlist.`
          )
        );
        const createPlaylistResponse = await axios({
          method: 'post',
          url: `https://api.spotify.com/v1/users/${userId}/playlists`,
          headers: {
            Authorization: `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
          },
          data: JSON.stringify({
            name: playlistName,
            description: playlistDescription,
            public: true,
          }),
        });

        playlistId = createPlaylistResponse.data.id;
        playlistUrl = createPlaylistResponse.data.external_urls.spotify;

        if (!playlistId) {
          this.logger.log(color.red.bold('Failed to create Spotify playlist'));
          // Ensure cache key is deleted even if creation fails here
          await this.cache.del(playlistInfoKey);
          return { success: false, error: 'Failed to create Spotify playlist' };
        }

        // Add tracks to the newly created playlist (maximum 100 tracks per request)
        const trackUris = trackIds.map((id: string) => `spotify:track:${id}`);
        const chunkSize = 100;
        for (let i = 0; i < trackUris.length; i += chunkSize) {
          const chunk = trackUris.slice(i, i + chunkSize);

          await axios({
            method: 'post',
            url: `https://api.spotify.com/v1/playlists/${playlistId}/tracks`,
            headers: {
              Authorization: `Bearer ${accessToken}`,
              'Content-Type': 'application/json',
            },
            data: JSON.stringify({
              uris: chunk,
            }),
          });
        }

        this.logger.log(
          color.green.bold(
            `Created new Spotify playlist "${color.white.bold(
              playlistName
            )}" with ${color.white.bold(trackIds.length)} tracks`
          )
        );
      }

      // Clear the pending playlist info using the specific key
      await this.cache.del(playlistInfoKey);

      return {
        success: true,
        data: {
          playlistId,
          playlistUrl,
          playlistName,
        },
      };
    } catch (error) {
      // Ensure the cache key is deleted even if playlist creation/update fails mid-way
      await this.cache.del(playlistInfoKey);
      this.logger.log(
        color.red.bold(
          `Error creating/updating playlist with token for job ${playlistJobId}: ${error}`
        )
      );
      // Check if the error is from Spotify API (e.g., invalid token - 401 Unauthorized)
      if (axios.isAxiosError(error) && error.response?.status === 401) {
        this.logger.log(
          color.yellow(
            'Spotify API returned 401 Unauthorized. Clearing potentially invalid access token from DB.'
          )
        );
        // Clear potentially invalid access token and its expiry from DB
        await this.settings.deleteSetting('spotify_access_token');
        await this.settings.deleteSetting('spotify_token_expires_at');
        // Do NOT delete the refresh token here, as it might still be valid for the next attempt
        return {
          success: false,
          error: 'Spotify authorization error (token likely expired/invalid)',
          needsReAuth: true, // Indicate re-authorization might be needed
        };
      }
      // For other errors, return a generic message
      return {
        success: false,
        error: 'Error creating/updating Spotify playlist with token',
      };
    }
  }

  /**
   * Retrieves playlist information from the Spotify API.
   * Retrieves playlist information from the Spotify API. Matches signature of spotify.ts getPlaylist.
   * NOTE: cache, captcha parameters are ignored in this implementation.
   * @param playlistId The Spotify ID or slug.
   * @param cache Ignored.
   * @param captchaToken Ignored.
   * @param checkCaptcha Ignored.
   * @param featured If true, attempts to fetch name/description override from the database based on locale.
   * @param isSlug If true, treats playlistId as a slug for database lookup.
   * @param locale The locale to use for featured playlist name/description overrides (e.g., 'en', 'nl'). Defaults to 'en'.
   * @returns Object with success status and playlist data or error.
   */
  public async getPlaylist(
    playlistId: string,
    cache: boolean = true, // Ignored
    captchaToken: string = '', // Ignored
    checkCaptcha: boolean = false, // Ignored
    featured: boolean = false, // Now used
    isSlug: boolean = false, // Now used
    locale: string = 'en' // Now used
  ): Promise<any> {
    try {
      // Validate locale
      if (!this.translation.isValidLocale(locale)) {
        locale = 'en'; // Default to 'en' if invalid
      }

      if (!playlistId) {
        return { success: false, error: 'Playlist ID is required' };
      }

      // --- Handle Slug ---
      let checkPlaylistId = playlistId;
      if (isSlug) {
        const dbPlaylist = await this.prisma.playlist.findFirst({
          where: { slug: playlistId },
          select: { playlistId: true }, // Only select the ID we need
        });
        if (!dbPlaylist || !dbPlaylist.playlistId) {
          return { success: false, error: 'playlistNotFound' };
        }
        checkPlaylistId = dbPlaylist.playlistId;
      }
      // --- End Handle Slug ---

      // --- Get Spotify Token ---
      // Reusing token logic similar to createPlaylist
      const clientId = process.env['SPOTIFY_CLIENT_ID'];
      const clientSecret = process.env['SPOTIFY_CLIENT_SECRET'];
      if (!clientId || !clientSecret) {
        this.logger.log(color.red.bold('Missing Spotify API credentials'));
        return { success: false, error: 'Missing Spotify API credentials' };
      }

      let accessToken = await this.settings.getSetting('spotify_access_token');
      const refreshToken = await this.settings.getSetting(
        'spotify_refresh_token'
      );
      const expiresAtStr = await this.settings.getSetting(
        'spotify_token_expires_at'
      );
      const expiresAt = expiresAtStr ? parseInt(expiresAtStr, 10) : 0;

      // Check if access token is valid and not expired
      if (!accessToken || Date.now() >= expiresAt) {
        if (refreshToken) {
          this.logger.log(
            color.blue.bold(
              'Spotify access token expired or invalid, attempting refresh...'
            )
          );
          try {
            const refreshResponse = await axios({
              method: 'post',
              url: 'https://accounts.spotify.com/api/token',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization:
                  'Basic ' +
                  Buffer.from(clientId + ':' + clientSecret).toString('base64'),
              },
              data: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
              }).toString(),
            });

            if (refreshResponse.data.access_token) {
              accessToken = refreshResponse.data.access_token;
              const newRefreshToken = refreshResponse.data.refresh_token;
              const expiresIn = refreshResponse.data.expires_in || 3600;
              const newExpiresAt = Date.now() + (expiresIn - 60) * 1000;

              await this.settings.setSetting(
                'spotify_access_token',
                accessToken! // Added non-null assertion
              );
              await this.settings.setSetting(
                'spotify_token_expires_at',
                newExpiresAt.toString()
              );
              if (newRefreshToken) {
                await this.settings.setSetting(
                  'spotify_refresh_token',
                  newRefreshToken
                );
              }
              this.logger.log(
                color.green.bold('Successfully refreshed Spotify token.')
              );
            } else {
              // Refresh failed, need authorization
              accessToken = null; // Ensure token is null
            }
          } catch (refreshError) {
            this.logger.log(
              color.yellow.bold(`Error refreshing token: ${refreshError}`)
            );
            accessToken = null; // Ensure token is null
          }
        } else {
          // No refresh token available
          accessToken = null;
        }
      }

      if (!accessToken) {
        this.logger.log(
          color.red.bold(
            'Could not obtain a valid Spotify access token. Authorization might be required.'
          )
        );
        return {
          success: false,
          error: 'Could not obtain valid Spotify token',
          needsReAuth: true,
        };
      }
      // --- End Get Spotify Token ---

      // --- Call Spotify API ---
      try {
        const response = await axios({
          method: 'get',
          // Use checkPlaylistId which contains either the original ID or the one found via slug
          url: `https://api.spotify.com/v1/playlists/${checkPlaylistId}`,
          headers: {
            Authorization: `Bearer ${accessToken!}`, // Re-added non-null assertion
          },
        });

        let playlistName = response.data.name;
        let playlistDescription = response.data.description;

        // If featured, try to get name/description override from DB
        if (featured) {
          // Use the original playlistId if it was a slug, or checkPlaylistId if it wasn't
          const idToQuery = isSlug ? playlistId : checkPlaylistId;
          const dbPlaylist = await this.prisma.playlist.findFirst({
            where: {
              // Query by slug if isSlug is true, otherwise by playlistId
              ...(isSlug ? { slug: idToQuery } : { playlistId: idToQuery }),
            },
            // Select the base name and the localized description
            select: {
              name: true,
              [`description_${locale}`]: true, // Dynamically select based on locale
            },
          });

          if (dbPlaylist) {
            playlistName = dbPlaylist.name || playlistName; // Override name if found in DB
            // Override description if localized description exists in DB
            const localizedDescription = (dbPlaylist as any)[
              `description_${locale}`
            ];
            playlistDescription = localizedDescription || playlistDescription;
          } else {
            this.logger.log(
              color.yellow(
                `Featured playlist with ID/Slug "${idToQuery}" not found in DB for override.`
              )
            );
          }
        }

        // Return data matching spotify.ts getPlaylist structure
        const playlistData = {
          id: checkPlaylistId, // Use the potentially translated ID
          playlistId: response.data.id, // Store the actual Spotify ID here
          name: playlistName, // Use potentially overridden name
          description: playlistDescription, // Use potentially overridden description
          numberOfTracks: response.data.tracks.total,
          image: response.data.images?.[0]?.url || '', // Match 'image' field name
        };

        return {
          success: true,
          data: playlistData,
        };
      } catch (apiError) {
        if (axios.isAxiosError(apiError) && apiError.response) {
          if (apiError.response.status === 401) {
            // Token might have just expired or become invalid
            this.logger.log(
              color.yellow(
                'Spotify API returned 401 Unauthorized when fetching playlist. Clearing token.'
              )
            );
            await this.settings.deleteSetting('spotify_access_token');
            await this.settings.deleteSetting('spotify_token_expires_at');
            return {
              success: false,
              error: 'Spotify authorization error (token likely expired)',
              needsReAuth: true,
            };
          } else if (apiError.response.status === 404) {
            return { success: false, error: 'Playlist not found' };
          } else {
            this.logger.log(
              color.red.bold(
                `Spotify API error fetching playlist ${playlistId}: ${apiError.response.status} - ${apiError.message}`
              )
            );
            return {
              success: false,
              error: `Spotify API error: ${apiError.response.status}`,
            };
          }
        } else {
          // Network or other errors
          this.logger.log(
            color.red.bold(
              `Error fetching playlist ${playlistId} from Spotify: ${apiError}`
            )
          );
          throw apiError; // Re-throw unexpected errors
        }
      }
      // --- End Call Spotify API ---
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error getting Spotify playlist info: ${error}`)
      );
      return {
        success: false,
        error: 'Internal server error getting playlist info',
      };
    }
  }

  /**
   * Retrieves all tracks from a specific Spotify playlist, handling pagination. Matches signature of spotify.ts getTracks.
   * NOTE: cache, captcha, isSlug parameters are ignored in this implementation.
   * @param playlistId The Spotify ID or potentially slug (though slug lookup is not implemented here).
   * @param cache Ignored.
   * @param captchaToken Ignored.
   * @param checkCaptcha Ignored.
   * @param isSlug Ignored (assumes playlistId is Spotify ID).
   * @returns Object with success status and an array of all tracks or error.
   */
  public async getTracks(
    playlistId: string,
    cache: boolean = true, // Ignored
    captchaToken: string = '', // Ignored
    checkCaptcha: boolean = false, // Ignored
    isSlug: boolean = false // Ignored
  ): Promise<any> {
    try {
      if (!playlistId) {
        return { success: false, error: 'Playlist ID is required' };
      }

      // --- Handle Slug ---
      let checkPlaylistId = playlistId;
      if (isSlug) {
        const dbPlaylist = await this.prisma.playlist.findFirst({
          where: { slug: playlistId },
          select: { playlistId: true }, // Only select the ID we need
        });
        if (!dbPlaylist || !dbPlaylist.playlistId) {
          // Match error message from spotify.ts
          return { success: false, error: 'playlistNotFound' };
        }
        checkPlaylistId = dbPlaylist.playlistId;
      }
      // --- End Handle Slug ---

      // --- Get Spotify Token (Reused Logic) ---
      const clientId = process.env['SPOTIFY_CLIENT_ID'];
      const clientSecret = process.env['SPOTIFY_CLIENT_SECRET'];
      if (!clientId || !clientSecret) {
        this.logger.log(color.red.bold('Missing Spotify API credentials'));
        return { success: false, error: 'Missing Spotify API credentials' };
      }

      let accessToken = await this.settings.getSetting('spotify_access_token');
      const refreshToken = await this.settings.getSetting(
        'spotify_refresh_token'
      );
      const expiresAtStr = await this.settings.getSetting(
        'spotify_token_expires_at'
      );
      const expiresAt = expiresAtStr ? parseInt(expiresAtStr, 10) : 0;

      if (!accessToken || Date.now() >= expiresAt) {
        if (refreshToken) {
          this.logger.log(
            color.blue.bold(
              'Spotify access token expired/invalid for tracks, attempting refresh...'
            )
          );
          try {
            const refreshResponse = await axios({
              method: 'post',
              url: 'https://accounts.spotify.com/api/token',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                Authorization:
                  'Basic ' +
                  Buffer.from(clientId + ':' + clientSecret).toString('base64'),
              },
              data: new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: refreshToken,
              }).toString(),
            });

            if (refreshResponse.data.access_token) {
              accessToken = refreshResponse.data.access_token;
              const newRefreshToken = refreshResponse.data.refresh_token;
              const expiresIn = refreshResponse.data.expires_in || 3600;
              const newExpiresAt = Date.now() + (expiresIn - 60) * 1000;

              await this.settings.setSetting(
                'spotify_access_token',
                accessToken! // Added non-null assertion
              );
              await this.settings.setSetting(
                'spotify_token_expires_at',
                newExpiresAt.toString()
              );
              if (newRefreshToken) {
                await this.settings.setSetting(
                  'spotify_refresh_token',
                  newRefreshToken
                );
              }
              this.logger.log(
                color.green.bold(
                  'Successfully refreshed Spotify token for tracks.'
                )
              );
            } else {
              accessToken = null;
            }
          } catch (refreshError) {
            this.logger.log(
              color.yellow.bold(
                `Error refreshing token for tracks: ${refreshError}`
              )
            );
            accessToken = null;
          }
        } else {
          accessToken = null;
        }
      }

      if (!accessToken) {
        this.logger.log(
          color.red.bold(
            'Could not obtain valid Spotify token for tracks. Authorization might be required.'
          )
        );
        return {
          success: false,
          error: 'Could not obtain valid Spotify token',
          needsReAuth: true,
        };
      }
      // --- End Get Spotify Token ---

      // --- Call Spotify API with Pagination ---
      let allTracks: any[] = [];
      let nextUrl:
        | string
        // Use checkPlaylistId which contains either the original ID or the one found via slug
        | null = `https://api.spotify.com/v1/playlists/${checkPlaylistId}/tracks?limit=100`; // Start with limit 100

      while (nextUrl) {
        try {
          // Add type annotation and non-null assertion
          const response: AxiosResponse<any> = await axios({
            method: 'get',
            url: nextUrl,
            headers: {
              Authorization: `Bearer ${accessToken!}`, // Re-added non-null assertion
            },
          });

          const items = response.data.items || [];

          // --- Start DB Lookup for Overrides (like spotify.ts) ---
          const trackIds = items
            .filter((item: any) => item.track?.id)
            .map((item: any) => item.track.id);

          let yearResults: {
            trackId: string;
            year: number;
            name: string;
            artist: string;
            extraNameAttribute?: string;
            extraArtistAttribute?: string;
          }[] = [];

          if (trackIds.length > 0) {
            // Get the internal DB ID for the playlist (needed for trackextrainfo join)
            const dbPlaylist = await this.prisma.playlist.findFirst({
              where: { playlistId: checkPlaylistId }, // Use the potentially slug-translated ID
              select: { id: true },
            });

            if (dbPlaylist) {
              // Query similar to spotify.ts
              yearResults = await this.prisma.$queryRaw<
                {
                  trackId: string;
                  year: number;
                  name: string;
                  artist: string;
                  extraNameAttribute?: string;
                  extraArtistAttribute?: string;
                }[]
              >`
                SELECT
                  t.trackId,
                  t.year,
                  t.artist,
                  t.name,
                  tei.extraNameAttribute,
                  tei.extraArtistAttribute
                FROM
                  tracks t
                LEFT JOIN
                  (SELECT * FROM trackextrainfo WHERE playlistId = ${
                    dbPlaylist.id
                  }) tei
                  ON t.id = tei.trackId
                WHERE
                  t.trackId IN (${Prisma.join(trackIds)})
                  AND t.manuallyChecked = 1
              `;
            } else {
              // Fallback if playlist not in DB (less likely here but good practice)
              yearResults = await this.prisma.$queryRaw<
                {
                  trackId: string;
                  year: number;
                  name: string;
                  artist: string;
                  extraNameAttribute?: string;
                  extraArtistAttribute?: string;
                }[]
              >`
                SELECT
                  t.trackId,
                  t.year,
                  t.artist,
                  t.name,
                  NULL as extraNameAttribute,
                  NULL as extraArtistAttribute
                FROM
                  tracks t
                WHERE
                  t.trackId IN (${Prisma.join(trackIds)})
                  AND t.manuallyChecked = 1
              `;
            }
          }

          // Create a map for quick lookup
          const trackMap = new Map(
            yearResults.map((r) => [
              r.trackId,
              {
                year: r.year,
                name: r.name,
                artist: r.artist,
                extraNameAttribute: r.extraNameAttribute,
                extraArtistAttribute: r.extraArtistAttribute,
              },
            ])
          );

          // Cache results like in spotify.ts
          await Promise.all(
            yearResults
              .filter((r) => r.year !== null)
              .map((r) =>
                this.cache.set(
                  `trackInfo2_${r.trackId}`,
                  JSON.stringify({
                    year: r.year,
                    name: r.name,
                    artist: r.artist,
                    extraNameAttribute: r.extraNameAttribute,
                    extraArtistAttribute: r.extraArtistAttribute,
                  })
                  // Consider adding a TTL (e.g., 3600 for 1 hour) if desired
                  // this.cache.set(`trackInfo2_${r.trackId}`, JSON.stringify({...}), 3600);
                )
              )
          );
          // --- End DB Lookup ---

          // --- Map Tracks with Overrides ---
          const mappedTracks = await Promise.all(
            items
              .filter((item: any) => item.track && item.track.id) // Ensure track data exists
              .map(async (item: any) => {
                const track = item.track;
                const trackId = track.id;
                let trueYear: number | undefined;
                let extraNameAttribute: string | undefined;
                let extraArtistAttribute: string | undefined;
                let trueName: string | undefined;
                let trueArtist: string | undefined;

                // Check cache first
                const cachedTrackInfo = await this.cache.get(
                  `trackInfo2_${trackId}`
                );
                if (cachedTrackInfo) {
                  const trackInfo = JSON.parse(cachedTrackInfo);
                  trueYear = trackInfo.year;
                  trueName = trackInfo.name;
                  trueArtist = trackInfo.artist;
                  extraNameAttribute = trackInfo.extraNameAttribute;
                  extraArtistAttribute = trackInfo.extraArtistAttribute;
                } else {
                  // Check DB results map if not cached
                  const trackInfo = trackMap.get(trackId);
                  if (trackInfo) {
                    trueYear = trackInfo.year;
                    trueName = trackInfo.name;
                    trueArtist = trackInfo.artist;
                    extraNameAttribute = trackInfo.extraNameAttribute;
                    extraArtistAttribute = trackInfo.extraArtistAttribute;
                  }
                }

                // Fallback to API data if no override found
                if (trueName === undefined) {
                  trueName = track.name;
                }
                if (trueArtist === undefined) {
                  if (track.artists?.length > 0) {
                    if (track.artists.length === 1) {
                      trueArtist = track.artists[0].name;
                    } else {
                      // Max. 3 artists like in spotify.ts
                      const limitedArtists = track.artists.slice(0, 3);
                      const artistNames = limitedArtists.map(
                        (artist: { name: string }) => artist.name
                      );
                      const lastArtist = artistNames.pop();
                      trueArtist = artistNames.join(', ') + ' & ' + lastArtist;
                    }
                  }
                }

                // Format release date similar to spotify.ts
                let formattedReleaseDate = '';
                if (track.album?.release_date) {
                  try {
                    // Handle potential invalid date strings
                    const releaseDate = new Date(track.album.release_date);
                    if (!isNaN(releaseDate.getTime())) {
                      formattedReleaseDate = format(releaseDate, 'yyyy-MM-dd');
                    }
                  } catch (e) {
                    // Ignore date formatting errors
                  }
                }

                return {
                  id: trackId,
                  name: this.utils.cleanTrackName(trueName || ''), // Use potentially overridden name
                  album: this.utils.cleanTrackName(track.album?.name || ''),
                  preview: track.preview_url || '',
                  artist: trueArtist, // Use potentially overridden artist
                  link: track.external_urls?.spotify,
                  isrc: track.external_ids?.isrc,
                  image: track.album?.images?.[1]?.url || null, // Use index 1 like spotify.ts
                  releaseDate: formattedReleaseDate,
                  trueYear, // Use year from DB if available
                  extraNameAttribute, // Use from DB if available
                  extraArtistAttribute, // Use from DB if available
                };
              })
          );
          // --- End Map Tracks ---

          const filteredTracks = mappedTracks.filter(
            (track: any) => track.artist && track.name && track.image // Filter like spotify.ts
          );

          allTracks = allTracks.concat(filteredTracks);

          nextUrl = response.data.next; // Get the URL for the next page
        } catch (apiError) {
          if (axios.isAxiosError(apiError) && apiError.response) {
            if (apiError.response.status === 401) {
              this.logger.log(
                color.yellow(
                  'Spotify API returned 401 Unauthorized when fetching tracks. Clearing token.'
                )
              );
              await this.settings.deleteSetting('spotify_access_token');
              await this.settings.deleteSetting('spotify_token_expires_at');
              return {
                success: false,
                error: 'Spotify authorization error (token likely expired)',
                needsReAuth: true,
              };
            } else if (apiError.response.status === 404) {
              return {
                success: false,
                // Use checkPlaylistId in error message for consistency
                error: 'Playlist not found when fetching tracks',
              };
            } else {
              this.logger.log(
                color.red.bold(
                  `Spotify API error fetching tracks for ${checkPlaylistId}: ${apiError.response.status} - ${apiError.message}`
                )
              );
              return {
                success: false,
                error: `Spotify API error: ${apiError.response.status}`,
              };
            }
          } else {
            this.logger.log(
              color.red.bold(
                // Use checkPlaylistId in error message for consistency
                `Error fetching tracks for ${checkPlaylistId} from Spotify: ${apiError}`
              )
            );
            throw apiError; // Re-throw unexpected errors
          }
        }
      }
      // --- End Call Spotify API ---

      // Structure the return data like spotify.ts getTracks
      const resultData = {
        maxReached: false, // This implementation fetches all tracks, so never reached
        maxReachedPhysical: false, // Same as above
        totalTracks: allTracks.length,
        tracks: allTracks,
      };

      return {
        success: true,
        data: resultData,
      };
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error getting Spotify playlist tracks: ${error}`)
      );
      return {
        success: false,
        error: 'Internal server error getting playlist tracks',
      };
    }
  }

  public async searchTracks(searchString: string) {
    try {
      if (!searchString || searchString.length < 2) {
        return { success: false, error: 'Search string too short' };
      }

      console.log(111);

      // Use Spotify search instead of database search
      const spotify = new Spotify();
      const spotifyResult = await this.spotify.searchTracks(searchString);

      if (!spotifyResult.success) {
        return spotifyResult;
      }

      // Transform the Spotify search results to match the expected format
      // Based on the JSON structure from the error, we need to extract data differently
      const tracks = spotifyResult.data?.tracks?.items
        ? spotifyResult.data.tracks.items
            .filter((item: any) => item && item.data && item.data.id) // Filter out any empty data items
            .map((item: any) => {
              const track = item.data;
              const artistName = track.artists?.items?.[0]?.profile?.name || '';
              const trackName = track.name || '';

              return {
                id: track.id,
                trackId: track.id, // Use the Spotify track ID
                name: trackName,
                artist: artistName,
              };
            })
            .filter((track: any) => track.name && track.artist) // Filter out tracks with empty name or artist
        : [];

      return {
        success: true,
        data: tracks,
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error searching tracks: ${error}`));
      return { success: false, error: 'Error searching tracks' };
    }
  }
}

export default Hitlist;
