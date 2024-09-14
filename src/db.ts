import knex from 'knex';
import { Knex } from 'knex';
import dotenv from 'dotenv';

dotenv.config();

// Knex configuration object
const knexConfig: Knex.Config = {
  client: 'mysql2',
  connection: {
    host: process.env['DATABASE_HOST'] as string,
    user: process.env['DATABASE_USER'] as string,
    password: process.env['DATABASE_PASSWORD'] as string,
    database: process.env['DATABASE_NAME'] as string,
    charset: 'utf8mb4',
  },
  pool: {
    min: 2,
    max: 10,
  },
};

// Initialize the Knex instance with your configuration
const db = knex(knexConfig);

// Keep-alive function
const keepAliveInterval = 60000; // 60 seconds

setInterval(async () => {
  await db.raw('SELECT 1');
}, keepAliveInterval);

export default db;
