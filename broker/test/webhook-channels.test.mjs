// Integration test (see test/run.mjs). Talks to a real broker process with a fake Chrome extension.
import http from "node:http"; import { createHmac } from "node:crypto";
import WebSocket from "ws";
const got = []; let failFirst = 0;
const rx = http.createServer((req, res) => { let b = ""; req.on("data", d => b += d); req.on("end", () => { got.push({ url: req.url, h: req.headers, b }); if (req.url === "/flaky" && failFirst++ < 1) { res.writeHead(500).end(); return; } res.writeHead(200).end("ok"); }); }).listen(9099);
const B = process.env.BASE_URL; let cookie = "";
const api = async (m, p, b) => { const r = await fetch(B + p, { method: m, headers: { "content-type": "application/json", "x-requested-with": "dashboard", cookie }, body: b ? JSON.stringify(b) : undefined }); const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0]; return { s: r.status, j: await r.json().catch(() => null) }; };
const ck = (n, c, x = "") => console.log((c ? "PASS " : "FAIL ") + n + (c ? "" : " " + JSON.stringify(x)));
const sleep = ms => new Promise(r => setTimeout(r, ms));
await api("POST", "/api/auth/login", { email: "admin@x.io", password: "adminpass1" });
// fake device
const pc = await api("POST", "/api/devices/pairing");
const pj = await (await fetch(B + "/api/device/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pc.j.code, label: "D1" }) })).json();
const ws = new WebSocket(B.replace(/^http/, "ws") + "/ws");
ws.on("message", raw => { const m = JSON.parse(raw); if (m.type === "generate_image") { ws.send(JSON.stringify({ type: "started", id: m.id })); ws.send(JSON.stringify({ type: "result", id: m.id, text: "plain", markdown: "**md** \"q\"", images: m.mode === "text" ? [] : [{ mime: "image/png", base64: "iVBORw0KGgo=" }] })); } });
await new Promise(r => ws.on("open", r)); ws.send(JSON.stringify({ type: "auth", token: pj.deviceToken })); await sleep(300);

// 1) webhook channel create (private target allowed in this run)
const ch = await api("POST", "/api/channels", { type: "webhook", name: "hook", config: { url: "http://127.0.0.1:9099/hook", headers: { "X-Api-Key": "k123" }, secret: "s3cret", includeImages: "base64" } });
ck("webhook channel created", ch.s === 200 && ch.j.config.headerNames[0] === "X-Api-Key" && ch.j.config.hasSecret && !JSON.stringify(ch.j).includes("k123") && !JSON.stringify(ch.j).includes("s3cret"), ch);
const t = await api("POST", `/api/channels/${ch.j.id}/test`);
ck("test delivery", t.s === 200, t); await sleep(200);
const d1 = got.find(g => g.url === "/hook");
ck("test payload + headers", d1 && JSON.parse(d1.b).event === "channel.test" && d1.h["x-api-key"] === "k123", d1);
const ts = d1.h["x-broker-timestamp"]; const sig = "sha256=" + createHmac("sha256", "s3cret").update(`${ts}.${d1.b}`).digest("hex");
ck("hmac signature valid", d1.h["x-broker-signature"] === sig);

// 2) job-level channel
const j = await api("POST", "/api/jobs", { prompt: "draw", mode: "auto", channelId: ch.j.id });
await sleep(800);
const d2 = got.filter(g => g.url === "/hook").map(g => JSON.parse(g.b)).find(p => p.event === "job.finished");
ck("job.finished delivered with base64 image + markdown", d2 && d2.result.images[0]?.base64 && d2.result.markdown === '**md** "q"' && d2.job.state === "succeeded", d2);
ck("foreign channel rejected", (await api("POST", "/api/jobs", { prompt: "x", channelId: "nope" })).s === 404);

// 3) template + retry on 500 + url images
const ch2 = await api("POST", "/api/channels", { type: "webhook", name: "slack", config: { url: "http://127.0.0.1:9099/flaky", bodyTemplate: '{"text":"{{markdown}}","job":"{{jobId}}"}', includeImages: "url" } });
await api("POST", "/api/jobs", { prompt: "t", mode: "text", channelId: ch2.j.id }); await sleep(3500);
const fl = got.filter(g => g.url === "/flaky");
ck("retried after 500", fl.length === 2, fl.length);
let parsed; try { parsed = JSON.parse(fl[1].b); } catch {}
ck("template rendered + JSON-escaped", parsed?.text === '**md** "q"' && parsed.job.length > 10, fl[1]?.b);

// 4) schedule uses webhook channel
const sc = await api("POST", "/api/schedules", { name: "s1", kind: "interval", everyMinutes: 60, prompt: "go", mode: "text", channelId: ch.j.id, skipIfUnchanged: true });
const run = await api("POST", `/api/schedules/${sc.j.id}/run`); await sleep(800);
const sp = got.filter(g => g.url === "/hook").map(g => JSON.parse(g.b)).filter(p => p.schedule?.name === "s1");
ck("schedule delivered", sp.length === 1 && sp[0].event === "job.finished", sp);
await api("POST", `/api/schedules/${sc.j.id}/run`); await sleep(800);
const sp2 = got.filter(g => g.url === "/hook").map(g => JSON.parse(g.b)).filter(p => p.schedule?.name === "s1");
ck("skipIfUnchanged suppresses 2nd identical text", sp2.length === 1, sp2.length);

// 5) patch keeps secrets; edit url
const pa = await api("PATCH", `/api/channels/${ch.j.id}`, { config: { includeImages: "none" } });
ck("patch keeps secret+headers", pa.s === 200 && pa.j.config.hasSecret && pa.j.config.headerNames.length === 1 && pa.j.config.includeImages === "none", pa);
ck("invalid url rejected", (await api("POST", "/api/channels", { type: "webhook", name: "x", config: { url: "ftp://a" } })).s === 400);
ws.close(); rx.close(); process.exit(0);
