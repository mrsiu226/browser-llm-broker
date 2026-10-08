import { createServer } from "node:http";
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, normalize, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { db, now, uid } from "./db.js";
import { hashPassword, json, randomToken, sha256 } from "./util.js";
import { attachDevice, setOnFinished } from "./engine.js";
import { onJobFinished } from "./notify.js";
import { startScheduler } from "./scheduler.js";
import { handleApi, serveFile } from "./routes.js";
import { handleMcp } from "./mcp.js";
import { extensionPackage } from "./zip.js";

const PORT = Number(process.env.PORT ?? 8080);
const PUBLIC_DIR = fileURLToPath(new URL("../public", import.meta.url));
const log = (...a: unknown[]) => console.log(new Date().toISOString(), "[broker]", ...a);

// ---------------------------------------------------------------- bootstrap admin
if (!(db.prepare("SELECT COUNT(*) n FROM users").get() as any).n) {
  const email = (process.env.ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
  const provided = process.env.ADMIN_PASSWORD;
  if (provided && (provided.length < 8 || /^change[-_ ]?me/i.test(provided))) {
    console.error("ADMIN_PASSWORD is too short (< 8 chars) or still the placeholder from .env.example. Set a real password (or leave it empty to get a random one in the log).");
    process.exit(1);
  }
  const password = provided || randomToken("", 9);
  db.prepare("INSERT INTO users (id,email,name,role,password_hash,created_at) VALUES (?,?,?,?,?,?)").run(uid(), email, "Admin", "admin", hashPassword(password), now());
  log(`created first admin: ${email}${process.env.ADMIN_PASSWORD ? "" : ` / generated password: ${password}  (change it after login)`}`);
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".json": "application/json", ".map": "application/json", ".woff2": "font/woff2", ".md": "text/markdown; charset=utf-8",
};
const SECURITY = {
  "x-content-type-options": "nosniff", "x-frame-options": "DENY", "referrer-policy": "same-origin",
  "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; connect-src 'self'; frame-ancestors 'none'",
};

function serveStatic(pathname: string, res: import("node:http").ServerResponse): boolean {
  const rel = normalize(pathname === "/" ? "/index.html" : pathname).replace(/^(\.\.[/\\])+/, "");
  const file = join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !existsSync(file) || !statSync(file).isFile() || rel.includes("mock-server")) return false;
  res.writeHead(200, { "content-type": MIME[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" }).end(readFileSync(file));
  return true;
}

const server = createServer(async (req, res) => {
  for (const [k, v] of Object.entries(SECURITY)) res.setHeader(k, v);
  const url = new URL(req.url ?? "/", "http://x");
  try {
    if (url.pathname === "/favicon.ico") { res.writeHead(301, { location: "/favicon.svg" }).end(); return; }
    if (url.pathname === "/healthz") return void json(res, 200, { ok: true });
    if (url.pathname === "/mcp") return void (await handleMcp(req, res));
    if (req.method === "GET" && (url.pathname === "/download/extension.zip" || url.pathname === "/download/extension.json")) {
      const pkg = extensionPackage();
      if (!pkg) return void json(res, 404, { error: "extension package not available on this server" });
      if (url.pathname.endsWith(".json")) return void json(res, 200, { version: pkg.version, size: pkg.zip.length, file: pkg.name, url: "/download/extension.zip" });
      return void res.writeHead(200, { "content-type": "application/zip", "content-disposition": `attachment; filename="${pkg.name}"`, "content-length": pkg.zip.length, "cache-control": "no-cache" }).end(pkg.zip);
    }
    if (url.pathname.startsWith("/files/")) { if (serveFile(req, res, url)) return; }
    if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/v1/")) {
      if (await handleApi(req, res, url)) return;
      return void json(res, 404, { error: "not found" });
    }
    if (req.method === "GET" && serveStatic(url.pathname, res)) return;
    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error("[http]", e);
    if (!res.headersSent) json(res, 500, { error: "internal error" });
  }
});

// ---------------------------------------------------------------- extension websocket
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 * 1024 });
server.on("upgrade", (req, socket, head) => {
  const path = (req.url ?? "").split("?")[0];
  const origin = String(req.headers.origin ?? "");
  if (path !== "/ws" || !(origin.startsWith("chrome-extension://") || origin === "")) { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const timer = setTimeout(() => ws.close(4001, "auth timeout"), 8000);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      let m: any;
      try { m = JSON.parse(raw.toString()); } catch { return ws.close(4001, "bad auth"); }
      const d = m?.type === "auth" && typeof m.token === "string"
        ? (db.prepare("SELECT d.* FROM devices d JOIN users u ON u.id = d.user_id WHERE d.token_hash = ? AND u.disabled = 0").get(sha256(m.token)) as any)
        : null;
      if (!d) { ws.send(JSON.stringify({ type: "auth_error" })); return ws.close(4001, "invalid token"); }
      ws.send(JSON.stringify({ type: "auth_ok", deviceId: d.id, label: d.label }));
      attachDevice(ws, d, typeof m.version === "string" ? m.version.slice(0, 30) : null);
    });
  });
});

setOnFinished((job) => void onJobFinished(job));
startScheduler();
server.listen(PORT, () => log(`listening on :${PORT}`));
process.on("SIGTERM", () => { log("SIGTERM"); server.close(); process.exit(0); });
