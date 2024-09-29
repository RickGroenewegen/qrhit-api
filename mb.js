require('dotenv').config();
const { Client } = require('pg');
const mysql = require('mysql2/promise');

// Configure the PostgreSQL connection
const pgClient = new Client({
  host: process.env.MUSICBRAINZ_DB_HOST,
  port: 5432,
  user: process.env.MUSICBRAINZ_DB_USER,
  password: process.env.MUSICBRAINZ_DB_PASSWORD,
  database: 'musicbrainz_db',
});

// Configure the MySQL connection
const mysqlConfig = {
  host: process.env.DATABASE_HOST,
  port: 3306,
  user: process.env.DATABASE_USER,
  password: process.env.DATABASE_PASSWORD,
  database: process.env.DATABASE_NAME,
};

(async () => {
  let mysqlConnection;

  try {
    // Connect to the PostgreSQL database
    await pgClient.connect();
    console.log('Connected to the PostgreSQL database');

    // Define the query
    const query = `
      SELECT 
        isrc.isrc, 
        recording_first_release_date."year"
      FROM 
        isrc 
      INNER JOIN 
        recording_first_release_date ON isrc.recording = recording_first_release_date.recording;
    `;

    // Execute the query
    const res = await pgClient.query(query);
    console.log('Records found: ' + res.rows.length);

    // Connect to the MySQL database
    mysqlConnection = await mysql.createConnection(mysqlConfig);
    console.log('Connected to the MySQL database');

    // Insert each record into the MySQL isrc table in batches
    const batchSize = 1000;
    const totalRecords = res.rows.length;
    let processedRecords = 0;

    for (let i = 0; i < totalRecords; i += batchSize) {
      const batch = res.rows.slice(i, i + batchSize);
      const values = batch.map((row) => [row.isrc, row.year]);

      const insertQuery = `
        INSERT INTO isrc (isrc, year) 
        VALUES ? 
        ON DUPLICATE KEY UPDATE 
          year = CASE
            WHEN VALUES(year) < isrc.year OR isrc.year IS NULL
            THEN VALUES(year)
            ELSE isrc.year
          END
      `;

      await mysqlConnection.query(insertQuery, [values]);

      processedRecords += batch.length;
      const progressPercentage = (
        (processedRecords / totalRecords) *
        100
      ).toFixed(1);
      console.log(
        `Processed ${processedRecords} records (${progressPercentage}%)`
      );
    }

    console.log('Records inserted into the MySQL database successfully');
  } catch (err) {
    console.error('Error:', err.stack);
  } finally {
    // Close the PostgreSQL database connection
    try {
      await pgClient.end();
      console.log('PostgreSQL database connection closed');
    } catch (err) {
      console.error('Error closing PostgreSQL connection:', err.stack);
    }

    // Close the MySQL database connection
    if (mysqlConnection) {
      try {
        await mysqlConnection.end();
        console.log('MySQL database connection closed');
      } catch (err) {
        console.error('Error closing MySQL connection:', err.stack);
      }
    }
  }
})();
