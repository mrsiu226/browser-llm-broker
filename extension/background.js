/**
 * Browser LLM Broker - Background Service Worker
 * Manages WebSocket connection to local MCP server and orchestrates ChatGPT tabs.
 */

const EXT_VERSION = chrome.runtime.getManifest().version;
const RECONNECT_INTERVAL_MS = 2000;
const KEEPALIVE_INTERVAL_MS = 20000;
const TAB_READY_TIMEOUT_MS = 20000;

let ws = null;
let config = { serverUrl: "", deviceToken: "" };
let authed = false;
let reconnectTimer = null;
let isConnecting = false;

// Active jobs map: id -> { id, prompt, timeoutMs, tabId, timer, status }
const activeJobs = new Map();

// Tab to job ID mapping: tabId -> jobId
const tabToJob = new Map();

function log(...args) {
  console.log("[ChatGPT-MCP-BG]", ...args);
}

function updateBadge(connected) {
  try {
    if (connected) {
      chrome.action.setBadgeText({ text: "ON" });
      chrome.action.setBadgeBackgroundColor({ color: "#10a37f" }); // ChatGPT green
    } else {
      chrome.action.setBadgeText({ text: "OFF" });
      chrome.action.setBadgeBackgroundColor({ color: "#ef4444" }); // Red
    }
  } catch (e) {
    // Action badge may fail if action is not configured
  }
}

// ---------------------------------------------------------------------------
// WebSocket Client
// ---------------------------------------------------------------------------

async function loadConfig() {
  const c = await chrome.storage.local.get(["serverUrl", "deviceToken"]);
  config = { serverUrl: c.serverUrl || "", deviceToken: c.deviceToken || "" };
}

function wsUrl() {
  const u = new URL(config.serverUrl);
  return `${u.protocol === "https:" ? "wss:" : "ws:"}//${u.host}/ws`;
}

function connectWebSocket() {
  if (isConnecting || (ws && ws.readyState === WebSocket.OPEN)) {
    return;
  }
  if (!config.deviceToken || !config.serverUrl) {
    setBadge("SET", "#f59e0b"); // not paired yet: open the options page to pair this browser
    return;
  }

  isConnecting = true;
  authed = false;
  const url = wsUrl();
  log(`Connecting to ${url}...`);

  try {
    ws = new WebSocket(url);
  } catch (err) {
    log("WebSocket constructor error:", err);
    isConnecting = false;
    scheduleReconnect();
    return;
  }

  ws.onopen = () => {
    isConnecting = false;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Authenticate first; the connection counts as ON after auth_ok.
    ws.send(JSON.stringify({ type: "auth", token: config.deviceToken, version: EXT_VERSION }));
  };

  ws.onmessage = (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch (err) {
      log("Failed to parse incoming WS message:", event.data);
      return;
    }
    if (msg.type === "auth_ok") {
      authed = true;
      log(`Authenticated as device ${msg.deviceId} (${msg.label})`);
      updateBadge(true);
      return;
    }
    if (msg.type === "auth_error") {
      log("Server rejected the device token. Re-pair this browser in the extension options.");
      setBadge("AUTH", "#f59e0b");
      return;
    }
    if (msg.type === "pong") return;
    log("Received message from server:", msg.type, msg.id || "");
    handleServerMessage(msg);
  };

  ws.onclose = () => {
    isConnecting = false;
    ws = null;
    authed = false;
    log("WebSocket closed");
    setBadge("OFF", "#ef4444");
    scheduleReconnect();
  };

  ws.onerror = (err) => {
    isConnecting = false;
    log("WebSocket error:", err.message || "Connection failed");
  };
}

function setBadge(text, color) {
  try {
    chrome.action.setBadgeText({ text });
    chrome.action.setBadgeBackgroundColor({ color });
  } catch (e) {}
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWebSocket();
  }, RECONNECT_INTERVAL_MS);
}

function sendToServer(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
    return true;
  }
  log("Cannot send message: WebSocket is not open", data);
  return false;
}

// Keepalive via alarms and interval
chrome.alarms.create("mcp_keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "mcp_keepalive") {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      connectWebSocket();
    } else {
      // Send a lightweight ping to keep connection and worker fresh
      sendToServer({ type: "ping" });
    }
  }
});

setInterval(() => {
  if (ws && ws.readyState === WebSocket.OPEN) {
    sendToServer({ type: "ping" });
  } else if (!isConnecting) {
    connectWebSocket();
  }
}, KEEPALIVE_INTERVAL_MS);

// ---------------------------------------------------------------------------
// Server Message Handler
// ---------------------------------------------------------------------------

