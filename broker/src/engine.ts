import type { WebSocket } from "ws";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { db, DATA_DIR, now, uid } from "./db.js";
import { sha256, signedQuery } from "./util.js";

export type Mode = "image" | "text" | "auto";
export type Target = { deviceId?: string; tag?: string } | null;
export type JobRow = {
  id: string; user_id: string; device_id: string | null; state: string; mode: Mode; prompt: string;
  conversation_url: string | null; target: string | null; source: string; schedule_id: string | null;
  timeout_ms: number; text: string | null; markdown: string | null; error: string | null; progress: string; excluded: string;
  attempts: number; channel_id: string | null; chat_url: string | null; parent_id: string | null; created_at: string; started_at: string | null; finished_at: string | null;
};
type DeviceRow = {
  id: string; user_id: string; label: string; tags: string; token_hash: string; paused: number;
  limited_until: string | null; ext_version: string | null; last_seen_at: string | null; last_job_at: string | null; created_at: string;
};
type Conn = { ws: WebSocket; deviceId: string; userId: string; busyJob: string | null; lastPong: number };

const QUEUE_TIMEOUT_MS = Number(process.env.QUEUE_TIMEOUT_MS ?? 10 * 60_000);
const SCHEDULE_QUEUE_TIMEOUT_MS = 30 * 60_000;
const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[engine]", ...a);

const conns = new Map<string, Conn>();
const started = new Set<string>();            // jobIds the device has acknowledged
const timers = new Map<string, NodeJS.Timeout>();
const waiters = new Map<string, Array<() => void>>();
let onFinished: (job: JobRow) => void = () => {};
export const setOnFinished = (fn: (job: JobRow) => void) => { onFinished = fn; };

export const getJob = (id: string) => db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
const getDevice = (id: string) => db.prepare("SELECT * FROM devices WHERE id = ?").get(id) as DeviceRow | undefined;

// ---------------------------------------------------------------- devices
export function deviceView(d: DeviceRow) {
  const c = conns.get(d.id);
  const limited = !!d.limited_until && d.limited_until > now();
  const status = d.paused ? "paused" : !c ? "offline" : limited ? "limited" : "online";
  return {
    id: d.id, label: d.label, tags: JSON.parse(d.tags), status, paused: !!d.paused,
    limitedUntil: limited ? d.limited_until : null, extVersion: d.ext_version, lastSeenAt: d.last_seen_at,
    lastJobAt: d.last_job_at, currentJobId: c?.busyJob ?? null, createdAt: d.created_at,
  };
}

export function attachDevice(ws: WebSocket, device: DeviceRow, version: string | null) {
  const old = conns.get(device.id);
  if (old) { old.ws.close(4002, "replaced by a newer connection"); onDisconnect(old, true); }
  const conn: Conn = { ws, deviceId: device.id, userId: device.user_id, busyJob: null, lastPong: Date.now() };
  conns.set(device.id, conn);
  db.prepare("UPDATE devices SET ext_version = ?, last_seen_at = ? WHERE id = ?").run(version, now(), device.id);
  log(`device online ${device.label} (${device.id})`);

  ws.on("pong", () => { conn.lastPong = Date.now(); });
  ws.on("message", (raw) => {
    conn.lastPong = Date.now();
    let m: any;
    try { m = JSON.parse(raw.toString()); } catch { return; }
    handleDeviceMessage(conn, m);
  });
  ws.on("close", () => { if (conns.get(device.id) === conn) onDisconnect(conn, false); });
  ws.on("error", () => {});
  dispatch();
}

