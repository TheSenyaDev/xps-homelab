// Seed Homarr owner credentials from HOMARR_USER / HOMARR_PASSWORD env vars.
// Runs as CJS before Homarr starts; exits 0 whether or not env vars are set.
'use strict';

const user = process.env.HOMARR_USER;
const pass = process.env.HOMARR_PASSWORD;

if (!user || !pass) {
  console.log('[init] HOMARR_USER/HOMARR_PASSWORD not set — skipping credential seed');
  process.exit(0);
}

let Database, bcrypt;
try {
  Database = require('/app/cli/node_modules/better-sqlite3');
  bcrypt = require('/app/cli/node_modules/bcryptjs');
} catch (e) {
  console.error('[init] Could not load modules:', e.message);
  process.exit(0);
}

const dbPath = (process.env.DATABASE_URL || 'file:/data/db.sqlite').replace('file:', '');

let db;
try {
  db = new Database(dbPath);
} catch (e) {
  console.error('[init] Could not open database:', e.message);
  process.exit(0);
}

const hashed = bcrypt.hashSync(pass, 10);

try {
  const existing = db.prepare('SELECT id FROM user WHERE is_owner = 1 LIMIT 1').get();
  if (existing) {
    db.prepare('UPDATE user SET name = ?, password = ? WHERE is_owner = 1').run(user, hashed);
    db.prepare('DELETE FROM session WHERE userId = ?').run(existing.id);
    console.log(`[init] Updated owner credentials → username: ${user}`);
  } else {
    console.log('[init] No owner user found — skipping');
  }
} catch (e) {
  console.error('[init] Failed to update credentials:', e.message);
} finally {
  db.close();
}
