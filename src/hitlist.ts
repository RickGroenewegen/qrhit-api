import PrismaInstance from './prisma';
import Logger from './logger';
import { color } from 'console-log-colors';
import Cache from './cache';
import Utils from './utils';
import Spotify from './spotify';
import { Music } from './music';
import Data from './data';
import Mail from './mail';
import axios from 'axios';

class Hitlist {
  private static instance: Hitlist;
  private prisma = PrismaInstance.getInstance();
  private logger = new Logger();
  private cache = Cache.getInstance();
  private utils = new Utils();
  private music: Music = new Music();
  private data = Data.getInstance();
  private mail = Mail.getInstance();

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

      // Get company information for the email
      const companyList = await this.prisma.companyList.findUnique({
        where: { id: parseInt(companyListId) },
        include: { Company: true },
      });

      if (!companyList) {
        return {
          success: false,
          error: 'Company list not found',
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
          // companyList.domain!, // Removed domain as it doesn't exist on CompanyList
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
      // Extract track IDs from the hitlist
      const trackIds = hitlist.map((track: any) => track.trackId);

      // Use the new getTracksByIds method to get detailed track information
      const spotify = new Spotify();
      const data = Data.getInstance();
      const tracksResult = await spotify.getTracksByIds(trackIds);

      if (tracksResult.success && tracksResult.data) {
        // Array to store newly created track IDs
        const newTrackIds: string[] = [];
        const trackDbIds: Map<string, number> = new Map(); // Map to store trackId -> DB id

        this.logger.log(
          color.blue.bold(
            `Received hitlist with ${color.white.bold(hitlist.length)} tracks`
          )
        );

        // Store tracks in the database
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

        // Create CompanyListSubmissionTrack entries for each track
        for (const track of hitlist) {
          const trackDbId = trackDbIds.get(track.trackId);

          if (trackDbId) {
            await this.prisma.companyListSubmissionTrack.create({
              data: {
                companyListSubmissionId: submissionId,
                trackId: trackDbId,
                position: track.position,
              },
            });
          }
        }

        this.logger.log(
          color.green.bold(
            `Created ${color.white.bold(
              hitlist.length
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

      if (submissions.length === 0) {
        return {
          success: false,
          error: 'No verified submissions found for this company list',
        };
      }

      // Create a map to count votes by artist + title combination
      const voteMap = new Map<
        string,
        {
          count: number;
          trackId: number;
          spotifyTrackId: string;
          artist: string;
          title: string;
          firstSubmissionDate: Date;
        }
      >();

      // Loop through all submissions and count votes
      for (const submission of submissions) {
        for (const submissionTrack of submission.CompanyListSubmissionTrack) {
          const track = submissionTrack.Track;
          const key = `${track.artist.toLowerCase()}|${track.name.toLowerCase()}`;

          if (voteMap.has(key)) {
            // Increment the count for this track
            const trackData = voteMap.get(key)!;
            trackData.count += 1;
          } else {
            // First vote for this track
            voteMap.set(key, {
              count: 1,
              trackId: track.id,
              spotifyTrackId: track.trackId,
              artist: track.artist,
              title: track.name,
              firstSubmissionDate: submission.createdAt,
            });
          }
        }
      }

      // Convert the map to an array and sort by vote count (descending)
      // and then by submission date (ascending) for ties
      const sortedTracks = Array.from(voteMap.values()).sort((a, b) => {
        if (b.count !== a.count) {
          return b.count - a.count; // Sort by count descending
        }
        // If counts are equal, sort by submission date (earlier first)
        return (
          a.firstSubmissionDate.getTime() - b.firstSubmissionDate.getTime()
        );
      });

      // Use numberOfCards from companyList if it's set, otherwise default to 10
      const maxTracks =
        companyList.numberOfCards > 0 ? companyList.numberOfCards : 10;

      // Take the top tracks based on numberOfCards (or less if there aren't enough)
      const topTracks = sortedTracks.slice(
        0,
        Math.min(maxTracks, sortedTracks.length)
      );

      this.logger.log(
        color.blue.bold(
          `Finalized list for company ${color.white.bold(
            companyList.Company.name
          )} with ${color.white.bold(
            topTracks.length
          )} tracks (max: ${color.white.bold(maxTracks)})`
        )
      );

      // Create a Spotify playlist with the top tracks
      const playlistResult = await this.createPlaylist(
        companyList.Company.name,
        companyList.name,
        topTracks.map((track) => track.spotifyTrackId)
      );

      return {
        success: true,
        data: {
          companyName: companyList.Company.name,
          companyListName: companyList.name,
          totalSubmissions: submissions.length,
          tracks: topTracks.map((track, index) => ({
            position: index + 1,
            trackId: track.trackId,
            spotifyTrackId: track.spotifyTrackId,
            artist: track.artist,
            title: track.title,
            votes: track.count,
          })),
          playlist: playlistResult.success ? playlistResult.data : null,
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
          Company: { // Keep selecting company name
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

      // Get Spotify API credentials from environment variables
      const clientId = process.env['SPOTIFY_CLIENT_ID'];
      const clientSecret = process.env['SPOTIFY_CLIENT_SECRET'];

      if (!clientId || !clientSecret) {
        this.logger.log(color.red.bold('Missing Spotify API credentials'));
        return { success: false, error: 'Missing Spotify API credentials' };
      }

      // Store the playlist info in cache for later use
      const playlistInfo = {
        companyName,
        listName,
        trackIds,
      };
      await this.cache.set(
        'pending_playlist_info',
        JSON.stringify(playlistInfo),
        3600
      );

      // Check if we already have a valid access token
      const cachedToken = await this.cache.get('spotify_access_token');
      if (cachedToken) {
        this.logger.log(color.blue.bold('Using cached Spotify access token'));
        return this.createPlaylistWithToken(cachedToken);
      }

      // Check if we have a refresh token
      const refreshToken = await this.cache.get('spotify_refresh_token');
      if (refreshToken) {
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
            // Store the new access token with expiration (default 1 hour)
            const expiresIn = refreshResponse.data.expires_in || 3600;
            await this.cache.set(
              'spotify_access_token',
              newAccessToken,
              expiresIn - 60
            ); // Subtract 60 seconds for safety

            // If a new refresh token was provided, store it too
            if (refreshResponse.data.refresh_token) {
              await this.cache.set(
                'spotify_refresh_token',
                refreshResponse.data.refresh_token
              );
            }

            this.logger.log(color.green.bold('Refreshed Spotify access token'));
            return this.createPlaylistWithToken(newAccessToken);
          }
        } catch (error) {
          this.logger.log(
            color.yellow.bold(`Error refreshing token: ${error}`)
          );
          // Continue with the authorization flow if refresh token failed
        }
      }

      // If we don't have a valid token or refresh failed, we need to authorize
      // Generate a random state for security
      const state = this.utils.generateRandomString(16);

      // Generate the authorization URL
      // Use the exact redirect URI that was registered with Spotify
      const redirectUri =
        process.env['SPOTIFY_REDIRECT_URI'] ||
        'http://localhost:3004/spotify_callback';
      const scope = 'playlist-modify-public';
      const authUrl = `https://accounts.spotify.com/authorize?client_id=${clientId}&response_type=code&redirect_uri=${encodeURIComponent(
        redirectUri
      )}&scope=${encodeURIComponent(scope)}&state=${state}`;

      // Log the URL to the console so the user can visit it
      this.logger.log(
        color.yellow.bold(
          'Please visit the following URL to authorize Spotify playlist creation:'
        )
      );
      this.logger.log(color.white.bold(authUrl));
      this.logger.log(
        color.yellow.bold(
          'After authorization, you will be redirected to a callback URL where the process will complete automatically.'
        )
      );

      return {
        success: false,
        error: 'Authorization required',
        message: 'Please check the server logs for the authorization URL',
        authUrl: authUrl,
      };
    } catch (error) {
      this.logger.log(
        color.red.bold(`Error creating Spotify playlist: ${error}`)
      );
      return { success: false, error: 'Error creating Spotify playlist' };
    }
  }

  public async completeSpotifyAuth(authCode: string): Promise<any> {
    try {
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

      // Check if we already have a valid access token
      const cachedToken = await this.cache.get('spotify_access_token');
      if (cachedToken) {
        this.logger.log(color.blue.bold('Using cached Spotify access token'));
        return this.createPlaylistWithToken(cachedToken);
      }

      // Check if we have a refresh token
      const refreshToken = await this.cache.get('spotify_refresh_token');
      if (refreshToken) {
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
            // Store the new access token with expiration (default 1 hour)
            const expiresIn = refreshResponse.data.expires_in || 3600;
            await this.cache.set(
              'spotify_access_token',
              newAccessToken,
              expiresIn - 60
            ); // Subtract 60 seconds for safety

            // If a new refresh token was provided, store it too
            if (refreshResponse.data.refresh_token) {
              await this.cache.set(
                'spotify_refresh_token',
                refreshResponse.data.refresh_token
              );
            }

            this.logger.log(color.blue.bold('Refreshed Spotify access token'));
            return this.createPlaylistWithToken(newAccessToken);
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

      // If we don't have a valid token or refresh failed, use the auth code
      if (!authCode) {
        this.logger.log(
          color.red.bold('No auth code provided and no valid tokens available')
        );
        return { success: false, error: 'Authorization required' };
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

      const accessToken = tokenResponse.data.access_token;
      const newRefreshToken = tokenResponse.data.refresh_token;
      const expiresIn = tokenResponse.data.expires_in || 3600;

      if (!accessToken) {
        this.logger.log(color.red.bold('Failed to get Spotify access token'));
        return { success: false, error: 'Failed to get Spotify access token' };
      }

      // Store the tokens
      await this.cache.set('spotify_access_token', accessToken, expiresIn - 60); // Subtract 60 seconds for safety
      if (newRefreshToken) {
        await this.cache.set('spotify_refresh_token', newRefreshToken);
      }

      return this.createPlaylistWithToken(accessToken);
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
   * @param accessToken Spotify access token
   * @returns Object with success status and playlist data
   */
  private async createPlaylistWithToken(accessToken: string): Promise<any> {
    try {
      // Get the pending playlist info from cache
      const pendingPlaylistInfoStr = await this.cache.get(
        'pending_playlist_info'
      );
      if (!pendingPlaylistInfoStr) {
        this.logger.log(
          color.red.bold('No pending playlist information found')
        );
        return {
          success: false,
          error: 'No pending playlist information found',
        };
      }

      const pendingPlaylistInfo = JSON.parse(pendingPlaylistInfoStr);
      const { companyName, listName, trackIds } = pendingPlaylistInfo;

      // Create a new playlist
      const playlistName = `${companyName} - ${listName} Top Tracks`;
      const playlistDescription = `Top tracks for ${companyName} - ${listName}. Created automatically.`;

      // Get the user profile to get the user ID
      const profileResponse = await axios({
        method: 'get',
        url: 'https://api.spotify.com/v1/me',
        headers: {
          Authorization: `Bearer ${accessToken}`,
        },
      });

      const userId = profileResponse.data.id;

      // Create the playlist
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

      const playlistId = createPlaylistResponse.data.id;
      const playlistUrl = createPlaylistResponse.data.external_urls.spotify;

      if (!playlistId) {
        this.logger.log(color.red.bold('Failed to create Spotify playlist'));
        return { success: false, error: 'Failed to create Spotify playlist' };
      }

      // Add tracks to the playlist (maximum 100 tracks per request)
      const trackUris = trackIds.map((id: string) => `spotify:track:${id}`);

      // Split into chunks of 100 if needed
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
          `Created Spotify playlist "${color.white.bold(
            playlistName
          )}" with ${color.white.bold(trackIds.length)} tracks`
        )
      );

      // Clear the pending playlist info
      await this.cache.del('pending_playlist_info');

      return {
        success: true,
        data: {
          playlistId,
          playlistUrl,
          playlistName,
        },
      };
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

  public async searchTracks(searchString: string) {
    try {
      if (!searchString || searchString.length < 2) {
        return { success: false, error: 'Search string too short' };
      }

      // Use Spotify search instead of database search
      const spotify = new Spotify();
      const spotifyResult = await spotify.searchTracks(searchString);

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
