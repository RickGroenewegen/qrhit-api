import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';

interface MusicMatchTrack {
  i: number; // track id
  l: string; // spotify id
}

interface MusicMatchPlaylist {
  i: number; // playlist id  
  t: MusicMatchTrack[]; // tracks
}

interface MusicMatchData {
  p: MusicMatchPlaylist[];
}

async function generateMusicMatchSQL() {
  try {
    console.log('Starting MusicMatch SQL generation...');
    
    // Define file paths
    const dataDir = path.join(__dirname, 'src', '_data');
    const jsonPath = path.join(dataDir, 'musicmatch.json');
    const excelPath = path.join(dataDir, 'musicmatch.xlsx');
    const outputPath = path.join(dataDir, 'musicmatch.sql');
    
    // Check if files exist
    if (!fs.existsSync(jsonPath)) {
      console.error(`JSON file not found: ${jsonPath}`);
      return;
    }
    
    if (!fs.existsSync(excelPath)) {
      console.error(`Excel file not found: ${excelPath}`);
      return;
    }
    
    // Read and parse JSON file
    console.log('Reading musicmatch.json...');
    const jsonContent = fs.readFileSync(jsonPath, 'utf8');
    const musicMatchData: MusicMatchData = JSON.parse(jsonContent);
    
    // Create a map of Spotify ID to track ID for quick lookup from all playlists
    const spotifyToTrackId = new Map<string, number>();
    
    // Iterate through all playlists to build the Spotify ID to track ID map
    musicMatchData.p.forEach(playlist => {
      playlist.t.forEach(track => {
        if (track.l) {
          spotifyToTrackId.set(track.l, track.i);
        }
      });
    });
    
    console.log(`Found ${spotifyToTrackId.size} total tracks in musicmatch.json`);
    
    // Read Excel file
    console.log('Reading musicmatch.xlsx...');
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(excelPath);
    
    // Get the first worksheet
    const worksheet = workbook.worksheets[0];
    if (!worksheet) {
      console.error('No worksheet found in Excel file');
      return;
    }
    
    // Generate SQL UPDATE statements
    const sqlStatements: string[] = [];
    sqlStatements.push('-- MusicMatch SQL Update Script');
    sqlStatements.push('-- Generated on ' + new Date().toISOString());
    sqlStatements.push('-- Updates order column in playlist_has_track table for playlist 776');
    sqlStatements.push('');
    
    let updateCount = 0;
    let notFoundCount = 0;
    const notFoundSpotifyIds: string[] = [];
    
    // Iterate through rows (skip header row if it exists)
    worksheet.eachRow((row, rowNumber) => {
      // Skip header row (assuming first row is header)
      if (rowNumber === 1) {
        return;
      }
      
      // Get Volnummer (column 1) and SpotifyIDCode (column 10)
      const volnummerCell = row.getCell(1).value;
      const spotifyIdCell = row.getCell(10).value;
      
      if (volnummerCell && spotifyIdCell) {
        // Extract the actual value from cell (handle hyperlinks and formulas)
        let spotifyIdStr = '';
        if (typeof spotifyIdCell === 'object' && spotifyIdCell !== null) {
          // Check if it's a hyperlink
          if ('text' in spotifyIdCell) {
            spotifyIdStr = String(spotifyIdCell.text).trim();
          } else if ('result' in spotifyIdCell) {
            spotifyIdStr = String(spotifyIdCell.result).trim();
          } else {
            spotifyIdStr = JSON.stringify(spotifyIdCell);
          }
        } else {
          spotifyIdStr = String(spotifyIdCell).trim();
        }
        
        const volnummerNum = Number(volnummerCell);
        
        // Extract just the Spotify track ID if it's a full URL
        const spotifyTrackMatch = spotifyIdStr.match(/track\/([a-zA-Z0-9]+)/);
        if (spotifyTrackMatch) {
          spotifyIdStr = spotifyTrackMatch[1];
        }
        
        // Find the track ID from our map
        const trackId = spotifyToTrackId.get(spotifyIdStr);
        
        if (trackId) {
          // Generate UPDATE statement
          const sql = `UPDATE playlist_has_track SET \`order\` = ${volnummerNum} WHERE playlist_id = 776 AND track_id = ${trackId};`;
          sqlStatements.push(sql);
          updateCount++;
        } else {
          notFoundCount++;
          notFoundSpotifyIds.push(spotifyIdStr);
          sqlStatements.push(`-- Spotify ID not found in JSON: ${spotifyIdStr} (Volnummer: ${volnummerNum})`);
        }
      }
    });
    
    // Add summary comments
    sqlStatements.push('');
    sqlStatements.push(`-- Summary:`);
    sqlStatements.push(`-- Total UPDATE statements: ${updateCount}`);
    sqlStatements.push(`-- Spotify IDs not found in JSON: ${notFoundCount}`);
    
    if (notFoundSpotifyIds.length > 0) {
      sqlStatements.push('');
      sqlStatements.push('-- Not found Spotify IDs:');
      notFoundSpotifyIds.forEach(id => {
        sqlStatements.push(`-- ${id}`);
      });
    }
    
    // Write SQL file
    const sqlContent = sqlStatements.join('\n');
    fs.writeFileSync(outputPath, sqlContent, 'utf8');
    
    console.log(`\n✅ SQL file generated successfully: ${outputPath}`);
    console.log(`📊 Statistics:`);
    console.log(`   - UPDATE statements generated: ${updateCount}`);
    console.log(`   - Spotify IDs not found: ${notFoundCount}`);
    
    if (notFoundCount > 0) {
      console.log('\n⚠️  Warning: Some Spotify IDs from Excel were not found in the JSON file');
      console.log('   Check the SQL file for details about missing IDs');
    }
    
  } catch (error) {
    console.error('Error generating SQL:', error);
  }
}

// Run the script
generateMusicMatchSQL();