function handleServerMessage(msg) {
  if (msg.type === "generate_image") {
    const { id, prompt, timeoutMs = 180000, conversationUrl = null, mode = "image" } = msg;
    if (!id || !prompt) {
      log("Invalid generate_image message: missing id or prompt");
      return;
    }
    startImageGenerationJob(id, prompt, timeoutMs, conversationUrl, mode);
  }
}

// ---------------------------------------------------------------------------
// Image Generation Job Orchestration
// ---------------------------------------------------------------------------

async function startImageGenerationJob(id, prompt, timeoutMs, conversationUrl, mode) {
  log(`Starting image generation job [${id}], timeout: ${timeoutMs}ms`);

  // Overall job timeout timer
  const timer = setTimeout(() => {
    finishJobWithError(id, `Timed out after ${timeoutMs}ms waiting for image generation`);
  }, timeoutMs);

  const job = {
    id,
    prompt,
    timeoutMs,
    tabId: null,
    timer,
    status: "opening_tab",
  };
  activeJobs.set(id, job);

  try {
    // "background" (default): open the tab without activating it, so Chrome never jumps to the front.
    // If ChatGPT cannot be driven from a background tab, the job is retried once in the foreground.
    const { runMode } = await chrome.storage.local.get("runMode");
    job.bg = runMode !== "foreground";
    const tab = await chrome.tabs.create({
      url: conversationUrl || "https://chatgpt.com/?temporary-chat=false",
      active: !job.bg,
    });
    if (!job.bg) await bringToFront(tab);

    job.tabId = tab.id;
    tabToJob.set(tab.id, id);
    log(`Opened ChatGPT tab ${tab.id} for job [${id}]`);

    // Wait for the tab to reach 'complete' loading state
    await waitForTabComplete(tab.id, TAB_READY_TIMEOUT_MS);

    // Wait for content script to be ready and hand off the task
    job.args = [prompt, timeoutMs, !!conversationUrl, mode];
    await handoffToContentScript(tab.id, id, prompt, timeoutMs, !!conversationUrl, mode);
  } catch (err) {
    log(`Failed to initiate job [${id}]:`, err);
    finishJobWithError(id, err.message || "Failed to launch ChatGPT tab");
  }
}

