// Integration test (see test/run.mjs). Talks to a real broker process with a fake Chrome extension.
import WebSocket from "ws";
const B = process.env.BASE_URL;
let cookie = "";
const api = async (method, path, body, extra = {}) => {
  const r = await fetch(B + path, { method, headers: { "content-type": "application/json", "x-requested-with": "dashboard", cookie, ...extra }, body: body ? JSON.stringify(body) : undefined });
  const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
  const t = await r.text(); let j; try { j = JSON.parse(t) } catch { j = t }
  return { s: r.status, j };
};
const check = (name, cond, extra = "") => console.log((cond ? "PASS " : "FAIL ") + name + (cond ? "" : " " + JSON.stringify(extra)));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

check("unauth rejected", (await api("GET", "/api/devices")).s === 401);
check("bad login", (await api("POST", "/api/auth/login", { email: "admin@x.io", password: "nope" })).s === 401);
const lg = await api("POST", "/api/auth/login", { email: "admin@x.io", password: "adminpass1" });
check("login", lg.s === 200 && lg.j.user.role === "admin", lg);
check("csrf header needed", (await fetch(B + "/api/jobs", { method: "POST", headers: { "content-type": "application/json", cookie }, body: "{}" })).status === 403);

const pc = await api("POST", "/api/devices/pairing");
check("pairing code", /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(pc.j.code), pc);
const pr = await fetch(B + "/api/device/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pc.j.code.toLowerCase(), label: "Test Chrome" }) });
const pj = await pr.json();
check("pair device", pr.status === 200 && pj.deviceToken?.startsWith("dt_"), pj);
check("code single-use", (await fetch(B + "/api/device/pair", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ code: pc.j.code }) })).status === 400);

// fake extension
let mode = "ok";
const ws = new WebSocket(B.replace(/^http/, "ws") + "/ws", { headers: { origin: "chrome-extension://abc" } });
const got = [];
ws.on("message", (raw) => {
  const m = JSON.parse(raw); got.push(m);
  if (m.type === "generate_image") {
    ws.send(JSON.stringify({ type: "started", id: m.id }));
    ws.send(JSON.stringify({ type: "progress", id: m.id, message: "working" }));
    setTimeout(() => {
      if (mode === "limit") ws.send(JSON.stringify({ type: "error", id: m.id, message: "limit", code: "usage_limit", resetsAt: new Date(Date.now() + 3600e3).toISOString() }));
      else ws.send(JSON.stringify({ type: "result", id: m.id, text: "hello " + m.mode, images: m.mode === "text" ? [] : [{ mime: "image/png", base64: "iVBORw0KGgo=" }] }));
    }, 100);
  }
});
await new Promise(r => ws.on("open", r));
ws.send(JSON.stringify({ type: "auth", token: pj.deviceToken, version: "0.3.0" }));
await sleep(300);
check("auth_ok", got[0]?.type === "auth_ok", got);
let devs = (await api("GET", "/api/devices")).j;
check("device online", devs[0]?.status === "online" && devs[0].extVersion === "0.3.0", devs);

const j1 = await api("POST", "/api/jobs", { prompt: "hi", mode: "text" });
check("job accepted", j1.s === 202, j1);
await sleep(500);
const jd = (await api("GET", "/api/jobs/" + j1.j.id)).j;
check("job succeeded w/ text", jd.state === "succeeded" && jd.text === "hello text" && jd.progress.length === 1, jd);

const j2 = await api("POST", "/api/jobs", { prompt: "draw", mode: "image" });
await sleep(500);
const jd2 = (await api("GET", "/api/jobs/" + j2.j.id)).j;
check("job image saved", jd2.state === "succeeded" && jd2.images.length === 1, jd2);
const img = await fetch(B + jd2.images[0].url, { headers: { cookie } });
check("image served w/ session", img.status === 200 && img.headers.get("content-type") === "image/png");
check("image 404 w/o auth", (await fetch(B + jd2.images[0].url)).status === 404);

