import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { db, now } from "./db.js";
import { decrypt } from "./util.js";
import { jobImages, type JobRow } from "./engine.js";
import { buildPayload, deliverWebhook } from "./webhook.js";

export type TelegramCfg = { botToken: string; chatId: string; sendAs?: "photo" | "document" };
const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[notify]", ...a);

async function tg(cfg: TelegramCfg, method: string, form: FormData) {
  const r = await fetch(`https://api.telegram.org/bot${cfg.botToken}/${method}`, { method: "POST", body: form });
  const j: any = await r.json().catch(() => ({}));
  if (!r.ok || !j.ok) throw new Error(`Telegram ${method} failed: ${j.description ?? r.status}`);
}
const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Markdown -> the small HTML subset Telegram supports (b, i, code, pre, a). */
export function mdToTelegramHtml(md: string): string {
  const blocks: string[] = [];
  let s = md.replace(/```(\w*)\n([\s\S]*?)```/g, (_, _l, code) => { blocks.push(`<pre>${esc(code.replace(/\n$/, ""))}</pre>`); return `\u0000${blocks.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/`([^`\n]+)`/g, (_, c) => `<code>${c}</code>`)
    .replace(/^#{1,6}\s+(.+)$/gm, "<b>$1</b>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<i>$2</i>")
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/^(\s*)[-*]\s+/gm, "$1• ")
    .replace(/^&gt;\s?/gm, "▏");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => blocks[Number(i)]);
}

function chunks(text: string, max = 3500): string[] {
  const out: string[] = [];
  let cur = "";
  for (const para of text.split("\n\n")) {
    if (cur && (cur + "\n\n" + para).length > max) { out.push(cur); cur = ""; }
    cur = cur ? cur + "\n\n" + para : para;
    while (cur.length > max) { out.push(cur.slice(0, max)); cur = cur.slice(max); }
  }
  if (cur) out.push(cur);
  return out.length ? out : [""];
}

/** Sends formatted (HTML) text; falls back to plain text if Telegram rejects the markup. */
export async function tgMarkdown(cfg: TelegramCfg, md: string) {
  for (const part of chunks(md)) {
    try {
      const f = new FormData();
      f.set("chat_id", cfg.chatId);
      f.set("text", mdToTelegramHtml(part));
      f.set("parse_mode", "HTML");
      f.set("disable_web_page_preview", "true");
      await tg(cfg, "sendMessage", f);
    } catch {
      await tgText(cfg, part);
    }
  }
}

export async function tgText(cfg: TelegramCfg, text: string) {
  for (let i = 0; i < Math.max(text.length, 1); i += 4000) {
    const f = new FormData();
    f.set("chat_id", cfg.chatId);
    f.set("text", text.slice(i, i + 4000));
    await tg(cfg, "sendMessage", f);
  }
}
async function tgImage(cfg: TelegramCfg, mime: string, data: Buffer, caption: string) {
  const asDoc = cfg.sendAs === "document";
  const f = new FormData();
  f.set("chat_id", cfg.chatId);
  f.set("caption", caption.slice(0, 1000));
  f.set(asDoc ? "document" : "photo", new Blob([new Uint8Array(data)], { type: mime }), `image.${mime.split("/")[1] ?? "png"}`);
  await tg(cfg, asDoc ? "sendDocument" : "sendPhoto", f);
}

export function channelConfig(row: { config_enc: string }): any {
  return JSON.parse(decrypt(row.config_enc));
}

/** Called for every finished job. Delivers to the job's channel, or to its schedule's channel. */
export async function onJobFinished(job: JobRow) {
  const s = job.schedule_id ? (db.prepare("SELECT * FROM schedules WHERE id = ?").get(job.schedule_id) as any) : null;
  const channelId = job.channel_id ?? s?.channel_id ?? null;
  const setStatus = (st: string) => { if (s) db.prepare("UPDATE schedules SET last_status = ? WHERE id = ?").run(st, s.id); };
  const ch = channelId ? (db.prepare("SELECT * FROM channels WHERE id = ? AND user_id = ?").get(channelId, job.user_id) as any) : null;

  try {
    if (!ch) {
      if (job.state !== "succeeded") setStatus(`${job.state}: ${job.error ?? ""}`.slice(0, 200));
      else if (s) setStatus("done (no channel)");
      return;
    }
    const cfg = channelConfig(ch);
    const imgs = job.state === "succeeded" ? jobImages(job.id) : [];
    const text = (job.text ?? "").trim();
    const rich = (job.markdown || job.text || "").trim();

    // Text-only schedule results can be filtered to avoid repeats / empty updates.
    if (s && job.state === "succeeded" && !imgs.length && text) {
      if (s.skip_if_matches && new RegExp(s.skip_if_matches, "i").test(text)) return setStatus("skipped (matches filter)");
      const hash = createHash("sha1").update(text).digest("hex");
      if (s.skip_if_unchanged && s.last_hash === hash) return setStatus("skipped (unchanged)");
      db.prepare("UPDATE schedules SET last_hash = ? WHERE id = ?").run(hash, s.id);
    }

    if (ch.type === "webhook") {
      const dev = job.device_id ? (db.prepare("SELECT label FROM devices WHERE id = ?").get(job.device_id) as any)?.label ?? null : null;
      await deliverWebhook(cfg, buildPayload("job.finished", job, s && { id: s.id, name: s.name }, cfg, dev));
      return setStatus(job.state === "succeeded" ? "sent to webhook" : `${job.state} (webhook notified)`);
    }

    // Telegram
    const name = s?.name ?? "Job";
    const stamp = `${name} — ${new Date().toLocaleString("en-GB", { timeZone: s?.timezone ?? "UTC" })}`;
    if (job.state !== "succeeded") {
      setStatus(`${job.state}: ${job.error ?? ""}`.slice(0, 200));
      return await tgText(cfg, `⚠️ "${name}" ${job.state}: ${job.error ?? ""}`);
    }
    if (imgs.length) {
      for (const i of imgs) await tgImage(cfg, i.mime, readFileSync(i.file), stamp);
      if (text && job.mode !== "image") await tgMarkdown(cfg, rich);
      return setStatus(`sent ${imgs.length} image(s)`);
    }
    if (!text) { setStatus("empty reply"); return await tgText(cfg, `⚠️ "${name}": empty reply`); }
    await tgMarkdown(cfg, `**${stamp}**\n\n${rich}`);
    setStatus(`sent text (${text.length} chars)`);
  } catch (e) {
    log(`job ${job.id}:`, (e as Error).message);
    setStatus(`notify failed: ${(e as Error).message}`.slice(0, 200));
  }
}
