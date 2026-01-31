import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from '@shared/schema';

if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL environment variable is not set');
}

// Create PostgreSQL connection pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20, // Maximum number of clients in the pool
  idleTimeoutMillis: 30000, // Close idle clients after 30 seconds
  connectionTimeoutMillis: 2000, // Return an error after 2 seconds if connection cannot be established
});

// Handle pool errors
pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});

// Create Drizzle database instance
export const db = drizzle(pool, { schema });

// Test connection on startup
pool.connect()
  .then((client) => {
    console.log('✅ Connected to PostgreSQL database');
    client.release();
  })
  .catch((err) => {
    console.error('❌ Failed to connect to PostgreSQL database:', err);
    console.error('Please check your DATABASE_URL and ensure PostgreSQL is running');
  });

