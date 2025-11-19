/**
 * Test script for parallel Spotify track fetching
 * Tests the new parallel implementation with different playlist sizes
 */

import SpotifyApi from './src/spotify_api';
import { color } from 'console-log-colors';

async function testParallelTracks() {
  const spotifyApi = new SpotifyApi();

  // Test playlists of different sizes
  const testPlaylists = [
    { id: '37i9dQZF1DXcBWIGoYBM5M', name: 'Today\'s Top Hits', expectedSize: '~50 tracks' },
    { id: '37i9dQZF1DX0XUsuxWHRQd', name: 'RapCaviar', expectedSize: '~50 tracks' },
    // Add your own test playlists here with different sizes
  ];

  console.log(color.cyan.bold('\n=== Testing Parallel Spotify Track Fetching ===\n'));

  for (const playlist of testPlaylists) {
    console.log(color.blue(`\nTesting playlist: ${playlist.name} (${playlist.expectedSize})`));
    console.log(color.gray(`Playlist ID: ${playlist.id}`));

    try {
      const startTime = Date.now();
      const result = await spotifyApi.getTracks(playlist.id);
      const elapsed = Date.now() - startTime;

      if (result.success && result.data) {
        const trackCount = result.data.items.length;
        console.log(color.green(`✓ Successfully fetched ${trackCount} tracks in ${elapsed}ms`));

        // Verify tracks have required fields
        const firstTrack = result.data.items[0];
        if (firstTrack && firstTrack.track) {
          console.log(color.gray(`  First track: ${firstTrack.track.name} by ${firstTrack.track.artists[0].name}`));
        }
      } else {
        console.log(color.red(`✗ Failed: ${result.error}`));
        if (result.needsReAuth) {
          console.log(color.yellow(`  Auth required. Please authenticate at: ${result.authUrl}`));
        }
      }
    } catch (error: any) {
      console.log(color.red(`✗ Error: ${error.message}`));
    }
  }

  console.log(color.cyan.bold('\n=== Test Complete ===\n'));
}

// Run the test
testParallelTracks().catch(console.error);
