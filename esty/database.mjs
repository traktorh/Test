import { dirname, resolve } from "node:path";
import { mkdirSync } from "node:fs";

const databaseUrl = process.env.DATABASE_URL;
const postgres = Boolean(databaseUrl);
let sqlite;
let pool;
let initialization;

function postgresSql(statement) {
  let parameter = 0;
  return statement.replace(/\?/g, () => `$${++parameter}`);
}

async function query(statement, parameters = []) {
  if (postgres) {
    pool ??= new (await import("@neondatabase/serverless")).Pool({
      connectionString: databaseUrl,
      max: 1,
      connectionTimeoutMillis: 5000
    });
    return pool.query(postgresSql(statement), parameters);
  }
  return sqlite.prepare(statement).all(...parameters);
}

async function get(statement, parameters = []) {
  if (postgres) {
    const result = await query(statement, parameters);
    return result.rows[0] ?? null;
  }
  return sqlite.prepare(statement).get(...parameters) ?? null;
}

async function all(statement, parameters = []) {
  if (postgres) {
    const result = await query(statement, parameters);
    return result.rows;
  }
  return sqlite.prepare(statement).all(...parameters);
}

async function run(statement, parameters = []) {
  if (postgres) {
    const result = await query(statement, parameters);
    return { changes: result.rowCount ?? 0, rows: result.rows };
  }
  const result = sqlite.prepare(statement).run(...parameters);
  return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
}

async function initialize() {
  if (process.env.VERCEL && !databaseUrl) {
    throw new Error("Set DATABASE_URL to your Neon Postgres connection string in Vercel");
  }

  if (postgres) {
    await query(`
      CREATE TABLE IF NOT EXISTS users (
        id BIGSERIAL PRIMARY KEY,
        username TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        rank INTEGER NOT NULL DEFAULT 0,
        points INTEGER NOT NULL DEFAULT 0,
        shooting_passed INTEGER NOT NULL DEFAULT 0,
        knowledge_passed INTEGER NOT NULL DEFAULT 0,
        warning_until BIGINT,
        is_admin INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at BIGINT NOT NULL
      )`);
    await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS knowledge_passed INTEGER NOT NULL DEFAULT 0");
    await query("ALTER TABLE users ADD COLUMN IF NOT EXISTS must_change_password INTEGER NOT NULL DEFAULT 0");
    await query("CREATE UNIQUE INDEX IF NOT EXISTS users_username_ci ON users (LOWER(username))");
    await query(`
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at BIGINT NOT NULL
      )`);
    await query(`
      CREATE TABLE IF NOT EXISTS quiz_best (
        user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        quiz_id TEXT NOT NULL,
        best_points INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, quiz_id)
      )`);
    await query(`
      CREATE TABLE IF NOT EXISTS promotion_requests (
        user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        rank INTEGER NOT NULL,
        requested_at BIGINT NOT NULL
      )`);
    await query("CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)");
    await query(`
      UPDATE users SET is_admin = 0
      WHERE is_admin = 1
        AND id <> (SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at, id LIMIT 1)`);
    await query("CREATE UNIQUE INDEX IF NOT EXISTS single_administrator ON users (is_admin) WHERE is_admin = 1");
    return;
  }

  if (!sqlite) {
    const dataDirectory = resolve(process.env.DATABASE_PATH ? dirname(resolve(process.env.DATABASE_PATH)) : resolve("data"));
    mkdirSync(dataDirectory, { recursive: true });
    const databasePath = resolve(process.env.DATABASE_PATH ?? resolve(dataDirectory, "clan.sqlite"));
    const { DatabaseSync } = await import("node:sqlite");
    sqlite = new DatabaseSync(databasePath);
    sqlite.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA foreign_keys = ON;
      CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY,
        username TEXT NOT NULL COLLATE NOCASE UNIQUE,
        password_hash TEXT NOT NULL,
        salt TEXT NOT NULL,
        rank INTEGER NOT NULL DEFAULT 0,
        points INTEGER NOT NULL DEFAULT 0,
        shooting_passed INTEGER NOT NULL DEFAULT 0,
        knowledge_passed INTEGER NOT NULL DEFAULT 0,
        warning_until INTEGER,
        is_admin INTEGER NOT NULL DEFAULT 0,
        must_change_password INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS quiz_best (
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        quiz_id TEXT NOT NULL,
        best_points INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, quiz_id)
      );
      CREATE TABLE IF NOT EXISTS promotion_requests (
        user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
        rank INTEGER NOT NULL,
        requested_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    for (const [column, definition] of [
      ["shooting_passed", "INTEGER NOT NULL DEFAULT 0"],
      ["knowledge_passed", "INTEGER NOT NULL DEFAULT 0"],
      ["must_change_password", "INTEGER NOT NULL DEFAULT 0"]
    ]) {
      const columns = sqlite.prepare("PRAGMA table_info(users)").all();
      if (!columns.some((item) => item.name === column)) {
        sqlite.exec(`ALTER TABLE users ADD COLUMN ${column} ${definition}`);
      }
    }
    sqlite.prepare(`
      UPDATE users SET is_admin = 0
      WHERE is_admin = 1
        AND id <> (SELECT id FROM users WHERE is_admin = 1 ORDER BY created_at, id LIMIT 1)
    `).run();
    sqlite.exec("CREATE UNIQUE INDEX IF NOT EXISTS single_administrator ON users(is_admin) WHERE is_admin = 1");
  }
}

export async function ensureDatabase() {
  initialization ??= initialize();
  await initialization;
}

export function usingNeon() {
  return postgres;
}

async function close() {
  if (sqlite) {
    sqlite.close();
    sqlite = undefined;
    initialization = undefined;
  }
  if (pool) {
    await pool.end();
    pool = undefined;
  }
}

export const db = { query, get, all, run, close };
