import { db, now } from "./db.js";
import { createJob } from "./engine.js";

const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[scheduler]", ...a);
const CATCH_UP_MIN = Number(process.env.CATCH_UP_MINUTES ?? 120);

const hhmm = (s: string) => { const [h, m] = s.split(":").map(Number); return h * 60 + m; };

export function localParts(date: Date, tz: string) {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", { timeZone: tz, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" })
      .formatToParts(date).map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}`, minutes: Number(p.hour) * 60 + Number(p.minute) };
}
export const validTz = (tz: string) => { try { new Intl.DateTimeFormat("en", { timeZone: tz }); return true; } catch { return false; } };

export function nextRunAt(s: any): string | null {
  if (!s.enabled) return null;
  if (s.kind === "interval" && s.every_minutes)
    return new Date(s.last_run_at ? Date.parse(s.last_run_at) + s.every_minutes * 60_000 : Date.now()).toISOString();
  if (s.kind === "daily" && s.time) {
    // Scan forward minute-by-minute is wasteful; step by 15 min over the next 48h then refine.
    const target = hhmm(s.time);
    for (let t = Date.now(); t < Date.now() + 49 * 3600_000; t += 60_000) {
      const lp = localParts(new Date(t), s.timezone);
      if (lp.minutes === target && lp.date !== (s.last_run_at ? localParts(new Date(s.last_run_at), s.timezone).date : "")) return new Date(Math.floor(t / 60000) * 60000).toISOString();
    }
  }
  return null;
}

export function runSchedule(s: any): string {
  const target = s.target ? JSON.parse(s.target) : null;
  const id = createJob(s.user_id, { prompt: s.prompt, mode: s.mode, conversationUrl: s.conversation_url, target }, "schedule", s.id);
  db.prepare("UPDATE schedules SET last_run_at = ?, last_status = 'queued' WHERE id = ?").run(now(), s.id);
  return id;
}

function tick() {
  const rows = db.prepare("SELECT * FROM schedules WHERE enabled = 1").all() as any[];
  for (const s of rows) {
    const busy = db.prepare("SELECT 1 FROM jobs WHERE schedule_id = ? AND state IN ('queued','running')").get(s.id);
    if (busy) continue;
    const lp = localParts(new Date(), s.timezone);
    let due = false;
    if (s.kind === "interval" && s.every_minutes) {
      const inWindow = (!s.active_from || lp.minutes >= hhmm(s.active_from)) && (!s.active_to || lp.minutes <= hhmm(s.active_to));
      due = inWindow && Date.now() - Date.parse(s.last_run_at ?? "1970-01-01") >= s.every_minutes * 60_000;
    } else if (s.kind === "daily" && s.time) {
      const late = lp.minutes - hhmm(s.time);
      const lastDate = s.last_run_at ? localParts(new Date(s.last_run_at), s.timezone).date : "";
      due = lastDate !== lp.date && late >= 0 && late <= CATCH_UP_MIN;
    }
    if (due) { log(`running "${s.name}" (${s.id})`); runSchedule(s); }
  }
}
export function startScheduler() { setInterval(tick, 30_000).unref(); tick(); }
