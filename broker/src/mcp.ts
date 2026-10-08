import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { createJob, getJob, jobImages, waitForJob, type JobRow, type Mode } from "./engine.js";
import { db } from "./db.js";
import { keyUser, resolveChannel, resolveDevice, startFollowup, type User } from "./routes.js";
import { json } from "./util.js";

const WAIT_MS = Number(process.env.MCP_WAIT_MS ?? 90_000);

function result(job: JobRow) {
  if (job.state === "queued" || job.state === "running")
    return { content: [{ type: "text" as const, text: `Job ${job.id} is still ${job.state}. Call get_job with this id to fetch the result later.` }] };
  if (job.state !== "succeeded") return { isError: true, content: [{ type: "text" as const, text: `Job ${job.state}: ${job.error ?? ""}` }] };
  const content: any[] = [];
  const reply = job.markdown || job.text;
  if (reply) content.push({ type: "text", text: reply });
  for (const i of jobImages(job.id)) content.push({ type: "image", data: readFileSync(i.file).toString("base64"), mimeType: i.mime });
  if (!content.length) content.push({ type: "text", text: "(empty reply)" });
  content.push({ type: "text", text: `[job id: ${job.id} — call continue_chat with this id to reply in the same ChatGPT conversation]` });
  return { content };
}

function buildServer(user: User) {
  const server = new McpServer({ name: "browser-llm-broker", version: "1.0.0" });
  const run = async (prompt: string, mode: Mode, o: { conversationUrl?: string; device?: string; tag?: string; timeoutMs?: number; channel?: string }) => {
    let target: { deviceId?: string; tag?: string } | null = null;
    let channelId: string | null = null;
    try {
      target = o.device ? { deviceId: resolveDevice(user.id, o.device) } : o.tag ? { tag: o.tag } : null;
      channelId = o.channel ? resolveChannel(user.id, o.channel) : null;
    } catch (e) {
      return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] };
    }
    const id = createJob(user.id, { prompt, mode, conversationUrl: o.conversationUrl, target, timeoutMs: o.timeoutMs, channelId }, "mcp");
    return result(await waitForJob(id, WAIT_MS));
  };
  const common = {
    conversationUrl: z.string().url().optional().describe("Existing chatgpt.com conversation to use (keeps its memory); the prompt is sent as-is"),
    device: z.string().optional().describe("Run on this Chrome device only: its name (e.g. \"Work laptop\") or id. Use list_devices to see them."),
    tag: z.string().optional().describe("Run on a device with this tag"),
    timeoutMs: z.number().int().positive().optional(),
    channel: z.string().optional().describe("Also deliver the result to this notification channel (Telegram/webhook): its name or id. Use list_channels to see them."),
  };
  server.tool("generate_image", "Generate an image with ChatGPT through one of the user's connected Chrome browsers.",
    { prompt: z.string().min(1), ...common },
    async ({ prompt, conversationUrl, ...o }) => run(conversationUrl ? prompt : `Generate an image: ${prompt}`, "image", { conversationUrl, ...o }));
  server.tool("ask_chatgpt", "Send a message to ChatGPT (optionally an existing conversation) and return the text reply and any images.",
    { prompt: z.string().min(1), mode: z.enum(["text", "auto", "image"]).optional(), ...common },
    async ({ prompt, mode, ...o }) => run(prompt, mode ?? "auto", o));
  server.tool("continue_chat", "Send a follow-up message in the same ChatGPT conversation a previous job used (same Chrome device when possible).",
    { jobId: z.string(), prompt: z.string().min(1), mode: z.enum(["text", "auto", "image"]).optional(), timeoutMs: z.number().int().positive().optional(), channel: z.string().optional().describe("Notification channel name or id (optional)") },
    async ({ jobId, prompt, mode, timeoutMs, channel }) => {
      try {
        const id = startFollowup(user.id, jobId, { prompt, mode, timeoutMs, channelId: channel }, "mcp");
        return result(await waitForJob(id, WAIT_MS));
      } catch (e) {
        return { isError: true, content: [{ type: "text" as const, text: (e as Error).message }] };
      }
    });
  server.tool("get_job", "Get the result of a previously started job.", { id: z.string() }, async ({ id }) => {
    const job = getJob(id);
    if (!job || job.user_id !== user.id) return { isError: true, content: [{ type: "text" as const, text: "Job not found" }] };
    return result(await waitForJob(id, 30_000));
  });
  server.tool("list_channels", "List the user's notification channels (Telegram / webhook) that results can be delivered to.", {}, async () => {
    const rows = db.prepare("SELECT id, name, type FROM channels WHERE user_id = ?").all(user.id);
    return { content: [{ type: "text" as const, text: JSON.stringify(rows, null, 2) }] };
  });
  server.tool("list_devices", "List the user's connected Chrome devices and their status.", {}, async () => {
    const { deviceView } = await import("./engine.js");
    const rows = (db.prepare("SELECT * FROM devices WHERE user_id = ?").all(user.id) as any[]).map(deviceView);
    return { content: [{ type: "text" as const, text: JSON.stringify(rows.map((d) => ({ id: d.id, label: d.label, tags: d.tags, status: d.status })), null, 2) }] };
  });
  return server;
}

export async function handleMcp(req: IncomingMessage, res: ServerResponse) {
  const user = keyUser(req);
  if (!user) return void json(res, 401, { error: "Authorization: Bearer <API key> required" });
  const mcp = buildServer(user);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => { transport.close(); mcp.close(); });
  try {
    await mcp.connect(transport);
    await transport.handleRequest(req, res);
  } catch (e) {
    console.error("[mcp]", (e as Error).message);
    if (!res.headersSent) res.writeHead(500).end();
  }
}
