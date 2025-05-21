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
      const firstname = hitlist[0]?.firstname;
      const lastname = hitlist[0]?.lastname;
      const email = hitlist[0]?.email;
      const agreeToUseName = this.utils.parseBoolean(
        hitlist[0]?.agreeToUseName
      ); // Added agreeToUseName

      let constructedFullname: string | null = (
        (firstname || '') +
        ' ' +
        (lastname || '')
      ).trim();
      if (constructedFullname === '') {
        constructedFullname = null;
      }

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
            status: 'pending_verification',
            firstname: firstname || null,
            lastname: lastname || null,
            email: email || null,
            agreeToUseName: agreeToUseName,
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
            firstname: firstname || submission.firstname,
            lastname: lastname || submission.lastname,
            email: email || submission.email,
            verificationHash: verificationHash,
            agreeToUseName: agreeToUseName, // Added agreeToUseName
          },
        });
      }

      // Send verification email if we have an email address
      if (email && submission.verificationHash) {
        await this.mail.sendVerificationEmail(
          email,
          constructedFullname!,
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
          let track = null;

          // First try to get the track with an exact match on artist and title
          const trackWithExactMatch = await this.prisma.track.findFirst({
            where: {
              artist: trackData.artist,
              name: trackData.name,
            },
          });

          if (trackWithExactMatch) {
            track = trackWithExactMatch;
            this.logger.log(
              color.blue.bold(
                `Found existing track with exact match: ${color.white.bold(
                  trackData.artist
                )} - ${color.white.bold(trackData.name)}`
              )
            );
          } else {
            // If no exact match, try to find a track with the same Spotify ID
            track = await this.prisma.track.findUnique({
              where: { trackId: trackData.trackId },
            });
          }

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
          // description: true, // REMOVED
          numberOfTracks: true,
          minimumNumberOfTracks: true,
          languages: true,
          showNames: true,
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
          description_en: true,
          description_nl: true,
          description_de: true,
          description_fr: true,
          description_es: true,
          description_it: true,
          description_pt: true,
          description_pl: true,
          description_hin: true,
          description_jp: true,
          description_cn: true,
          description_ru: true,
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

      // Determine locale for description
      let usedLocale = 'nl';
      // Use process.env or fallback to 'nl'
      if (
        typeof process !== 'undefined' &&
        process.env.HITLIST_LOCALE &&
        typeof process.env.HITLIST_LOCALE === 'string'
      ) {
        usedLocale = process.env.HITLIST_LOCALE;
      }

      // Pick the right description field
      const descKey = `description_${usedLocale}`;
      const description =
        (companyList as Record<string, any>)[descKey] ||
        (companyList as Record<string, any>)['description_nl'] ||
        (companyList as Record<string, any>)['description_en'] ||
        '';

      return {
        success: true,
        data: {
          id: companyList.id,
          name: companyList.name,
          description: description,
          numberOfTracks: companyList.numberOfTracks,
          minimumNumberOfTracks: companyList.minimumNumberOfTracks,
          numberOfCards: companyList.numberOfCards,
          companyName: companyList.Company.name,
          votingBackground: companyList.votingBackground,
          votingLogo: companyList.votingLogo,
          languages: companyList.languages,
          showNames: companyList.showNames,
          startAt: companyList.startAt,
          endAt: companyList.endAt,
          votingOpen: votingOpen,
          submissionStatus: submissionStatus,
        },
      };
    } catch (error) {
      this.logger.log(color.red.bold(`Error getting company list: ${error}`));
      return { success: false, error: 'Error getting company list' };
    }
  }

  public async searchTracks(searchString: string) {
    try {
      if (!searchString || searchString.length < 2) {
        return { success: false, error: 'Search string too short' };
      }

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
