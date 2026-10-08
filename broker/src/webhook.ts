import { createHmac } from "node:crypto";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { readFileSync } from "node:fs";
import { signedQuery } from "./util.js";
import { jobImages, type JobRow } from "./engine.js";

export type WebhookCfg = {
  url: string;
  method?: "POST" | "PUT" | "PATCH";
  headers?: Record<string, string>;
  secret?: string;                              // HMAC-SHA256 signing secret (X-Broker-Signature)
  includeImages?: "none" | "url" | "base64";
  bodyTemplate?: string;                        // optional custom body, see buildBody()
};

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[webhook]", ...a);
const BASE_URL = (process.env.BASE_URL ?? (process.env.DOMAIN ? `https://${process.env.DOMAIN}` : "")).replace(/\/+$/, "");
const FORBIDDEN_HEADERS = new Set(["host", "content-length", "connection", "transfer-encoding"]);

// ---------------------------------------------------------------- SSRF guard
function privateV4(ip: string): boolean {
  const [a, b] = ip.split(".").map(Number);
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}
function privateIp(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip);
  const l = ip.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(l);
  if (mapped) return privateV4(mapped[1]);
  return l === "::1" || l === "::" || l.startsWith("fc") || l.startsWith("fd") || l.startsWith("fe8") || l.startsWith("fe9") || l.startsWith("fea") || l.startsWith("feb");
}
export async function assertSafeUrl(raw: string) {
  const u = new URL(raw);
  if (u.protocol !== "http:" && u.protocol !== "https:") throw new Error("webhook URL must be http(s)");
  if (process.env.WEBHOOK_ALLOW_PRIVATE === "1") return u;
  const addrs = isIP(u.hostname) ? [{ address: u.hostname }] : await lookup(u.hostname, { all: true });
  for (const a of addrs) {
    if (privateIp(a.address)) throw new Error("webhook URL resolves to a private/loopback address (set WEBHOOK_ALLOW_PRIVATE=1 to allow internal targets)");
  }
  return u;
}

// ---------------------------------------------------------------- payload
export function buildPayload(event: string, job: JobRow | null, schedule: { id: string; name: string } | null, cfg: WebhookCfg, deviceLabel: string | null = null) {
  const imgs = job ? jobImages(job.id) : [];
  const mode = cfg.includeImages ?? "url";
  return {
    event,
    sentAt: new Date().toISOString(),
    job: job && {
      id: job.id, state: job.state, mode: job.mode, prompt: job.prompt, error: job.error, source: job.source,
      createdAt: job.created_at, finishedAt: job.finished_at, device: deviceLabel,
    },
    schedule,
    result: job && {
      text: job.text ?? "",
      markdown: job.markdown || job.text || "",
      images: mode === "none" ? [] : imgs.map((i) => {
        const path = `/files/${job.id}/${i.idx}`;
        return mode === "base64"
          ? { mime: i.mime, base64: readFileSync(i.file).toString("base64") }
          : { mime: i.mime, url: `${BASE_URL}${path}?${signedQuery(path, 7 * 86400_000)}` };
      }),
    },
  };
}

/** Custom body: {{text}} {{markdown}} {{prompt}} {{error}} {{state}} {{jobId}} {{scheduleName}} {{event}} are JSON-string-escaped; {{json}} is the whole payload. */
export function buildBody(payload: ReturnType<typeof buildPayload>, tpl?: string): string {
  if (!tpl?.trim()) return JSON.stringify(payload);
  const esc = (v: unknown) => JSON.stringify(String(v ?? "")).slice(1, -1);
  const vars: Record<string, string> = {
    text: esc(payload.result?.text), markdown: esc(payload.result?.markdown), prompt: esc(payload.job?.prompt),
    error: esc(payload.job?.error), state: esc(payload.job?.state), jobId: esc(payload.job?.id),
    scheduleName: esc(payload.schedule?.name), event: esc(payload.event), json: JSON.stringify(payload),
  };
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (k in vars ? vars[k] : m));
}

// ---------------------------------------------------------------- delivery
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function deliverWebhook(cfg: WebhookCfg, payload: ReturnType<typeof buildPayload>) {
  const body = buildBody(payload, cfg.bodyTemplate);
  const headers: Record<string, string> = { "content-type": "application/json", "user-agent": "browser-llm-broker/1.0", "x-broker-event": payload.event };
  for (const [k, v] of Object.entries(cfg.headers ?? {})) if (!FORBIDDEN_HEADERS.has(k.toLowerCase())) headers[k.toLowerCase()] = v;
  if (cfg.secret) {
    const ts = String(Math.floor(Date.now() / 1000));
    headers["x-broker-timestamp"] = ts;
    headers["x-broker-signature"] = "sha256=" + createHmac("sha256", cfg.secret).update(`${ts}.${body}`).digest("hex");
  }
  let lastErr = "";
  for (const [attempt, delay] of [[1, 0], [2, 2000], [3, 10000]] as const) {
    if (delay) await sleep(delay);
    try {
      const u = await assertSafeUrl(cfg.url);
      const r = await fetch(u, { method: cfg.method ?? "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(15_000) });
      if (r.status >= 200 && r.status < 300) return;
      lastErr = `HTTP ${r.status}${r.status >= 300 && r.status < 400 ? " (redirects are not followed)" : ""}`;
      if (r.status < 500 && r.status !== 429) break; // client errors will not fix themselves
    } catch (e) {
      lastErr = (e as Error).message;
      if (/private\/loopback|must be http/.test(lastErr)) break;
    }
    log(`attempt ${attempt} failed: ${lastErr}`);
  }
  throw new Error(`Webhook delivery failed: ${lastErr}`);
}