// api key + v1 + mcp
const k = await api("POST", "/api/keys", { name: "t" });
check("api key", k.j.key?.startsWith("ck_"), k);
const auth = { authorization: "Bearer " + k.j.key };
const v1 = await fetch(B + "/v1/jobs?wait=10&inline=1", { method: "POST", headers: { "content-type": "application/json", ...auth }, body: JSON.stringify({ prompt: "x", mode: "auto" }) });
const v1j = await v1.json();
check("v1 wait+inline", v1.status === 200 && v1j.state === "succeeded" && v1j.images[0].base64, v1j);
const signed = await fetch(B + v1j.images[0].url);
check("signed url works w/o cookie", signed.status === 200);
check("v1 bad key", (await fetch(B + "/v1/devices", { headers: { authorization: "Bearer ck_nope" } })).status === 401);

const mcpH = { "content-type": "application/json", accept: "application/json, text/event-stream", ...auth };
const mcp = async (body) => (await (await fetch(B + "/mcp", { method: "POST", headers: mcpH, body: JSON.stringify(body) })).text());
await mcp({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } } });
const tl = await mcp({ jsonrpc: "2.0", id: 2, method: "tools/list" });
check("mcp tools", ["generate_image", "ask_chatgpt", "get_job", "list_devices"].every(n => tl.includes(n)), tl.slice(0, 200));
const tc = await mcp({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "ask_chatgpt", arguments: { prompt: "yo", mode: "text" } } });
check("mcp call", tc.includes("hello text"), tc.slice(0, 300));
check("mcp no key", (await fetch(B + "/mcp", { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" })).status === 401);

// usage limit failover: only one device → job requeued then fails by queue timeout; device becomes limited
mode = "limit";
const j3 = await api("POST", "/api/jobs", { prompt: "limit me", mode: "image" });
await sleep(600);
devs = (await api("GET", "/api/devices")).j;
check("device limited after usage_limit", devs[0].status === "limited", devs);
const jd3 = (await api("GET", "/api/jobs/" + j3.j.id)).j;
check("job requeued (no other device)", jd3.state === "queued", jd3);
await api("POST", "/api/jobs/" + j3.j.id + "/cancel");
check("cancel", (await api("GET", "/api/jobs/" + j3.j.id)).j.state === "canceled");

// pause / patch
mode = "ok";
await api("PATCH", "/api/devices/" + pj.deviceId, { paused: true, tags: ["art"], label: "Renamed" });
devs = (await api("GET", "/api/devices")).j;
check("patch device", devs[0].status === "paused" && devs[0].label === "Renamed" && devs[0].tags[0] === "art", devs);

// schedule + channel
const ch = await api("POST", "/api/channels", { type: "telegram", name: "tg", config: { botToken: "000:FAKETOKEN", chatId: "1" } });
check("channel masked", ch.j.config?.botTokenMasked === "••••OKEN", ch);
const sc = await api("POST", "/api/schedules", { name: "daily", kind: "daily", time: "08:00", timezone: "Asia/Ho_Chi_Minh", prompt: "go", mode: "text", channelId: ch.j.id });
check("schedule create", sc.s === 200 && sc.j.nextRunAt, sc);
check("schedule validation", (await api("POST", "/api/schedules", { name: "x", kind: "interval", prompt: "p" })).s === 400);
const st = await api("GET", "/api/admin/stats");
check("admin stats", st.s === 200 && st.j.devicesTotal === 1, st);

// user mgmt + isolation
const nu = await api("POST", "/api/admin/users", { email: "bob@x.io", name: "Bob", password: "bobpass123" });
check("create user", nu.s === 200, nu);
const adminCookie = cookie; cookie = "";
await api("POST", "/api/auth/login", { email: "bob@x.io", password: "bobpass123" });
check("user sees no devices", (await api("GET", "/api/devices")).j.length === 0);
check("user can't see admin job", (await api("GET", "/api/jobs/" + j1.j.id)).s === 404);
check("user not admin", (await api("GET", "/api/admin/users")).s === 403);
ws.close();
process.exit(0);
