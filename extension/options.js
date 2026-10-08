const $ = (id) => document.getElementById(id);
function show(text, ok) {
  const m = $("msg");
  m.textContent = text;
  m.className = ok ? "ok" : "err";
  m.style.display = "block";
}
async function refresh() {
  const c = await chrome.storage.local.get(["serverUrl", "deviceToken", "label"]);
  const paired = !!(c.serverUrl && c.deviceToken);
  $("pair").style.display = paired ? "none" : "block";
  $("paired").style.display = paired ? "block" : "none";
  $("status").textContent = paired
    ? `Paired with ${c.serverUrl} as “${c.label || "Chrome"}”. The toolbar badge shows ON when connected.`
    : "Not paired yet. Enter your broker's address and a pairing code from its dashboard (Devices → Add device).";
  if (!paired) $("label").value = $("label").value || "Chrome on " + (navigator.platform || "this computer");
}
$("connect").onclick = async () => {
  try {
    const server = $("server").value.trim().replace(/\/+$/, "");
    new URL(server);
    const r = await fetch(`${server}/api/device/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: $("code").value, label: $("label").value.trim() || "Chrome", version: chrome.runtime.getManifest().version }),
    });
    const j = await r.json();
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    await chrome.storage.local.set({ serverUrl: server, deviceToken: j.deviceToken, deviceId: j.deviceId, label: $("label").value.trim() || "Chrome" });
    show("Connected. This browser now appears in the dashboard.", true);
    refresh();
  } catch (e) {
    show(String(e.message || e), false);
  }
};
$("disconnect").onclick = async () => {
  await chrome.storage.local.remove(["serverUrl", "deviceToken", "deviceId", "label"]);
  show("Disconnected. Remove the device in the dashboard to revoke its token.", true);
  refresh();
};
async function pollStatus() {
  const el = $("conn");
  if (!el) return;
  try {
    const s = await chrome.runtime.sendMessage({ action: "status" });
    if (!s || !s.paired) { el.textContent = ""; return; }
    el.textContent = s.connected ? `● Connected to the server${s.activeJobs ? ` (${s.activeJobs} job running)` : ""}`
      : s.connecting ? "◌ Connecting…" : "○ Not connected. Check the server URL and your network, then press Reconnect now.";
    el.style.color = s.connected ? "#10a37f" : "";
  } catch (e) {
    el.textContent = "○ Background worker not responding. Press Reconnect now.";
  }
}
$("reconnect").onclick = async () => {
  $("conn").textContent = "◌ Connecting…";
  try { await chrome.runtime.sendMessage({ action: "reconnect" }); } catch (e) {}
  setTimeout(pollStatus, 1200);
};
refresh();
pollStatus();
setInterval(pollStatus, 2000);

(async () => {
  const sel = document.getElementById("runMode");
  const { runMode } = await chrome.storage.local.get("runMode");
  sel.value = runMode === "foreground" ? "foreground" : "background";
  sel.onchange = () => chrome.storage.local.set({ runMode: sel.value });
})();
