#!/usr/bin/env node
// Re-encrypts stored channel credentials (Telegram bot tokens, webhook headers/secrets) with a new SECRET_KEY.
//
//   docker compose stop broker
//   OLD_SECRET_KEY=<current> SECRET_KEY=<new> DATA_DIR=/path/to/data node scripts/rotate-secret.mjs
//   (put the new SECRET_KEY in .env, then)  docker compose up -d
//
// Signed image links created with the old key simply stop working; sessions and API keys are unaffected.
import Database from "better-sqlite3";
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { join } from "node:path";

const oldSecret = process.env.OLD_SECRET_KEY;
const newSecret = process.env.SECRET_KEY;
const dataDir = process.env.DATA_DIR ?? join(process.cwd(), "data");
if (!oldSecret || !newSecret || oldSecret === newSecret || newSecret.length < 16 || /^change[-_ ]?me/i.test(newSecret)) {
  console.error("Set OLD_SECRET_KEY (current) and SECRET_KEY (new, >= 16 chars, different), and DATA_DIR if the data folder is not ./data");
  process.exit(1);
}
const key = (s) => createHash("sha256").update(s).digest();
const dec = (blob, k) => { const b = Buffer.from(blob, "base64"); const d = createDecipheriv("aes-256-gcm", k, b.subarray(0, 12)); d.setAuthTag(b.subarray(12, 28)); return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8"); };
const enc = (plain, k) => { const iv = randomBytes(12); const c = createCipheriv("aes-256-gcm", k, iv); const e = Buffer.concat([c.update(plain, "utf8"), c.final()]); return Buffer.concat([iv, c.getAuthTag(), e]).toString("base64"); };

const db = new Database(join(dataDir, "broker.db"));
const rows = db.prepare("SELECT id, name, config_enc FROM channels").all();
const update = db.prepare("UPDATE channels SET config_enc = ? WHERE id = ?");
const oldK = key(oldSecret), newK = key(newSecret);
// Decrypt everything first: if the old key is wrong nothing is written.
let plain;
try {
  plain = rows.map((r) => ({ ...r, plain: dec(r.config_enc, oldK) }));
} catch {
  console.error("OLD_SECRET_KEY does not decrypt the stored channels (wrong key?). Nothing was changed.");
  process.exit(1);
}
db.transaction(() => { for (const r of plain) update.run(enc(r.plain, newK), r.id); })();
console.log(`Re-encrypted ${rows.length} channel(s). Now set SECRET_KEY to the new value in .env and restart the broker.`);
