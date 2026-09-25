import pg from "pg";
import dotenv from "dotenv";
dotenv.config();

// Pool instead of a single Client: the old shared Client made BEGIN/COMMIT from
// concurrent requests interleave on one session, which breaks FOR UPDATE row locks.
// `db.query(...)` keeps working exactly as before for every existing route.
const db = new pg.Pool({
  user:     process.env.PG_USER,
  host:     process.env.PG_HOST,
  database: process.env.PG_DATABASE,
  password: process.env.PG_PASSWORD,
  port:     process.env.PG_PORT,
  max:      10,
});

db.on('error', (err) => console.error('Idle PostgreSQL client error:', err.message));

db.query('SELECT 1')
  .then(() => console.log('✅ Connected to PostgreSQL'))
  .catch((err) => console.error('❌ Database connection failed:', err.stack));

/** Run fn(client) in one transaction on a dedicated connection. Commits on success, rolls back on any throw. */
export async function withTransaction(fn) {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

export default db;