// A hidden/minimized window makes Chrome freeze the page, so the prompt cannot be typed there.
async function bringToFront(tab) {
  try {
    await chrome.tabs.update(tab.id, { active: true });
    const win = await chrome.windows.get(tab.windowId);
    await chrome.windows.update(tab.windowId, win.state === "minimized" ? { state: "normal", focused: true } : { focused: true });
  } catch (e) {
    log("Could not focus window:", e.message);
  }
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let timeoutTimer = null;

    const listener = (updatedTabId, changeInfo, tab) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") {
        cleanup();
        resolve(tab);
      }
    };

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      chrome.tabs.onUpdated.removeListener(listener);
    };

    timeoutTimer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for ChatGPT tab ${tabId} to load`));
    }, timeoutMs);

    chrome.tabs.onUpdated.addListener(listener);

    // Check if it's already complete
    chrome.tabs.get(tabId, (tab) => {
      if (chrome.runtime.lastError || !tab) return;
      if (tab.status === "complete") {
        cleanup();
        resolve(tab);
      }
    });
  });
}

async function handoffToContentScript(tabId, id, prompt, timeoutMs, existingChat, mode) {
  const startTime = Date.now();
  const maxWaitMs = 15000;

  // Poll until content script responds to ping or start command
  while (Date.now() - startTime < maxWaitMs) {
    if (!activeJobs.has(id)) return; // Job already aborted or timed out

    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        action: "start_generation",
        id,
        prompt,
        timeoutMs,
        existingChat,
        mode,
      });

      if (response && response.acknowledged) {
        log(`Content script acknowledged job [${id}] on tab ${tabId}`);
        sendToServer({ type: "started", id });
        const job = activeJobs.get(id);
        if (job) job.status = "generating";
        return;
      }
    } catch (e) {
      // Content script might not be injected yet, retry after short delay
    }

    await new Promise((r) => setTimeout(r, 600));
  }

  throw new Error("Content script on ChatGPT tab failed to initialize in time");
}

function finishJobWithSuccess(id, images, text, markdown, conversationUrl) {
  const job = activeJobs.get(id);
  if (!job) return;

  log(`Job [${id}] completed successfully with ${images.length} image(s)`);
  clearTimeout(job.timer);

  sendToServer({
    type: "result",
    id,
    images,
    text: text || "",
    markdown: markdown || "",
    conversationUrl: conversationUrl || null,
  });

  cleanupJob(id);
}

function finishJobWithError(id, errorMessage, code, resetsAt) {
  const job = activeJobs.get(id);
  if (!job) return;

  log(`Job [${id}] failed: ${errorMessage}`);
  clearTimeout(job.timer);

  sendToServer({
    type: "error",
    id,
    message: errorMessage,
    code,
    resetsAt,
  });

  cleanupJob(id);
}

function cleanupJob(id) {
  const job = activeJobs.get(id);
  if (!job) return;

  if (job.tabId) {
    tabToJob.delete(job.tabId);
    // Automatically close the temporary generation tab after a brief pause
    setTimeout(() => {
      chrome.tabs.remove(job.tabId).catch(() => {});
    }, 1500);
  }

  activeJobs.delete(id);
}

// ---------------------------------------------------------------------------
// Extension Message Listener (from content.js)
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!request || !request.action) return false;

  if (request.action === "status") {
    sendResponse({
      paired: !!(config.serverUrl && config.deviceToken),
      connected: !!(ws && ws.readyState === WebSocket.OPEN && authed),
      connecting: isConnecting || (!!ws && ws.readyState === WebSocket.CONNECTING),
      server: config.serverUrl,
      activeJobs: activeJobs.size,
    });
    return false;
  }
  if (request.action === "reconnect") {
    (async () => {
      await loadConfig();
      if (ws) { try { ws.close(); } catch (e) {} ws = null; }
      isConnecting = false;
      if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
      connectWebSocket();
      sendResponse({ ok: true });
    })();
    return true;
  }

  const jobId = request.id || (sender.tab ? tabToJob.get(sender.tab.id) : null);

  if (request.action === "fetch_image") {
    (async () => {
      try {
        const resp = await fetch(request.url, { credentials: "include" });
        if (!resp.ok) throw new Error(`Fetch failed with status ${resp.status}`);
        const blob = await resp.blob();
        const bytes = new Uint8Array(await blob.arrayBuffer());
        let bin = "";
        for (let i = 0; i < bytes.length; i += 0x8000) {
          bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        }
        sendResponse({ mime: blob.type || "image/png", base64: btoa(bin) });
      } catch (e) {
        sendResponse({ error: e.message });
      }
    })();
    return true;
  }

  if (request.action === "generation_progress") {
    if (jobId && activeJobs.has(jobId)) {
      sendToServer({
        type: "progress",
        id: jobId,
        message: request.message || "Generating...",
      });
    }
    sendResponse({ received: true });
    return true;
  }

  if (request.action === "generation_success") {
    if (jobId && activeJobs.has(jobId)) {
      finishJobWithSuccess(jobId, request.images || [], request.text || "", request.markdown || "", request.conversationUrl || null);
    }
    sendResponse({ received: true });
    return true;
  }

  if (request.action === "generation_failed") {
    const job = jobId && activeJobs.get(jobId);
    if (job && request.code === "prompt_not_sent" && job.bg && !job.retriedInForeground && job.tabId && job.args) {
      // Background tab could not submit the prompt: bring it to the front and run the job again.
      job.retriedInForeground = true;
      log(`Job [${jobId}] could not run in the background; retrying in the foreground`);
      chrome.tabs.get(job.tabId).then(async (tab) => {
        await bringToFront(tab);
        await handoffToContentScript(job.tabId, jobId, ...job.args);
      }).catch((e) => finishJobWithError(jobId, e.message));
    } else if (job) {
      finishJobWithError(jobId, request.error || "Unknown error during image generation", request.code, request.resetsAt);
    }
    sendResponse({ received: true });
    return true;
  }

  return false;
});

// Listen for tab closure
chrome.tabs.onRemoved.addListener((tabId) => {
  const jobId = tabToJob.get(tabId);
  if (jobId && activeJobs.has(jobId)) {
    log(`Tab ${tabId} was closed while job [${jobId}] was running`);
    finishJobWithError(jobId, "ChatGPT tab was closed before image generation finished");
  }
});

chrome.storage.onChanged.addListener(async (changes, area) => {
  if (area !== "local" || !(changes.serverUrl || changes.deviceToken)) return;
  await loadConfig();
  if (ws) { try { ws.close(); } catch (e) {} }
  else connectWebSocket();
});
chrome.action.onClicked.addListener(() => chrome.runtime.openOptionsPage());
chrome.runtime.onInstalled.addListener((d) => { if (d.reason === "install") chrome.runtime.openOptionsPage(); });
// MV3 service workers only run when an event wakes them: without this listener a browser restart
// would leave the extension idle (device "offline") until something else triggered it.
chrome.runtime.onStartup.addListener(() => { loadConfig().then(connectWebSocket); });

// Start connection on service worker launch
loadConfig().then(connectWebSocket);
