import type { IncomingMessage, ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { db, now, uid } from "./db.js";
import {
  HttpError, checkSigned, clientIp, decrypt, encrypt, hashPassword, json, parseCookies, randomToken, rateLimit,
  readBody, sha256, verifyPassword,
} from "./util.js";
import {
  cancelJob, createJob, deleteJob, deviceView, disconnectDevice, finish, getJob, jobImages, jobView, waitForJob, type JobRow,
} from "./engine.js";
import { channelConfig, tgText } from "./notify.js";
import { assertSafeUrl, buildPayload, deliverWebhook } from "./webhook.js";
import { nextRunAt, runSchedule, validTz } from "./scheduler.js";

export type User = { id: string; email: string; name: string; role: "admin" | "user"; disabled: number };
type Ctx = { req: IncomingMessage; res: ServerResponse; url: URL; params: Record<string, string>; body: any; user: User };
type Handler = (c: Ctx) => unknown | Promise<unknown>;
type Route = { method: string; re: RegExp; keys: string[]; auth: "session" | "key" | "none"; admin: boolean; h: Handler };

const routes: Route[] = [];
function add(method: string, path: string, auth: Route["auth"], h: Handler, admin = false) {
  const keys: string[] = [];
  const re = new RegExp("^" + path.replace(/:(\w+)/g, (_, k) => (keys.push(k), "([^/]+)")) + "$");
  routes.push({ method, re, keys, auth, admin, h });
}
const S = (m: string, p: string, h: Handler) => add(m, p, "session", h);
const A = (m: string, p: string, h: Handler) => add(m, p, "session", h, true);
const K = (m: string, p: string, h: Handler) => add(m, p, "key", h);

const COOKIE_SECURE = process.env.COOKIE_SECURE === "1";
const SESSION_DAYS = 30;

// ---------------------------------------------------------------- auth helpers
export function sessionUser(req: IncomingMessage): User | null {
  const sid = parseCookies(req).sid;
  if (!sid) return null;
  const r = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.id = ? AND s.expires_at > ?`).get(sha256(sid), now()) as User | undefined;
  return r && !r.disabled ? r : null;
}
export function keyUser(req: IncomingMessage): User | null {
  const m = /^Bearer (ck_[\w-]+)$/.exec(String(req.headers.authorization ?? ""));
  if (!m) return null;
  const row = db.prepare("SELECT k.id AS key_id, u.* FROM api_keys k JOIN users u ON u.id = k.user_id WHERE k.hash = ?").get(sha256(m[1])) as (User & { key_id: string }) | undefined;
  if (!row || row.disabled) return null;
  db.prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?").run(now(), row.key_id);
  return row;
}

const userView = (u: any) => ({ id: u.id, email: u.email, name: u.name, role: u.role });
const parse = <T extends z.ZodTypeAny>(schema: T, v: unknown): z.infer<T> => {
  const r = schema.safeParse(v);
  if (!r.success) throw new HttpError(400, r.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  return r.data;
};
const owned = (table: string, id: string, userId: string) => {
  const row = db.prepare(`SELECT * FROM ${table} WHERE id = ? AND user_id = ?`).get(id, userId) as any;
  if (!row) throw new HttpError(404, "not found");
  return row;
};
const ok = { ok: true };

// ---------------------------------------------------------------- auth routes
add("POST", "/api/auth/login", "none", async (c) => {
  const b = parse(z.object({ email: z.string(), password: z.string() }), c.body);
  const email = b.email.trim().toLowerCase();
  if (!rateLimit(`login:${clientIp(c.req)}:${email}`, 10, 15 * 60_000)) throw new HttpError(429, "too many attempts, try again later");
  const u = db.prepare("SELECT * FROM users WHERE email = ?").get(email) as any;
  if (!u || u.disabled || !verifyPassword(b.password, u.password_hash)) throw new HttpError(401, "invalid email or password");
  const sid = randomBytes(32).toString("base64url");
  db.prepare("INSERT INTO sessions (id, user_id, expires_at) VALUES (?,?,?)").run(sha256(sid), u.id, new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString());
  c.res.setHeader("set-cookie", `sid=${sid}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${SESSION_DAYS * 86400}${COOKIE_SECURE ? "; Secure" : ""}`);
  return { user: userView(u) };
});
S("POST", "/api/auth/logout", (c) => {
  const sid = parseCookies(c.req).sid;
  if (sid) db.prepare("DELETE FROM sessions WHERE id = ?").run(sha256(sid));
  c.res.setHeader("set-cookie", "sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
  return ok;
});
S("GET", "/api/me", (c) => userView(c.user));
S("POST", "/api/me/password", (c) => {
  const b = parse(z.object({ current: z.string(), next: z.string().min(8).max(200) }), c.body);
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(c.user.id) as any;
  if (!verifyPassword(b.current, u.password_hash)) throw new HttpError(400, "current password is incorrect");
  db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(hashPassword(b.next), u.id);
  return ok;
});

// ---------------------------------------------------------------- devices
const deviceRow = (id: string, userId: string) => owned("devices", id, userId);
S("GET", "/api/devices", (c) => (db.prepare("SELECT * FROM devices WHERE user_id = ? ORDER BY created_at").all(c.user.id) as any[]).map(deviceView));
S("POST", "/api/devices/pairing", (c) => {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code = Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  db.prepare("INSERT INTO pairing_codes (code, user_id, expires_at) VALUES (?,?,?)").run(code, c.user.id, expiresAt);
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
});
// Re-pair an existing device (lost/invalid token): the new pairing replaces its token, keeping its name, tags and history.
S("POST", "/api/devices/:id/pairing", (c) => {
  const d = deviceRow(c.params.id, c.user.id);
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const code = Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
  const expiresAt = new Date(Date.now() + 10 * 60_000).toISOString();
  db.prepare("INSERT INTO pairing_codes (code, user_id, expires_at, device_id) VALUES (?,?,?,?)").run(code, c.user.id, expiresAt, d.id);
  return { code: `${code.slice(0, 4)}-${code.slice(4)}`, expiresAt };
});
S("PATCH", "/api/devices/:id", (c) => {
  const d = deviceRow(c.params.id, c.user.id);
  const b = parse(z.object({
    label: z.string().min(1).max(60).optional(),
    tags: z.array(z.string().min(1).max(30).regex(/^[\w.-]+$/)).max(10).optional(),
    paused: z.boolean().optional(),
  }), c.body);
  db.prepare("UPDATE devices SET label = ?, tags = ?, paused = ? WHERE id = ?")
    .run(b.label ?? d.label, JSON.stringify(b.tags ?? JSON.parse(d.tags)), (b.paused ?? !!d.paused) ? 1 : 0, d.id);
  return deviceView(deviceRow(d.id, c.user.id));
});
S("DELETE", "/api/devices/:id", (c) => {
  const d = deviceRow(c.params.id, c.user.id);
  disconnectDevice(d.id);
  db.prepare("DELETE FROM devices WHERE id = ?").run(d.id);
  return ok;
});

// Extension pairing (no session; CORS open because the extension calls it cross-origin).
add("POST", "/api/device/pair", "none", (c) => {
  if (!rateLimit(`pair:${clientIp(c.req)}`, 20, 10 * 60_000)) throw new HttpError(429, "too many attempts");
  const b = parse(z.object({ code: z.string(), label: z.string().max(60).optional(), version: z.string().max(30).optional() }), c.body);
  const code = b.code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  const p = db.prepare("SELECT * FROM pairing_codes WHERE code = ? AND expires_at > ?").get(code, now()) as any;
  if (!p) throw new HttpError(400, "invalid or expired pairing code");
  db.prepare("DELETE FROM pairing_codes WHERE code = ?").run(code);
  const token = randomToken("dt_");
  if (p.device_id) {
    const dev = db.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?").get(p.device_id, p.user_id) as { id: string } | undefined;
    if (!dev) throw new HttpError(400, "the device for this pairing code no longer exists");
    disconnectDevice(dev.id); // drop any connection that still uses the old token
    db.prepare("UPDATE devices SET token_hash = ?, ext_version = COALESCE(?, ext_version) WHERE id = ?").run(sha256(token), b.version ?? null, dev.id);
    return { deviceId: dev.id, deviceToken: token };
  }
  const id = uid();
  db.prepare("INSERT INTO devices (id,user_id,label,token_hash,ext_version,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, p.user_id, (b.label ?? "Chrome").trim() || "Chrome", sha256(token), b.version ?? null, now());
  return { deviceId: id, deviceToken: token };
});

// ---------------------------------------------------------------- jobs (dashboard)
const jobInput = z.object({
  prompt: z.string().min(1).max(20000),
  mode: z.enum(["image", "text", "auto"]).optional(),
  conversationUrl: z.string().url().regex(/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//).nullish(),
  target: z.object({ deviceId: z.string().optional(), device: z.string().optional(), tag: z.string().optional() }).nullish(),
  timeoutMs: z.number().int().positive().optional(),
  channelId: z.string().nullish(),
});
/** Resolve a device reference given as id or (case-insensitive) label, so API/MCP users can say "Work laptop". */
export function resolveDevice(userId: string, ref: string): string {
  const byId = db.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?").get(ref, userId) as { id: string } | undefined;
  if (byId) return byId.id;
  const byLabel = db.prepare("SELECT id FROM devices WHERE user_id = ? AND lower(label) = lower(?)").all(userId, ref) as { id: string }[];
  if (byLabel.length === 1) return byLabel[0].id;
  if (byLabel.length > 1) throw new HttpError(400, `device name "${ref}" is ambiguous; use the device id`);
  throw new HttpError(404, `unknown device "${ref}"`);
}
/** Channel by id or (case-insensitive) name, so API/MCP callers can say "Team Telegram". */
export function resolveChannel(userId: string, ref: string): string {
  const byId = db.prepare("SELECT id FROM channels WHERE id = ? AND user_id = ?").get(ref, userId) as { id: string } | undefined;
  if (byId) return byId.id;
  const byName = db.prepare("SELECT id FROM channels WHERE user_id = ? AND lower(name) = lower(?)").all(userId, ref) as { id: string }[];
  if (byName.length === 1) return byName[0].id;
  if (byName.length > 1) throw new HttpError(400, `channel name "${ref}" is ambiguous; use the channel id`);
  throw new HttpError(404, `unknown channel "${ref}"`);
}
const checkChannel = (userId: string, ref: string | null | undefined) => (ref ? resolveChannel(userId, ref) : null);
type TargetIn = { deviceId?: string; device?: string; tag?: string } | null | undefined;
function normalizeTarget(userId: string, t: TargetIn) {
  if (!t) return null;
  const ref = t.deviceId ?? t.device;
  if (ref) return { deviceId: resolveDevice(userId, ref) };
  return t.tag ? { tag: t.tag } : null;
}
S("GET", "/api/jobs", (c) => {
  const limit = Math.min(Number(c.url.searchParams.get("limit") ?? 50) || 50, 200);
  const before = c.url.searchParams.get("before") ?? "9999";
  const all = c.url.searchParams.get("all") === "1" && c.user.role === "admin";
  const rows = (all
    ? db.prepare("SELECT * FROM jobs WHERE created_at < ? ORDER BY created_at DESC LIMIT ?").all(before, limit)
    : db.prepare("SELECT * FROM jobs WHERE user_id = ? AND created_at < ? ORDER BY created_at DESC LIMIT ?").all(c.user.id, before, limit)) as JobRow[];
  return rows.map((j) => jobView(j));
});
S("POST", "/api/jobs", (c) => {
  const b = parse(jobInput, c.body);
  return { __status: 202, id: createJob(c.user.id, { ...b, target: normalizeTarget(c.user.id, b.target), channelId: checkChannel(c.user.id, b.channelId) }, "dashboard") };
});
S("GET", "/api/jobs/:id", (c) => jobView(owned("jobs", c.params.id, c.user.id), true));
S("POST", "/api/jobs/:id/cancel", (c) => { owned("jobs", c.params.id, c.user.id); cancelJob(c.params.id); return ok; });
S("DELETE", "/api/jobs/:id", (c) => { owned("jobs", c.params.id, c.user.id); deleteJob(c.params.id); return ok; });

/** Send another message into the conversation a finished job used (same Chrome device if it still exists). */
const followupInput = z.object({
  prompt: z.string().min(1).max(20000),
  mode: z.enum(["image", "text", "auto"]).optional(),
  timeoutMs: z.number().int().positive().optional(),
  channelId: z.string().nullish(),
});
export function startFollowup(userId: string, parentId: string, b: z.infer<typeof followupInput>, source: string): string {
  const parent = owned("jobs", parentId, userId) as JobRow;
  const url = parent.chat_url || parent.conversation_url;
  if (!url) throw new HttpError(400, "this job has no conversation link (temporary chat or the URL was not detected), so it cannot be continued");
  const dev = parent.device_id ? (db.prepare("SELECT id FROM devices WHERE id = ? AND user_id = ?").get(parent.device_id, userId) as { id: string } | undefined) : undefined;
  const target = dev ? { deviceId: dev.id } : parent.target ? JSON.parse(parent.target) : null;
  return createJob(userId, {
    prompt: b.prompt, mode: b.mode ?? parent.mode, conversationUrl: url, target, timeoutMs: b.timeoutMs,
    channelId: checkChannel(userId, b.channelId), parentId,
  }, source);
}
S("POST", "/api/jobs/:id/followup", (c) => ({ __status: 202, id: startFollowup(c.user.id, c.params.id, parse(followupInput, c.body), "dashboard") }));

// ---------------------------------------------------------------- schedules
const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const scheduleBase = z.object({
  name: z.string().min(1).max(80),
  enabled: z.boolean().default(true),
  kind: z.enum(["daily", "interval"]),
  time: hhmm.nullish(),
  everyMinutes: z.number().int().min(5).max(10080).nullish(),
  activeFrom: hhmm.nullish(),
  activeTo: hhmm.nullish(),
  timezone: z.string().default("UTC"),
  prompt: z.string().min(1).max(20000),
  conversationUrl: z.string().url().regex(/^https:\/\/(chatgpt\.com|chat\.openai\.com)\//).nullish(),
  mode: z.enum(["image", "text", "auto"]).default("auto"),
  target: z.object({ deviceId: z.string().optional(), tag: z.string().optional() }).nullish(),
  channelId: z.string().nullish(),
  skipIfUnchanged: z.boolean().default(false),
  skipIfMatches: z.string().max(300).nullish(),
});
function scheduleView(s: any) {
  return {
    id: s.id, name: s.name, enabled: !!s.enabled, kind: s.kind, time: s.time, everyMinutes: s.every_minutes,
    activeFrom: s.active_from, activeTo: s.active_to, timezone: s.timezone, prompt: s.prompt,
    conversationUrl: s.conversation_url, mode: s.mode, target: s.target ? JSON.parse(s.target) : null,
    channelId: s.channel_id, skipIfUnchanged: !!s.skip_if_unchanged, skipIfMatches: s.skip_if_matches,
    lastRunAt: s.last_run_at, lastStatus: s.last_status, nextRunAt: nextRunAt(s),
  };
}
function validateSchedule(userId: string, v: z.infer<typeof scheduleBase>) {
  if (!validTz(v.timezone)) throw new HttpError(400, "invalid timezone");
  if (v.kind === "daily" && !v.time) throw new HttpError(400, "time is required for daily schedules");
  if (v.kind === "interval" && !v.everyMinutes) throw new HttpError(400, "everyMinutes is required for interval schedules");
  if (v.skipIfMatches) { try { new RegExp(v.skipIfMatches); } catch { throw new HttpError(400, "skipIfMatches is not a valid regex"); } }
  if (v.channelId) owned("channels", v.channelId, userId);
  if (v.target?.deviceId) deviceRow(v.target.deviceId, userId);
}
const toRow = (v: z.infer<typeof scheduleBase>) => [
  v.name, v.enabled ? 1 : 0, v.kind, v.kind === "daily" ? v.time : null, v.kind === "interval" ? v.everyMinutes : null,
  v.activeFrom ?? null, v.activeTo ?? null, v.timezone, v.prompt, v.conversationUrl ?? null, v.mode,
  v.target ? JSON.stringify(v.target) : null, v.channelId ?? null, v.skipIfUnchanged ? 1 : 0, v.skipIfMatches ?? null,
];
S("GET", "/api/schedules", (c) => (db.prepare("SELECT * FROM schedules WHERE user_id = ? ORDER BY created_at").all(c.user.id) as any[]).map(scheduleView));
S("POST", "/api/schedules", (c) => {
  const v = parse(scheduleBase, c.body);
  validateSchedule(c.user.id, v);
  const id = uid();
  db.prepare(`INSERT INTO schedules (name,enabled,kind,time,every_minutes,active_from,active_to,timezone,prompt,conversation_url,mode,target,channel_id,skip_if_unchanged,skip_if_matches,id,user_id,created_at)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(...toRow(v), id, c.user.id, now());
  return scheduleView(owned("schedules", id, c.user.id));
});
S("PATCH", "/api/schedules/:id", (c) => {
  const cur = scheduleView(owned("schedules", c.params.id, c.user.id));
  const v = parse(scheduleBase, { ...cur, ...c.body });
  validateSchedule(c.user.id, v);
  db.prepare(`UPDATE schedules SET name=?,enabled=?,kind=?,time=?,every_minutes=?,active_from=?,active_to=?,timezone=?,prompt=?,conversation_url=?,mode=?,target=?,channel_id=?,skip_if_unchanged=?,skip_if_matches=? WHERE id=?`)
    .run(...toRow(v), c.params.id);
  return scheduleView(owned("schedules", c.params.id, c.user.id));
});
S("DELETE", "/api/schedules/:id", (c) => { owned("schedules", c.params.id, c.user.id); db.prepare("DELETE FROM schedules WHERE id = ?").run(c.params.id); return ok; });
S("POST", "/api/schedules/:id/run", (c) => ({ jobId: runSchedule(owned("schedules", c.params.id, c.user.id)) }));