function onDisconnect(conn: Conn, replaced: boolean) {
  if (conns.get(conn.deviceId) === conn) conns.delete(conn.deviceId);
  db.prepare("UPDATE devices SET last_seen_at = ? WHERE id = ?").run(now(), conn.deviceId);
  if (!replaced) log(`device offline ${conn.deviceId}`);
  const jobId = conn.busyJob;
  conn.busyJob = null;
  if (!jobId) return;
  const job = getJob(jobId);
  if (!job || job.state !== "running") return;
  clearTimer(jobId);
  if (!started.has(jobId)) {
    // Prompt was never acknowledged as started: safe to run it elsewhere.
    db.prepare("UPDATE jobs SET state='queued', device_id=NULL, started_at=NULL WHERE id = ?").run(jobId);
    log(`job ${jobId} requeued after device disconnect`);
    dispatch();
  } else {
    // Prompt may already be sent: don't auto-retry (would burn quota / duplicate output).
    finish(jobId, "failed", { error: "Device disconnected during the job (result unknown; retry manually)" });
  }
}

function handleDeviceMessage(conn: Conn, m: any) {
  if (m.type === "ping") { conn.ws.send(JSON.stringify({ type: "pong" })); return; }
  const job = m.id ? getJob(m.id) : undefined;
  if (!job || job.device_id !== conn.deviceId || job.state !== "running") return;

  if (m.type === "started") { started.add(job.id); return; }
  if (m.type === "progress") {
    const p = JSON.parse(job.progress) as { ts: string; message: string }[];
    p.push({ ts: now(), message: String(m.message ?? "").slice(0, 3000) });
    db.prepare("UPDATE jobs SET progress = ? WHERE id = ?").run(JSON.stringify(p.slice(-50)), job.id);
    return;
  }
  if (m.type === "result") {
    const dir = join(DATA_DIR, "images", job.id);
    mkdirSync(dir, { recursive: true });
    let i = 0;
    for (const img of (m.images ?? []) as { mime: string; base64: string }[]) {
      const ext = (img.mime.split("/")[1] ?? "png").split("+")[0].replace(/[^a-z0-9]/gi, "") || "png";
      const file = join(dir, `${i}.${ext}`);
      writeFileSync(file, Buffer.from(img.base64, "base64"));
      db.prepare("INSERT OR REPLACE INTO job_images (job_id, idx, mime, file) VALUES (?,?,?,?)").run(job.id, i, img.mime, file);
      i++;
    }
    const cu = typeof m.conversationUrl === "string" && /^https:\/\/(chatgpt\.com|chat\.openai\.com)\/c\/[\w-]+/.test(m.conversationUrl) ? m.conversationUrl : null;
    if (cu) db.prepare("UPDATE jobs SET chat_url = ? WHERE id = ?").run(cu, job.id);
    finish(job.id, "succeeded", { text: String(m.text ?? ""), markdown: String(m.markdown ?? "") });
    return;
  }
  if (m.type === "error") {
    const msg = String(m.message ?? "extension error");
    if (m.code === "usage_limit") {
      const until = m.resetsAt && !isNaN(Date.parse(m.resetsAt)) ? new Date(m.resetsAt).toISOString() : new Date(Date.now() + 3600_000).toISOString();
      db.prepare("UPDATE devices SET limited_until = ? WHERE id = ?").run(until, conn.deviceId);
      log(`device ${conn.deviceId} limited until ${until}`);
      const excluded = JSON.parse(job.excluded) as string[];
      excluded.push(conn.deviceId);
      if (job.attempts < 3) { // try another device of the same user
        release(job);
        db.prepare("UPDATE jobs SET state='queued', device_id=NULL, started_at=NULL, excluded=? WHERE id = ?").run(JSON.stringify(excluded), job.id);
        started.delete(job.id);
        dispatch();
        return;
      }
    }
    finish(job.id, "failed", { error: msg });
  }
}

// ---------------------------------------------------------------- jobs
export type NewJob = { parentId?: string | null; channelId?: string | null; prompt: string; mode?: Mode; conversationUrl?: string | null; target?: Target; timeoutMs?: number };

