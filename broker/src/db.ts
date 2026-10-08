import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), "data");
mkdirSync(join(DATA_DIR, "images"), { recursive: true });

export const db = new Database(join(DATA_DIR, "broker.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user',
  password_hash TEXT NOT NULL, disabled INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
  prefix TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL, last_used_at TEXT);
CREATE TABLE IF NOT EXISTS devices (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, label TEXT NOT NULL,
  tags TEXT NOT NULL DEFAULT '[]', token_hash TEXT NOT NULL UNIQUE, paused INTEGER NOT NULL DEFAULT 0,
  limited_until TEXT, ext_version TEXT, last_seen_at TEXT, last_job_at TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS pairing_codes (
  code TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS channels (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, type TEXT NOT NULL,
  name TEXT NOT NULL, config_enc TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE, name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1, kind TEXT NOT NULL, time TEXT, every_minutes INTEGER,
  active_from TEXT, active_to TEXT, timezone TEXT NOT NULL DEFAULT 'UTC', prompt TEXT NOT NULL,
  conversation_url TEXT, mode TEXT NOT NULL DEFAULT 'auto', target TEXT, channel_id TEXT,
  skip_if_unchanged INTEGER NOT NULL DEFAULT 0, skip_if_matches TEXT,
  last_run_at TEXT, last_status TEXT, last_hash TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  device_id TEXT, state TEXT NOT NULL, mode TEXT NOT NULL, prompt TEXT NOT NULL, conversation_url TEXT,
  target TEXT, source TEXT NOT NULL, schedule_id TEXT, timeout_ms INTEGER NOT NULL, text TEXT, error TEXT,
  progress TEXT NOT NULL DEFAULT '[]', excluded TEXT NOT NULL DEFAULT '[]', attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL, started_at TEXT, finished_at TEXT);
CREATE INDEX IF NOT EXISTS jobs_user_created ON jobs(user_id, created_at);
CREATE INDEX IF NOT EXISTS jobs_state ON jobs(state);
CREATE TABLE IF NOT EXISTS job_images (
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE, idx INTEGER NOT NULL, mime TEXT NOT NULL, file TEXT NOT NULL,
  PRIMARY KEY (job_id, idx));
`);

// Lightweight migrations for databases created by older versions.
const pcCols = (db.prepare("PRAGMA table_info(pairing_codes)").all() as { name: string }[]).map((c) => c.name);
if (!pcCols.includes("device_id")) db.exec("ALTER TABLE pairing_codes ADD COLUMN device_id TEXT");
const jobCols = (db.prepare("PRAGMA table_info(jobs)").all() as { name: string }[]).map((c) => c.name);
if (!jobCols.includes("chat_url")) db.exec("ALTER TABLE jobs ADD COLUMN chat_url TEXT");
if (!jobCols.includes("parent_id")) db.exec("ALTER TABLE jobs ADD COLUMN parent_id TEXT");
if (!jobCols.includes("channel_id")) db.exec("ALTER TABLE jobs ADD COLUMN channel_id TEXT");
if (!jobCols.includes("markdown")) db.exec("ALTER TABLE jobs ADD COLUMN markdown TEXT");

export const now = () => new Date().toISOString();
export const uid = () => randomUUID();