// ---------------------------------------------------------------- channels
const channelView = (r: any) => {
  const cfg = channelConfig(r);
  if (r.type === "webhook") {
    return {
      id: r.id, type: r.type, name: r.name,
      config: {
        url: cfg.url, method: cfg.method ?? "POST", headerNames: Object.keys(cfg.headers ?? {}), hasSecret: !!cfg.secret,
        includeImages: cfg.includeImages ?? "url", bodyTemplate: cfg.bodyTemplate ?? "",
      },
    };
  }
  return { id: r.id, type: r.type, name: r.name, config: { chatId: cfg.chatId, sendAs: cfg.sendAs ?? "photo", botTokenMasked: "••••" + cfg.botToken.slice(-4) } };
};
const channelCfg = z.object({ botToken: z.string().min(10).optional(), chatId: z.string().min(1), sendAs: z.enum(["photo", "document"]).default("photo") });
const webhookCfg = z.object({
  url: z.string().url().regex(/^https?:\/\//, "must be http(s)"),
  method: z.enum(["POST", "PUT", "PATCH"]).default("POST"),
  headers: z.record(z.string().regex(/^[\w-]+$/, "invalid header name"), z.string().max(2000)).default({}),
  secret: z.string().max(200).optional(),
  includeImages: z.enum(["none", "url", "base64"]).default("url"),
  bodyTemplate: z.string().max(10000).optional(),
});
S("GET", "/api/channels", (c) => (db.prepare("SELECT * FROM channels WHERE user_id = ?").all(c.user.id) as any[]).map(channelView));
S("POST", "/api/channels", async (c) => {
  const b = parse(z.discriminatedUnion("type", [
    z.object({ type: z.literal("telegram"), name: z.string().min(1).max(60), config: channelCfg.extend({ botToken: z.string().min(10) }) }),
    z.object({ type: z.literal("webhook"), name: z.string().min(1).max(60), config: webhookCfg }),
  ]), c.body);
  if (b.type === "webhook") { try { await assertSafeUrl(b.config.url); } catch (e) { throw new HttpError(400, (e as Error).message); } }
  const id = uid();
  db.prepare("INSERT INTO channels (id,user_id,type,name,config_enc,created_at) VALUES (?,?,?,?,?,?)")
    .run(id, c.user.id, b.type, b.name, encrypt(JSON.stringify(b.config)), now());
  return channelView(owned("channels", id, c.user.id));
});
S("PATCH", "/api/channels/:id", async (c) => {
  const r = owned("channels", c.params.id, c.user.id);
  const old = channelConfig(r);
  const name = parse(z.object({ name: z.string().min(1).max(60).optional() }).passthrough(), c.body).name;
  let cfg: any;
  if (r.type === "webhook") {
    const b = parse(z.object({ config: webhookCfg.partial().optional() }).passthrough(), c.body).config ?? {};
    cfg = { ...old, ...b };
    if (b.headers === undefined) cfg.headers = old.headers;            // omitted = keep existing header values
    if (b.secret === undefined) cfg.secret = old.secret;
    else if (b.secret === "") delete cfg.secret;                        // empty string clears the secret
    parse(webhookCfg, cfg);
    try { await assertSafeUrl(cfg.url); } catch (e) { throw new HttpError(400, (e as Error).message); }
  } else {
    const b = parse(z.object({ config: channelCfg.partial().optional() }).passthrough(), c.body).config ?? {};
    cfg = { ...old, ...b };
    if (!b.botToken) cfg.botToken = old.botToken;
  }
  db.prepare("UPDATE channels SET name = ?, config_enc = ? WHERE id = ?").run(name ?? r.name, encrypt(JSON.stringify(cfg)), r.id);
  return channelView(owned("channels", r.id, c.user.id));
});
S("DELETE", "/api/channels/:id", (c) => {
  owned("channels", c.params.id, c.user.id);
  db.prepare("UPDATE schedules SET channel_id = NULL WHERE channel_id = ?").run(c.params.id);
  db.prepare("UPDATE jobs SET channel_id = NULL WHERE channel_id = ?").run(c.params.id);
  db.prepare("DELETE FROM channels WHERE id = ?").run(c.params.id);
  return ok;
});
S("POST", "/api/channels/:id/test", async (c) => {
  const r = owned("channels", c.params.id, c.user.id);
  try {
    const cfg = channelConfig(r);
    if (r.type === "webhook") {
      const sample = { id: "test", user_id: c.user.id, device_id: null, state: "succeeded", mode: "text", prompt: "Test prompt", conversation_url: null, target: null, source: "test", schedule_id: null, timeout_ms: 0, text: "Hello from ChatGPT broker", markdown: "**Hello** from ChatGPT broker", error: null, progress: "[]", excluded: "[]", attempts: 1, channel_id: null, created_at: now(), started_at: now(), finished_at: now() } as JobRow;
      await deliverWebhook(cfg, buildPayload("channel.test", sample, null, cfg));
    } else {
      await tgText(cfg, "✅ ChatGPT broker test message");
    }
    return ok;
  } catch (e) { throw new HttpError(400, (e as Error).message); }
});

// ---------------------------------------------------------------- API keys
S("GET", "/api/keys", (c) => (db.prepare("SELECT id,name,prefix,created_at,last_used_at FROM api_keys WHERE user_id = ? ORDER BY created_at").all(c.user.id) as any[])
  .map((k) => ({ id: k.id, name: k.name, prefix: k.prefix, createdAt: k.created_at, lastUsedAt: k.last_used_at })));
S("POST", "/api/keys", (c) => {
  const b = parse(z.object({ name: z.string().min(1).max(60) }), c.body);
  const key = randomToken("ck_");
  const id = uid();
  db.prepare("INSERT INTO api_keys (id,user_id,name,prefix,hash,created_at) VALUES (?,?,?,?,?,?)").run(id, c.user.id, b.name, key.slice(0, 9), sha256(key), now());
  return { id, name: b.name, key };
});
S("DELETE", "/api/keys/:id", (c) => { owned("api_keys", c.params.id, c.user.id); db.prepare("DELETE FROM api_keys WHERE id = ?").run(c.params.id); return ok; });

// ---------------------------------------------------------------- admin
const adminUserView = (u: any) => ({
  id: u.id, email: u.email, name: u.name, role: u.role, disabled: !!u.disabled, createdAt: u.created_at,
  deviceCount: (db.prepare("SELECT COUNT(*) n FROM devices WHERE user_id = ?").get(u.id) as any).n,
});
A("GET", "/api/admin/users", () => (db.prepare("SELECT * FROM users ORDER BY created_at").all() as any[]).map(adminUserView));
A("POST", "/api/admin/users", (c) => {
  const b = parse(z.object({ email: z.string().email(), name: z.string().min(1).max(80), password: z.string().min(8).max(200), role: z.enum(["admin", "user"]).default("user") }), c.body);
  if (db.prepare("SELECT 1 FROM users WHERE email = ?").get(b.email.toLowerCase())) throw new HttpError(409, "email already exists");
  const id = uid();
  db.prepare("INSERT INTO users (id,email,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)").run(id, b.email.toLowerCase(), b.name, b.role, hashPassword(b.password), now());
  return adminUserView(db.prepare("SELECT * FROM users WHERE id = ?").get(id));
});
A("PATCH", "/api/admin/users/:id", (c) => {
  const u = db.prepare("SELECT * FROM users WHERE id = ?").get(c.params.id) as any;
  if (!u) throw new HttpError(404, "not found");
  const b = parse(z.object({ name: z.string().min(1).max(80).optional(), role: z.enum(["admin", "user"]).optional(), disabled: z.boolean().optional(), password: z.string().min(8).max(200).optional() }), c.body);
  if (u.id === c.user.id && (b.disabled || (b.role && b.role !== "admin"))) throw new HttpError(400, "you cannot disable or demote yourself");
  db.prepare("UPDATE users SET name=?, role=?, disabled=?, password_hash=? WHERE id=?")
    .run(b.name ?? u.name, b.role ?? u.role, (b.disabled ?? !!u.disabled) ? 1 : 0, b.password ? hashPassword(b.password) : u.password_hash, u.id);
  if (b.disabled || b.password) db.prepare("DELETE FROM sessions WHERE user_id = ?").run(u.id);
  return adminUserView(db.prepare("SELECT * FROM users WHERE id = ?").get(u.id));
});
A("DELETE", "/api/admin/users/:id", (c) => {
  if (c.params.id === c.user.id) throw new HttpError(400, "you cannot delete yourself");
  for (const d of db.prepare("SELECT id FROM devices WHERE user_id = ?").all(c.params.id) as { id: string }[]) disconnectDevice(d.id);
  db.prepare("DELETE FROM users WHERE id = ?").run(c.params.id);
  return ok;
});
A("GET", "/api/admin/stats", () => {
  const n = (sql: string, ...a: any[]) => (db.prepare(sql).get(...a) as any).n as number;
  const since = new Date(Date.now() - 86400_000).toISOString();
  const devices = (db.prepare("SELECT * FROM devices").all() as any[]).map(deviceView);
  return {
    users: n("SELECT COUNT(*) n FROM users"), devicesOnline: devices.filter((d) => d.status === "online").length, devicesTotal: devices.length,
    jobsQueued: n("SELECT COUNT(*) n FROM jobs WHERE state='queued'"), jobsRunning: n("SELECT COUNT(*) n FROM jobs WHERE state='running'"),
    jobs24h: n("SELECT COUNT(*) n FROM jobs WHERE created_at > ?", since), failed24h: n("SELECT COUNT(*) n FROM jobs WHERE state='failed' AND created_at > ?", since),
  };
});

// ---------------------------------------------------------------- public REST API (API key)
K("GET", "/v1/devices", (c) => (db.prepare("SELECT * FROM devices WHERE user_id = ?").all(c.user.id) as any[]).map(deviceView));
K("POST", "/v1/jobs", async (c) => {
  const b = parse(jobInput, c.body);
  const id = createJob(c.user.id, { ...b, target: normalizeTarget(c.user.id, b.target), channelId: checkChannel(c.user.id, b.channelId) }, "api");
  const wait = Math.min(Number(c.url.searchParams.get("wait") ?? 0) || 0, 180);
  if (!wait) return { __status: 202, id };
  return v1Job(await waitForJob(id, wait * 1000), c.url.searchParams.get("inline") === "1");
});
K("GET", "/v1/jobs/:id", (c) => v1Job(owned("jobs", c.params.id, c.user.id), c.url.searchParams.get("inline") === "1"));
K("POST", "/v1/jobs/:id/cancel", (c) => { owned("jobs", c.params.id, c.user.id); cancelJob(c.params.id); return ok; });
K("DELETE", "/v1/jobs/:id", (c) => { owned("jobs", c.params.id, c.user.id); deleteJob(c.params.id); return ok; });
K("POST", "/v1/jobs/:id/followup", async (c) => {
  const id = startFollowup(c.user.id, c.params.id, parse(followupInput, c.body), "api");
  const wait = Math.min(Number(c.url.searchParams.get("wait") ?? 0) || 0, 180);
  if (!wait) return { __status: 202, id };
  return v1Job(await waitForJob(id, wait * 1000), c.url.searchParams.get("inline") === "1");
});
function v1Job(j: JobRow, inline: boolean) {
  const v: any = jobView(j, true, true);
  if (inline) v.images = v.images.map((im: any, i: number) => ({ ...im, base64: readFileSync(jobImages(j.id)[i].file).toString("base64") }));
  return v;
}

// ---------------------------------------------------------------- files
export function serveFile(req: IncomingMessage, res: ServerResponse, url: URL): boolean {
  const m = /^\/files\/([\w-]+)\/(\d+)$/.exec(url.pathname);
  if (!m) return false;
  const [, jobId, idx] = m;
  const signedOk = checkSigned(url.pathname, url.searchParams.get("exp"), url.searchParams.get("sig"));
  if (!signedOk) {
    const u = sessionUser(req) ?? keyUser(req);
    const job = getJob(jobId);
    if (!u || !job || (job.user_id !== u.id && u.role !== "admin")) { json(res, 404, { error: "not found" }); return true; }
  }
  const img = jobImages(jobId).find((i) => i.idx === Number(idx));
  if (!img || !existsSync(img.file)) { json(res, 404, { error: "not found" }); return true; }
  res.writeHead(200, { "content-type": img.mime, "cache-control": "private, max-age=3600" }).end(readFileSync(img.file));
  return true;
}

// ---------------------------------------------------------------- dispatcher
export async function handleApi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  const method = req.method ?? "GET";
  if (url.pathname.startsWith("/api/device/") && method === "OPTIONS") {
    res.writeHead(204, { "access-control-allow-origin": "*", "access-control-allow-methods": "POST, OPTIONS", "access-control-allow-headers": "content-type" }).end();
    return true;
  }
  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.re.exec(url.pathname);
    if (!m) continue;
    try {
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
      let user: User | null = null;
      if (r.auth === "session") {
        user = sessionUser(req);
        if (!user) throw new HttpError(401, "not logged in");
        if (method !== "GET" && req.headers["x-requested-with"] !== "dashboard") throw new HttpError(403, "missing X-Requested-With header");
        if (r.admin && user.role !== "admin") throw new HttpError(403, "admin only");
      } else if (r.auth === "key") {
        user = keyUser(req);
        if (!user) throw new HttpError(401, "invalid API key");
      }
      const body = method === "GET" || method === "DELETE" ? {} : await readBody(req);
      const out: any = await r.h({ req, res, url, params, body, user: user as User });
      if (!res.writableEnded) {
        const status = out?.__status ?? 200;
        if (out?.__status) delete out.__status;
        json(res, status, out, url.pathname.startsWith("/api/device/") ? { "access-control-allow-origin": "*" } : {});
      }
    } catch (e) {
      const status = e instanceof HttpError ? e.status : 500;
      if (status === 500) console.error("[api]", e);
      json(res, status, { error: status === 500 ? "internal error" : (e as Error).message },
        url.pathname.startsWith("/api/device/") ? { "access-control-allow-origin": "*" } : {});
    }
    return true;
  }
  return false;
}
export { decrypt, finish };