export function createJob(userId: string, input: NewJob, source: string, scheduleId: string | null = null): string {
  const id = uid();
  db.prepare(`INSERT INTO jobs (id,user_id,state,mode,prompt,conversation_url,target,source,schedule_id,timeout_ms,created_at,channel_id,parent_id)
              VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, userId, "queued", input.mode ?? "auto", input.prompt, input.conversationUrl ?? null,
    input.target ? JSON.stringify(input.target) : null, source, scheduleId,
    Math.min(Math.max(input.timeoutMs ?? 240_000, 30_000), 900_000), now(), input.channelId ?? null, input.parentId ?? null);
  dispatch();
  return id;
}

function eligible(job: JobRow, c: Conn): boolean {
  if (c.busyJob || c.userId !== job.user_id || c.ws.readyState !== 1) return false;
  if ((JSON.parse(job.excluded) as string[]).includes(c.deviceId)) return false;
  const d = getDevice(c.deviceId);
  if (!d || d.paused || (d.limited_until && d.limited_until > now())) return false;
  const t: Target = job.target ? JSON.parse(job.target) : null;
  if (t?.deviceId && t.deviceId !== d.id) return false;
  if (t?.tag && !(JSON.parse(d.tags) as string[]).includes(t.tag)) return false;
  return true;
}

export function dispatch() {
  const queued = db.prepare("SELECT * FROM jobs WHERE state='queued' ORDER BY created_at").all() as JobRow[];
  for (const job of queued) {
    const cands = [...conns.values()].filter((c) => eligible(job, c));
    if (!cands.length) continue;
    // Least-recently-used device first.
    cands.sort((a, b) => (getDevice(a.deviceId)!.last_job_at ?? "").localeCompare(getDevice(b.deviceId)!.last_job_at ?? ""));
    const c = cands[0];
    c.busyJob = job.id;
    db.prepare("UPDATE jobs SET state='running', device_id=?, started_at=?, attempts=attempts+1 WHERE id = ?").run(c.deviceId, now(), job.id);
    db.prepare("UPDATE devices SET last_job_at = ? WHERE id = ?").run(now(), c.deviceId);
    timers.set(job.id, setTimeout(() => {
      const j = getJob(job.id);
      if (j?.state === "running") finish(job.id, "failed", { error: `Timed out after ${Math.round(job.timeout_ms / 1000)}s` });
    }, job.timeout_ms + 30_000));
    c.ws.send(JSON.stringify({
      type: "generate_image", id: job.id, prompt: job.prompt, timeoutMs: job.timeout_ms,
      conversationUrl: job.conversation_url ?? undefined, mode: job.mode,
    }));
    log(`job ${job.id} → device ${c.deviceId}`);
  }
}

function clearTimer(jobId: string) { const t = timers.get(jobId); if (t) clearTimeout(t); timers.delete(jobId); }
function release(job: JobRow) {
  clearTimer(job.id);
  if (job.device_id) { const c = conns.get(job.device_id); if (c?.busyJob === job.id) c.busyJob = null; }
}

export function finish(jobId: string, state: "succeeded" | "failed" | "canceled", extra: { text?: string; markdown?: string; error?: string } = {}) {
  const job = getJob(jobId);
  if (!job || job.state === "succeeded" || job.state === "failed" || job.state === "canceled") return;
  release(job);
  started.delete(jobId);
  db.prepare("UPDATE jobs SET state=?, text=COALESCE(?,text), markdown=COALESCE(?,markdown), error=?, finished_at=? WHERE id = ?")
    .run(state, extra.text ?? null, extra.markdown || null, extra.error ?? null, now(), jobId);
  for (const w of waiters.get(jobId) ?? []) w();
  waiters.delete(jobId);
  const done = getJob(jobId)!;
  try { onFinished(done); } catch (e) { log("onFinished error", (e as Error).message); }
  dispatch();
}

export function cancelJob(jobId: string) {
  const job = getJob(jobId);
  if (!job) return false;
  if (job.state === "running" && job.device_id) conns.get(job.device_id)?.ws.send(JSON.stringify({ type: "cancel", id: jobId }));
  finish(jobId, "canceled", { error: "Canceled" });
  return true;
}

export function waitForJob(jobId: string, ms: number): Promise<JobRow> {
  return new Promise((resolve) => {
    const j = getJob(jobId)!;
    if (["succeeded", "failed", "canceled"].includes(j.state)) return resolve(j);
    const t = setTimeout(() => resolve(getJob(jobId)!), ms);
    const arr = waiters.get(jobId) ?? [];
    arr.push(() => { clearTimeout(t); resolve(getJob(jobId)!); });
    waiters.set(jobId, arr);
  });
}

export function deleteJob(jobId: string) {
  const job = getJob(jobId);
  if (!job) return false;
  if (job.state === "queued" || job.state === "running") cancelJob(jobId);
  rmSync(join(DATA_DIR, "images", jobId), { recursive: true, force: true });
  db.prepare("UPDATE jobs SET parent_id = NULL WHERE parent_id = ?").run(jobId);
  db.prepare("DELETE FROM jobs WHERE id = ?").run(jobId);
  return true;
}

export function jobImages(jobId: string) {
  return db.prepare("SELECT idx, mime, file FROM job_images WHERE job_id = ? ORDER BY idx").all(jobId) as { idx: number; mime: string; file: string }[];
}

export function jobView(j: JobRow, full = false, signed = false) {
  const dev = j.device_id ? getDevice(j.device_id) : undefined;
  const imgs = jobImages(j.id);
  const base = {
    id: j.id, state: j.state, mode: j.mode, promptPreview: j.prompt.slice(0, 120), deviceId: j.device_id,
    deviceLabel: dev?.label ?? null, source: j.source, createdAt: j.created_at, startedAt: j.started_at,
    finishedAt: j.finished_at, error: j.error, imageCount: imgs.length,
  };
  if (!full) return base;
  return {
    ...base, prompt: j.prompt, conversationUrl: j.conversation_url, text: j.text ?? "", markdown: j.markdown || j.text || "", chatUrl: j.chat_url || j.conversation_url || null, parentId: j.parent_id,
    images: imgs.map((i) => {
      const path = `/files/${j.id}/${i.idx}`;
      return { url: signed ? `${path}?${signedQuery(path)}` : path, mime: i.mime };
    }),
    progress: JSON.parse(j.progress), target: j.target ? JSON.parse(j.target) : null,
  };
}

export function disconnectDevice(deviceId: string) {
  const c = conns.get(deviceId);
  if (c) { c.ws.close(4003, "device removed"); onDisconnect(c, false); }
}
export const isConnected = (deviceId: string) => conns.has(deviceId);

// ---------------------------------------------------------------- housekeeping
setInterval(() => {
  const t = Date.now();
  for (const c of conns.values()) {
    if (t - c.lastPong > 70_000) { c.ws.terminate(); continue; }
    try { c.ws.ping(); } catch {}
  }
  const q = db.prepare("SELECT id, source, created_at FROM jobs WHERE state='queued'").all() as { id: string; source: string; created_at: string }[];
  for (const j of q) {
    const limit = j.source === "schedule" ? SCHEDULE_QUEUE_TIMEOUT_MS : QUEUE_TIMEOUT_MS;
    if (t - Date.parse(j.created_at) > limit) finish(j.id, "failed", { error: "No device available (offline, busy, paused or at usage limit)" });
  }
}, 15_000).unref();

const RETENTION_DAYS = Number(process.env.RETENTION_DAYS ?? 14);
setInterval(() => {
  const cutoff = new Date(Date.now() - RETENTION_DAYS * 86400_000).toISOString();
  const old = db.prepare("SELECT id FROM jobs WHERE created_at < ? AND state IN ('succeeded','failed','canceled')").all(cutoff) as { id: string }[];
  for (const j of old) {
    rmSync(join(DATA_DIR, "images", j.id), { recursive: true, force: true });
    db.prepare("DELETE FROM jobs WHERE id = ?").run(j.id);
  }
  db.prepare("DELETE FROM sessions WHERE expires_at < ?").run(now());
  db.prepare("DELETE FROM pairing_codes WHERE expires_at < ?").run(now());
}, 3600_000).unref();

// Jobs left 'running' by a previous process can never finish: fail them at startup.
db.prepare("UPDATE jobs SET state='failed', error='Server restarted during the job', finished_at=? WHERE state='running'").run(now());
export { sha256 };
