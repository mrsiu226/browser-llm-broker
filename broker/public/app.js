import { renderMarkdown, typesetMath } from "./markdown.js";
/**
 * Browser LLM Broker - Frontend Single Page Application
 * Vanilla ES Module, zero external dependencies.
 */

// Application State
const state = {
  currentUser: null,
  activeRoute: "devices",
  routeParam: null,
  pollTimer: null,
  countdownTimer: null,
  showAllJobs: false,
};

// ============================================================================
// Utilities
// ============================================================================

/**
 * Escape HTML to prevent XSS. All user content rendered into DOM must use this.
 */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (e) {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand("copy"); } catch (err) {}
    ta.remove();
    return ok;
  }
}

export function escapeHtml(str) {
  if (str === null || str === undefined) return "";
  return String(str).replace(/[&<>"']/g, (m) => {
    switch (m) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      case "'": return "&#39;";
      default: return m;
    }
  });
}

/**
 * Format ISO UTC string into readable local date/time
 */
export function formatDate(iso) {
  if (!iso) return "—";
  try {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch (e) {
    return String(iso);
  }
}

/**
 * Relative time calculation (e.g. "2m ago")
 */
export function formatTimeAgo(iso) {
  if (!iso) return "Never";
  const diffSec = Math.round((Date.now() - new Date(iso).getTime()) / 1000);
  if (diffSec < 0) return "Just now";
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
  return `${Math.floor(diffSec / 86400)}d ago`;
}

/**
 * Toast notifications
 */
export function showToast(message, type = "success") {
  const container = document.getElementById("toast-container");
  if (!container) return;

  const toast = document.createElement("div");
  toast.className = `toast toast-${type}`;
  toast.innerHTML = `
    <span>${escapeHtml(message)}</span>
    <button class="modal-close" style="margin-left:auto; font-size:16px;">&times;</button>
  `;

  toast.querySelector("button").onclick = () => toast.remove();

  container.appendChild(toast);
  setTimeout(() => {
    if (toast.parentNode) toast.remove();
  }, 4000);
}

/**
 * Modal Dialog Controller
 */
export function showModal({ title, contentHtml, onConfirm = null, confirmText = "Save", cancelText = "Cancel", hideConfirm = false }) {
  const container = document.getElementById("modal-container");
  if (!container) return;

  container.className = "modal-backdrop";
  container.innerHTML = `
    <div class="modal" role="dialog" aria-modal="true">
      <div class="modal-header">
        <h2>${escapeHtml(title)}</h2>
        <button class="modal-close" id="modal-btn-close">&times;</button>
      </div>
      <div class="modal-body">
        ${contentHtml}
      </div>
      <div class="modal-footer">
        <button class="btn btn-secondary" id="modal-btn-cancel">${escapeHtml(cancelText)}</button>
        ${!hideConfirm ? `<button class="btn btn-primary" id="modal-btn-confirm">${escapeHtml(confirmText)}</button>` : ""}
      </div>
    </div>
  `;

  const cleanup = () => {
    if (state.countdownTimer) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
    }
    container.className = "hidden";
    container.innerHTML = "";
  };

  container.querySelector("#modal-btn-close").onclick = cleanup;
  container.querySelector("#modal-btn-cancel").onclick = cleanup;

  const confirmBtn = container.querySelector("#modal-btn-confirm");
  if (confirmBtn && onConfirm) {
    confirmBtn.onclick = async () => {
      confirmBtn.disabled = true;
      try {
        const ok = await onConfirm();
        if (ok !== false) cleanup();
      } catch (e) {
        showToast(e.message, "error");
      } finally {
        confirmBtn.disabled = false;
      }
    };
  }

  // Backdrop click closes modal
  container.onclick = (e) => {
    if (e.target === container) cleanup();
  };
}

export function closeModal() {
  const container = document.getElementById("modal-container");
  if (container) {
    if (state.countdownTimer) {
      clearInterval(state.countdownTimer);
      state.countdownTimer = null;
    }
    container.className = "hidden";
    container.innerHTML = "";
  }
}

// ============================================================================
// API Client
// ============================================================================

export async function apiFetch(endpoint, options = {}) {
  const method = (options.method || "GET").toUpperCase();
  const headers = { ...options.headers };

  // Rule: Every non-GET request must send header X-Requested-With: dashboard
  if (method !== "GET") {
    headers["X-Requested-With"] = "dashboard";
  }

  if (options.body && typeof options.body === "object" && !(options.body instanceof FormData)) {
    headers["Content-Type"] = "application/json";
    options.body = JSON.stringify(options.body);
  }

  options.headers = headers;
  options.credentials = "include"; // Include cookies (sid)

  let res;
  try {
    res = await fetch(endpoint, options);
  } catch (netErr) {
    throw new Error(`Network error: ${netErr.message}`);
  }

  if (res.status === 401 && endpoint !== "/api/auth/login") {
    state.currentUser = null;
    navigate("#login");
    throw new Error("Session expired or unauthorized. Please sign in.");
  }

  if (res.status === 403) {
    let errBody = {};
    try { errBody = await res.json(); } catch (e) {}
    const msg = errBody.error || "Permission denied (403 Forbidden)";
    showToast(msg, "error");
    throw new Error(msg);
  }

  let data = null;
  const contentType = res.headers.get("content-type") || "";
  if (contentType.includes("application/json")) {
    try {
      data = await res.json();
    } catch (e) {
      data = null;
    }
  }

  if (!res.ok) {
    const errorMsg = (data && data.error) ? data.error : `Request failed with status ${res.status}`;
    throw new Error(errorMsg);
  }

  return data;
}

// ============================================================================
// Router & State Management
// ============================================================================

export function navigate(hash) {
  window.location.hash = hash;
}

function parseRoute() {
  const hash = window.location.hash.slice(1) || "devices";
  const parts = hash.split("/");
  return {
    name: parts[0] || "devices",
    param: parts[1] || null,
  };
}

async function handleRouteChange() {
  const route = parseRoute();
  state.activeRoute = route.name;
  state.routeParam = route.param;

  // Update navigation link highlights
  document.querySelectorAll(".nav-link").forEach((link) => {
    const linkHref = link.getAttribute("href")?.slice(1);
    if (linkHref === route.name) {
      link.classList.add("active");
    } else {
      link.classList.remove("active");
    }
  });

  if (route.name === "login") {
    showLoginView();
    return;
  }

  if (route.name === "docs") {
    await showDocsView();
    return;
  }
  document.getElementById("docs-view")?.classList.add("hidden");

  // Ensure user is authenticated
  if (!state.currentUser) {
    try {
      const me = await apiFetch("/api/me");
      state.currentUser = me;
      updateUserUI();
    } catch (e) {
      navigate("#login");
      return;
    }
  }

  showDashboardView();

  // Render view
  switch (route.name) {
    case "devices":
      await renderDevices();
      break;
    case "jobs":
      if (route.param) {
        await renderJobDetail(route.param);
      } else {
        await renderJobs();
      }
      break;
    case "schedules":
      await renderSchedules();
      break;
    case "channels":
      await renderChannels();
      break;
    case "keys":
      await renderKeys();
      break;
    case "admin":
      await renderAdmin();
      break;
    default:
      navigate("#devices");
      break;
  }
}

async function showDocsView() {
  stopPolling();
  document.getElementById("login-view")?.classList.add("hidden");
  document.getElementById("app-container")?.classList.add("hidden");
  const view = document.getElementById("docs-view");
  view.classList.remove("hidden");

  const body = document.getElementById("docs-body");
  const toc = document.getElementById("docs-toc");
  // Logged-in users get a link back to the dashboard; others to the sign-in page.
  let loggedIn = !!state.currentUser;
  if (!loggedIn) {
    try { state.currentUser = await (await fetch("/api/me", { credentials: "include" })).json().then((j) => (j && j.id ? j : null)); loggedIn = !!state.currentUser; } catch (e) {}
  }
  const back = document.getElementById("docs-back");
  const viUi = (state.routeParam === "vi") || (state.routeParam !== "en" && (navigator.language || "").toLowerCase().startsWith("vi"));
  back.textContent = loggedIn ? "Dashboard" : (viUi ? "Đăng nhập" : "Sign in");
  const switcher = document.getElementById("docs-lang");
  if (switcher) {
    switcher.textContent = viUi ? "English" : "Tiếng Việt";
    switcher.setAttribute("href", viUi ? "#docs/en" : "#docs/vi");
  }
  back.setAttribute("href", loggedIn ? "#devices" : "#login");

  try {
    // Language: #docs/en or #docs/vi; default follows the browser language (Vietnamese users get Vietnamese).
    const lang = state.routeParam === "en" || state.routeParam === "vi" ? state.routeParam : (navigator.language || "").toLowerCase().startsWith("vi") ? "vi" : "en";
    const [md, info] = await Promise.all([
      fetch(lang === "vi" ? "docs.md" : "docs.en.md").then((r) => r.text()),
      fetch("/download/extension.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    body.innerHTML = renderMarkdown(md.replaceAll("{{ORIGIN}}", location.origin));
    const dl = document.getElementById("docs-download");
    if (info) dl.textContent = viUi ? `Tải extension v${info.version} (.zip, ${Math.round(info.size / 1024)} KB)` : `Download extension v${info.version} (.zip, ${Math.round(info.size / 1024)} KB)`;
    // Build the table of contents from the h3 (## in markdown) headings.
    toc.innerHTML = "";
    body.querySelectorAll("h3.md-h").forEach((h, i) => {
      h.id = `doc-${i}`;
      const a = document.createElement("a");
      a.href = `#docs`;
      a.textContent = h.textContent;
      a.onclick = (e) => { e.preventDefault(); h.scrollIntoView({ behavior: "smooth", block: "start" }); };
      toc.appendChild(a);
    });
  } catch (e) {
    body.textContent = "Could not load the documentation: " + e.message;
  }
}

function showLoginView() {
  document.getElementById("docs-view")?.classList.add("hidden");
  stopPolling();
  document.getElementById("login-view")?.classList.remove("hidden");
  document.getElementById("app-container")?.classList.add("hidden");
}

function showDashboardView() {
  document.getElementById("login-view")?.classList.add("hidden");
  document.getElementById("app-container")?.classList.remove("hidden");
  startPolling();
}

function updateUserUI() {
  if (!state.currentUser) return;
  const nameEl = document.getElementById("user-display-name");
  const emailEl = document.getElementById("user-display-email");
  const roleEl = document.getElementById("user-display-role");
  const adminNav = document.getElementById("nav-admin-wrap");

  if (nameEl) nameEl.textContent = state.currentUser.name;
  if (emailEl) emailEl.textContent = state.currentUser.email;
  if (roleEl) {
    roleEl.textContent = state.currentUser.role.toUpperCase();
    roleEl.className = `badge ${state.currentUser.role === "admin" ? "badge-paused" : "badge-offline"}`;
  }

  if (adminNav) {
    adminNav.style.display = state.currentUser.role === "admin" ? "block" : "none";
  }
}

// ============================================================================
// Polling Mechanism (Every 3s, only when tab is visible)
// ============================================================================

function startPolling() {
  if (state.pollTimer) return;
  state.pollTimer = setInterval(async () => {
    // Only poll when document is visible and user is logged in
    if (document.hidden || !state.currentUser) return;

    try {
      if (state.activeRoute === "devices") {
        await renderDevices(true); // silent refresh
      } else if (state.activeRoute === "jobs" && !state.routeParam) {
        await renderJobs(true); // silent refresh
      } else if (state.activeRoute === "jobs" && state.routeParam) {
        await renderJobDetail(state.routeParam, true); // silent refresh
      }
    } catch (e) {
      // Ignore polling errors
    }
  }, 3000);
}

function stopPolling() {
  if (state.pollTimer) {
    clearInterval(state.pollTimer);
    state.pollTimer = null;
  }
}

// ============================================================================
// View: Devices
// ============================================================================

async function renderDevices(isSilent = false) {
  const titleEl = document.getElementById("page-title");
  const actionsEl = document.getElementById("top-bar-actions");
  const bodyEl = document.getElementById("content-body");

  if (!isSilent) {
    titleEl.textContent = "Connected Devices";
    actionsEl.innerHTML = `
      <button class="btn btn-primary" id="btn-add-device">
        <span>+ Add Device</span>
      </button>
    `;
    actionsEl.querySelector("#btn-add-device").onclick = () => openAddDeviceModal();
  }

  const devices = await apiFetch("/api/devices");

  // Update badge in sidebar
  const badgeEl = document.getElementById("badge-devices");
  if (badgeEl) badgeEl.textContent = devices.filter((d) => d.status === "online").length;

  if (devices.length === 0) {
    bodyEl.innerHTML = `
      <div class="card card-body" style="text-align: center; padding: 48px;">
        <h3>No devices paired yet</h3>
        <p class="text-muted" style="margin: 8px 0 16px;">Pair a Chrome browser running the extension to start automating ChatGPT image generation.</p>
        <button class="btn btn-primary" id="btn-add-device-empty">+ Add Your First Device</button>
      </div>
    `;
    bodyEl.querySelector("#btn-add-device-empty")?.addEventListener("click", () => openAddDeviceModal());
    return;
  }

  const cardsHtml = devices
    .map((d) => {
      const statusClass = `badge-${d.status}`;
      const tagsHtml = (d.tags || []).map((t) => `<span class="tag-pill">${escapeHtml(t)}</span>`).join("");
      const isPaused = d.paused || d.status === "paused";

      return `
        <div class="device-card" data-device-id="${escapeHtml(d.id)}">
          <div class="device-card-header">
            <div>
              <div class="device-card-title">${escapeHtml(d.label)}</div>
              <div class="mono text-muted" style="font-size: 11px;">${escapeHtml(d.id)}</div>
            </div>
            <span class="badge ${statusClass}">
              <span class="badge-dot"></span>
              ${escapeHtml(d.status)}
            </span>
          </div>

          <div style="min-height: 24px;">${tagsHtml || '<span class="text-muted" style="font-size:11px;">No tags</span>'}</div>

          <div class="device-meta">
            <div>Extension: <strong class="mono">${escapeHtml(d.extVersion || "0.1.0")}</strong></div>
            <div>Last seen: <strong>${formatTimeAgo(d.lastSeenAt)}</strong></div>
            <div>Last job: <strong>${formatTimeAgo(d.lastJobAt)}</strong></div>
          </div>

          <div class="device-actions">
            <button class="btn btn-secondary btn-sm btn-edit-device" data-id="${escapeHtml(d.id)}">Edit</button>
            ${d.status === "offline" ? `<button class="btn btn-primary btn-sm btn-repair-device" data-id="${escapeHtml(d.id)}">Re-pair</button>` : ""}
            <button class="btn btn-secondary btn-sm btn-toggle-pause" data-id="${escapeHtml(d.id)}" data-paused="${isPaused}">
              ${isPaused ? "Resume" : "Pause"}
            </button>
            <button class="btn btn-danger-outline btn-sm btn-delete-device" data-id="${escapeHtml(d.id)}" style="margin-left:auto;">
              Delete
            </button>
          </div>
        </div>
      `;
    })
    .join("");

  bodyEl.innerHTML = `<div class="device-grid">${cardsHtml}</div>`;

  // Attach event handlers
  bodyEl.querySelectorAll(".btn-repair-device").forEach((btn) => {
    btn.onclick = () => openAddDeviceModal(btn.dataset.id);
  });

  bodyEl.querySelectorAll(".btn-edit-device").forEach((btn) => {
    btn.onclick = () => {
      const dev = devices.find((d) => d.id === btn.dataset.id);
      if (dev) openEditDeviceModal(dev);
    };
  });

  bodyEl.querySelectorAll(".btn-toggle-pause").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      const currentlyPaused = btn.dataset.paused === "true";
      try {
        await apiFetch(`/api/devices/${id}`, {
          method: "PATCH",
          body: { paused: !currentlyPaused },
        });
        showToast(currentlyPaused ? "Device resumed" : "Device paused");
        await renderDevices();
      } catch (err) {
        showToast(err.message, "error");
      }
    };
  });

  bodyEl.querySelectorAll(".btn-delete-device").forEach((btn) => {
    btn.onclick = () => {
      const id = btn.dataset.id;
      if (!confirm(`Are you sure you want to delete device ${id}?`)) return;
      apiFetch(`/api/devices/${id}`, { method: "DELETE" })
        .then(() => {
          showToast("Device deleted");
          renderDevices();
        })
        .catch((e) => showToast(e.message, "error"));
    };
  });
}

async function openAddDeviceModal(deviceId = null) {
  try {
    const pairing = await apiFetch(deviceId ? `/api/devices/${deviceId}/pairing` : "/api/devices/pairing", { method: "POST" });
    const expiresTimestamp = new Date(pairing.expiresAt).getTime();

    const contentHtml = `
      <div>
        <p class="text-muted" style="margin-bottom: 12px;">
          Enter this pairing code into your Chrome Extension's options page to link your browser profile.
        </p>

        <div class="pairing-box">
          <div style="font-size: 11px; text-transform: uppercase; color: var(--text-muted); font-weight: 600;">Pairing Code</div>
          <div class="pairing-code" id="display-pairing-code">${escapeHtml(pairing.code)}</div>
          <div class="pairing-timer" id="display-pairing-timer">Valid for 10:00</div>
          <button class="btn btn-secondary btn-sm" id="btn-copy-code" style="margin-top: 10px;">
            Copy Code
          </button>
        </div>

        <div style="font-size: 13px; background: var(--bg-surface-hover); padding: 12px; border-radius: var(--radius-md);">
          <strong>Instructions:</strong>
          <ol style="margin-left: 20px; margin-top: 6px; line-height: 1.6;">
            <li>Open Chrome where the Browser LLM Broker extension is loaded.</li>
            <li>Click the extension icon (or right-click → <strong>Options</strong>).${deviceId ? " If it shows as already paired, press <strong>Disconnect this browser</strong> first." : ""}</li>
            <li>Enter this server's address (<code>${escapeHtml(location.origin)}</code>) and the pairing code, then click <strong>Connect</strong>.</li>
            <li>${deviceId ? "This device keeps its name, tags and history; only its access token is replaced." : "The device will automatically link and appear in your dashboard."}</li>
          </ol>
        </div>
      </div>
    `;

    showModal({
      title: deviceId ? "Re-pair Device" : "Add New Device",
      contentHtml,
      hideConfirm: true,
      cancelText: "Done",
    });

    const copyBtn = document.getElementById("btn-copy-code");
    if (copyBtn) {
      copyBtn.onclick = () => {
        copyText(pairing.code);
        copyBtn.textContent = "Copied!";
        setTimeout(() => { copyBtn.textContent = "Copy Code"; }, 2000);
      };
    }

    // Countdown timer
    const timerEl = document.getElementById("display-pairing-timer");
    state.countdownTimer = setInterval(() => {
      const remainingSec = Math.max(0, Math.floor((expiresTimestamp - Date.now()) / 1000));
      const m = Math.floor(remainingSec / 60);
      const s = remainingSec % 60;
      if (timerEl) {
        timerEl.textContent = `Valid for ${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
      }
      if (remainingSec <= 0) {
        clearInterval(state.countdownTimer);
        state.countdownTimer = null;
        if (timerEl) timerEl.textContent = "Code expired. Please generate a new one.";
      }
    }, 1000);

  } catch (err) {
    showToast(err.message, "error");
  }
}

function openEditDeviceModal(dev) {
  const contentHtml = `
    <form id="form-edit-device">
      <div class="form-group">
        <label class="form-label" for="edit-dev-label">Device Label</label>
        <input class="input" type="text" id="edit-dev-label" value="${escapeHtml(dev.label)}" required>
      </div>

      <div class="form-group">
        <label class="form-label" for="edit-dev-tags">Tags (comma-separated)</label>
        <input class="input" type="text" id="edit-dev-tags" value="${escapeHtml((dev.tags || []).join(", "))}" placeholder="gpu, primary, macbook">
        <div class="form-help">Use tags to route jobs to specific clusters of Chrome devices.</div>
      </div>
    </form>
  `;

  showModal({
    title: "Edit Device",
    contentHtml,
    confirmText: "Update Device",
    onConfirm: async () => {
      const label = document.getElementById("edit-dev-label")?.value.trim();
      const tagsRaw = document.getElementById("edit-dev-tags")?.value || "";
      const tags = tagsRaw.split(",").map((t) => t.trim()).filter(Boolean);

      if (!label) throw new Error("Device label cannot be empty");

      await apiFetch(`/api/devices/${dev.id}`, {
        method: "PATCH",
        body: { label, tags },
      });

      showToast("Device updated");
      await renderDevices();
    },
  });
}

// ============================================================================
// View: Jobs
// ============================================================================

async function renderJobs(isSilent = false) {
  const titleEl = document.getElementById("page-title");
  const actionsEl = document.getElementById("top-bar-actions");
  const bodyEl = document.getElementById("content-body");

  if (!isSilent) {
    titleEl.textContent = "Generation Jobs";
    const isAdmin = state.currentUser?.role === "admin";

    actionsEl.innerHTML = `
      <div style="display: flex; align-items: center; gap: 12px;">
        ${isAdmin ? `
          <label class="checkbox-label text-muted" style="font-size: 12px;">
            <input type="checkbox" id="chk-all-jobs" ${state.showAllJobs ? "checked" : ""}>
            Show all users' jobs
          </label>
        ` : ""}
        <button class="btn btn-primary" id="btn-new-job">+ New Job</button>
      </div>
    `;

    actionsEl.querySelector("#btn-new-job").onclick = openNewJobModal;

    const allChk = actionsEl.querySelector("#chk-all-jobs");
    if (allChk) {
      allChk.onchange = (e) => {
        state.showAllJobs = e.target.checked;
        renderJobs();
      };
    }
  }

  const query = state.showAllJobs ? "?limit=50&all=1" : "?limit=50";
  const jobs = await apiFetch(`/api/jobs${query}`);

  // Update running badge
  const badgeEl = document.getElementById("badge-jobs");
  if (badgeEl) {
    const runningCount = jobs.filter((j) => j.state === "running" || j.state === "queued").length;
    badgeEl.textContent = runningCount;
  }

  if (jobs.length === 0) {
    bodyEl.innerHTML = `
      <div class="card card-body" style="text-align: center; padding: 48px;">
        <h3>No jobs found</h3>
        <p class="text-muted" style="margin: 8px 0 16px;">Trigger an image generation task from the dashboard or via MCP.</p>
        <button class="btn btn-primary" id="btn-new-job-empty">+ Create a Job</button>
      </div>
    `;
    bodyEl.querySelector("#btn-new-job-empty")?.addEventListener("click", openNewJobModal);
    return;
  }

  const rowsHtml = jobs
    .map((j) => {
      const stateBadge = `badge-${j.state}`;
      return `
        <tr>
          <td><a href="#jobs/${escapeHtml(j.id)}" class="mono" style="font-weight:600;">${escapeHtml(j.id)}</a></td>
          <td><span class="badge ${stateBadge}"><span class="badge-dot"></span>${escapeHtml(j.state)}</span></td>
          <td><span class="tag-pill">${escapeHtml(j.mode)}</span></td>
          <td style="max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${escapeHtml(j.promptPreview || "—")}
          </td>
          <td>${escapeHtml(j.deviceLabel || j.deviceId || "Auto")}</td>
          <td><span class="tag-pill">${escapeHtml(j.source)}</span></td>
          <td>${formatDate(j.createdAt)}</td>
          <td>
            <a href="#jobs/${escapeHtml(j.id)}" class="btn btn-secondary btn-sm">View</a>
            ${j.state === "queued" || j.state === "running" ? `
              <button class="btn btn-danger-outline btn-sm btn-cancel-job" data-id="${escapeHtml(j.id)}">Cancel</button>
            ` : `
              <button class="btn btn-danger-outline btn-sm btn-delete-job" data-id="${escapeHtml(j.id)}">Delete</button>
            `}
          </td>
        </tr>
      `;
    })
    .join("");

  bodyEl.innerHTML = `
    <div class="card">
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>ID</th>
              <th>Status</th>
              <th>Mode</th>
              <th>Prompt Preview</th>
              <th>Device</th>
              <th>Source</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  `;

  bodyEl.querySelectorAll(".btn-delete-job").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      if (!confirm(`Delete job ${id} and its result? This cannot be undone.`)) return;
      try {
        await apiFetch(`/api/jobs/${id}`, { method: "DELETE" });
        showToast("Job deleted");
        await renderJobs(true);
      } catch (err) {
        showToast(err.message, "error");
      }
    };
  });

  bodyEl.querySelectorAll(".btn-cancel-job").forEach((btn) => {
    btn.onclick = async (e) => {
      e.stopPropagation();
      const id = btn.dataset.id;
      if (!confirm(`Cancel job ${id}?`)) return;
      try {
        await apiFetch(`/api/jobs/${id}/cancel`, { method: "POST" });
        showToast("Job canceled");
        await renderJobs();
      } catch (err) {
        showToast(err.message, "error");
      }
    };
  });
}

async function openNewJobModal() {
  let devices = [];
  try {
    devices = await apiFetch("/api/devices");
  } catch (e) {}

  const deviceOptions = devices
    .map((d) => `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)} (${escapeHtml(d.status)})</option>`)
    .join("");

  let jobChannels = [];
  try {
    jobChannels = await apiFetch("/api/channels");
  } catch (e) {}
  const jobChannelOptions = jobChannels
    .map((c) => `<option value="${escapeHtml(c.id)}">${escapeHtml(c.name)} (${c.type === "webhook" ? "webhook" : "Telegram"})</option>`)
    .join("");

  const contentHtml = `
    <form id="form-new-job">
      <div class="form-group">
        <label class="form-label" for="job-prompt">Image Prompt *</label>
        <textarea class="textarea" id="job-prompt" placeholder="A futuristic solar-powered airship hovering over lush mountains..." required></textarea>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="job-mode">Mode</label>
          <select class="select" id="job-mode">
            <option value="image">Image (DALL-E 3)</option>
            <option value="text">Text only</option>
            <option value="auto">Auto</option>
          </select>
        </div>

        <div class="form-group">
          <label class="form-label" for="job-timeout">Timeout (seconds)</label>
          <input class="input" type="number" id="job-timeout" value="180" min="30" max="600">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="job-conv-url">Existing Conversation URL (Optional)</label>
        <input class="input" type="url" id="job-conv-url" placeholder="https://chatgpt.com/c/...">
        <div class="form-help">Leave empty to generate in a clean temporary chat.</div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="job-target-device">Target Device</label>
          <select class="select" id="job-target-device">
            <option value="">Auto (Any available online device)</option>
            ${deviceOptions}
          </select>
        </div>

        <div class="form-group">
          <label class="form-label" for="job-target-tag">Or Target Tag</label>
          <input class="input" type="text" id="job-target-tag" placeholder="e.g. gpu, fast">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="job-channel">Also send the result to (optional)</label>
        <select class="select" id="job-channel">
          <option value="">Nowhere (just keep it in the dashboard)</option>
          ${jobChannelOptions}
        </select>
      </div>
    </form>
  `;

  showModal({
    title: "Submit New Job",
    contentHtml,
    confirmText: "Generate Now",
    onConfirm: async () => {
      const prompt = document.getElementById("job-prompt")?.value.trim();
      if (!prompt) throw new Error("Prompt is required");

      const mode = document.getElementById("job-mode")?.value || "image";
      const timeoutSec = Number(document.getElementById("job-timeout")?.value || 180);
      const conversationUrl = document.getElementById("job-conv-url")?.value.trim() || undefined;
      const deviceId = document.getElementById("job-target-device")?.value || undefined;
      const tag = document.getElementById("job-target-tag")?.value.trim() || undefined;

      const target = deviceId ? { deviceId } : tag ? { tag } : undefined;
      const channelId = document.getElementById("job-channel")?.value || undefined;

      const res = await apiFetch("/api/jobs", {
        method: "POST",
        body: {
          prompt,
          mode,
          timeoutMs: timeoutSec * 1000,
          conversationUrl,
          target,
          channelId,
        },
      });

      showToast("Job submitted successfully");
      navigate(`#jobs/${res.id}`);
    },
  });

  // Remember the last choices (per browser) for the next job.
  const PREF_KEY = "newJobPrefs";
  const fields = { mode: "job-mode", timeout: "job-timeout", conversationUrl: "job-conv-url", deviceId: "job-target-device", tag: "job-target-tag", channelId: "job-channel" };
  let prefs = {};
  try { prefs = JSON.parse(localStorage.getItem(PREF_KEY) || "{}"); } catch (e) {}
  for (const [key, id] of Object.entries(fields)) {
    const el = document.getElementById(id);
    if (!el) continue;
    if (prefs[key] !== undefined && prefs[key] !== null) {
      el.value = prefs[key];
      if (el.tagName === "SELECT" && el.value !== String(prefs[key])) el.value = ""; // saved option no longer exists
    }
    const save = () => {
      const cur = {};
      for (const [k, i] of Object.entries(fields)) cur[k] = document.getElementById(i)?.value ?? "";
      try { localStorage.setItem(PREF_KEY, JSON.stringify(cur)); } catch (e) {}
    };
    el.addEventListener("change", save);
    el.addEventListener("input", save);
  }
}

// ============================================================================
// View: Job Details
// ============================================================================

async function renderJobDetail(jobId, isSilent = false) {
  const titleEl = document.getElementById("page-title");
  const actionsEl = document.getElementById("top-bar-actions");
  const bodyEl = document.getElementById("content-body");

  if (!isSilent) {
    titleEl.textContent = `Job ${jobId}`;
    actionsEl.innerHTML = `
      <div style="display:flex; gap:8px;">
        <button class="btn btn-secondary btn-sm" id="btn-back-jobs">← Back to Jobs</button>
        <button class="btn btn-danger-outline btn-sm hidden" id="btn-cancel-detail">Cancel Job</button>
        <button class="btn btn-danger-outline btn-sm" id="btn-delete-detail">Delete</button>
      </div>
    `;
    actionsEl.querySelector("#btn-back-jobs").onclick = () => navigate("#jobs");
    actionsEl.querySelector("#btn-delete-detail").onclick = async () => {
      if (!confirm(`Delete job ${jobId} and its result? This cannot be undone.`)) return;
      try {
        await apiFetch(`/api/jobs/${jobId}`, { method: "DELETE" });
        showToast("Job deleted");
        navigate("#jobs");
      } catch (err) {
        showToast(err.message, "error");
      }
    };
  }

  const job = await apiFetch(`/api/jobs/${jobId}`);

  // Finished jobs do not change: skip silent re-renders so the follow-up box keeps what you typed.
  const detailKey = `${jobId}:${job.state}`;
  if (isSilent && (job.state === "succeeded" || job.state === "failed" || job.state === "canceled") && state.detailKey === detailKey) return;
  state.detailKey = detailKey;

  const cancelBtn = actionsEl.querySelector("#btn-cancel-detail");
  if (cancelBtn) {
    if (job.state === "queued" || job.state === "running") {
      cancelBtn.classList.remove("hidden");
      cancelBtn.onclick = async () => {
        if (!confirm(`Cancel job ${jobId}?`)) return;
        await apiFetch(`/api/jobs/${jobId}/cancel`, { method: "POST" });
        showToast("Job canceled");
        await renderJobDetail(jobId);
      };
    } else {
      cancelBtn.classList.add("hidden");
    }
  }

  const imagesHtml = (job.images || []).map((img, idx) => `
    <div class="gallery-item">
      <a href="${escapeHtml(img.url)}" target="_blank" rel="noopener"><img src="${escapeHtml(img.url)}" alt="ChatGPT Generated Image" class="gallery-img"></a>
      <div class="gallery-item-footer">
        <span class="mono text-muted" style="font-size:11px;">Image #${idx + 1} (${escapeHtml(img.mime || "image/png")})</span>
        <a href="${escapeHtml(img.url)}" download="image-${idx + 1}.png" class="btn btn-secondary btn-sm">Download</a>
      </div>
    </div>
  `).join("");

  const timelineHtml = (job.progress || []).map((p) => `
    <li class="timeline-item">
      <div class="timeline-dot"></div>
      <div class="timeline-time">${formatDate(p.ts)}</div>
      <div class="timeline-msg">${escapeHtml(p.message)}</div>
    </li>
  `).join("");

  bodyEl.innerHTML = `
    <div class="job-detail-wrap">
      <!-- Status Card -->
      <div class="card card-body">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 16px;">
          <div>
            <span class="badge badge-${escapeHtml(job.state)}" style="font-size: 13px; padding: 4px 12px;">
              <span class="badge-dot"></span>
              ${escapeHtml(job.state.toUpperCase())}
            </span>
          </div>
          <div class="text-muted" style="font-size: 12px;">
            Created: <strong>${formatDate(job.createdAt)}</strong>
          </div>
        </div>

        <div class="stats-grid" style="grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); margin-bottom: 0;">
          <div class="stat-card">
            <div class="stat-label">Mode</div>
            <div style="font-weight: 600;">${escapeHtml(job.mode)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Device</div>
            <div style="font-weight: 600;">${escapeHtml(job.deviceLabel || job.deviceId || "Auto")}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Source</div>
            <div style="font-weight: 600;">${escapeHtml(job.source)}</div>
          </div>
          <div class="stat-card">
            <div class="stat-label">Images</div>
            <div style="font-weight: 600;">${job.imageCount || (job.images ? job.images.length : 0)}</div>
          </div>
        </div>
      </div>

      <!-- Error Card (if any) -->
      ${job.error ? `
        <div class="alert alert-danger">
          <strong>Error:</strong> ${escapeHtml(job.error)}
        </div>
      ` : ""}

      <!-- Prompt Card -->
      <div class="card">
        <div class="card-header">
          <h3>Prompt</h3>
          <button class="btn btn-secondary btn-sm" id="btn-copy-prompt">Copy</button>
        </div>
        <div class="card-body">
          <p style="white-space: pre-wrap; margin:0;">${escapeHtml(job.prompt)}</p>
          ${job.conversationUrl ? `
            <div style="margin-top: 12px; font-size: 12px;">
              Conversation URL: <a href="${escapeHtml(job.conversationUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(job.conversationUrl)}</a>
            </div>
          ` : ""}
        </div>
      </div>

      <!-- Result Text Card (if any) -->
      ${(job.markdown || job.text) ? `
        <div class="card">
          <div class="card-header">
            <h3>ChatGPT Response Text</h3>
          </div>
          <div class="card-body">
            <div class="md">${renderMarkdown(job.markdown || job.text)}</div>
          </div>
        </div>
      ` : ""}

      <!-- Images Gallery Card -->
      <div class="card">
        <div class="card-header">
          <h3>Generated Images</h3>
        </div>
        <div class="card-body">
          ${imagesHtml ? `<div class="gallery-grid">${imagesHtml}</div>` : `
            <div class="text-muted" style="padding: 24px; text-align: center;">
              ${job.state === "running" ? "Image generation is in progress..." : "No images generated for this job."}
            </div>
          `}
        </div>
      </div>

      <!-- Timeline Card (always last) -->
      <div class="card" id="card-progress">
        <div class="card-header">
          <h3>Execution Progress</h3>
        </div>
        <div class="card-body">
          ${timelineHtml ? `<div class="timeline-scroll"><ul class="timeline">${timelineHtml}</ul></div>` : `<p class="text-muted">No progress events recorded.</p>`}
        </div>
      </div>
    </div>
  `;
  typesetMath(bodyEl);

  // Continue the same ChatGPT conversation
  const wrap = bodyEl.querySelector(".job-detail-wrap") || bodyEl;
  if (job.parentId) {
    const p = document.createElement("div");
    p.className = "text-muted";
    p.style.cssText = "font-size:13px; margin-bottom:8px;";
    p.innerHTML = `Follow-up of <a href="#jobs/${escapeHtml(job.parentId)}">${escapeHtml(job.parentId.slice(0, 8))}…</a>`;
    wrap.prepend(p);
  }
  const inFlight = job.state === "queued" || job.state === "running";
  if (job.state === "succeeded" || inFlight) {
    const card = document.createElement("div");
    card.className = "card";
    card.style.marginTop = "16px";
    const canContinue = job.state === "succeeded" && !!job.chatUrl;
    card.innerHTML = job.state === "succeeded" && !job.chatUrl
      ? `<div class="card-body text-muted">This job has no conversation link (temporary chat, or ChatGPT did not expose the URL), so it cannot be continued.</div>`
      : `<div class="card-header"><h3>Continue this conversation</h3></div>
         <div class="card-body">
           <textarea class="textarea" id="followup-prompt" rows="3" ${canContinue ? "" : "disabled"}
             placeholder="${inFlight ? "Waiting for ChatGPT's reply…" : "Reply in the same ChatGPT conversation…"}"></textarea>
           <div style="display:flex; gap:8px; margin-top:10px; align-items:center; flex-wrap:wrap;">
             <select class="select" id="followup-mode" style="max-width:160px;" ${canContinue ? "" : "disabled"}>
               ${["auto", "text", "image"].map((m) => `<option value="${m}" ${job.mode === m ? "selected" : ""}>${m}</option>`).join("")}
             </select>
             <button class="btn btn-primary" id="btn-followup" ${canContinue ? "" : "disabled"}>Send</button>
             <span class="text-muted" style="font-size:12px;">${inFlight ? "Available when the result is ready." : "Runs on the same Chrome device when it is available."}</span>
           </div>
         </div>`;
    // Keep the execution log as the very last block.
    const progressCard = wrap.querySelector("#card-progress");
    if (progressCard) wrap.insertBefore(card, progressCard); else wrap.appendChild(card);
    card.querySelector("#btn-followup")?.addEventListener("click", async (ev) => {
      const prompt = card.querySelector("#followup-prompt").value.trim();
      if (!prompt) return showToast("Write a message first", "error");
      ev.target.disabled = true;
      try {
        const res = await apiFetch(`/api/jobs/${job.id}/followup`, {
          method: "POST",
          body: { prompt, mode: card.querySelector("#followup-mode").value },
        });
        showToast("Follow-up submitted");
        navigate(`#jobs/${res.id}`);
      } catch (err) {
        showToast(err.message, "error");
        ev.target.disabled = false;
      }
    });
  }

  bodyEl.querySelector("#btn-copy-prompt")?.addEventListener("click", () => {
    copyText(job.prompt);
    showToast("Prompt copied to clipboard");
  });
}

// ============================================================================
// View: Schedules
// ============================================================================

async function renderSchedules() {
  const titleEl = document.getElementById("page-title");
  const actionsEl = document.getElementById("top-bar-actions");
  const bodyEl = document.getElementById("content-body");

  titleEl.textContent = "Automation Schedules";
  actionsEl.innerHTML = `
    <button class="btn btn-primary" id="btn-new-schedule">+ New Schedule</button>
  `;
  actionsEl.querySelector("#btn-new-schedule").onclick = () => openScheduleModal();

  const schedules = await apiFetch("/api/schedules");

  if (schedules.length === 0) {
    bodyEl.innerHTML = `
      <div class="card card-body" style="text-align: center; padding: 48px;">
        <h3>No schedules configured</h3>
        <p class="text-muted" style="margin: 8px 0 16px;">Set up cron or interval schedules to generate images and push the results to Telegram or an external API automatically.</p>
        <button class="btn btn-primary" id="btn-new-sch-empty">+ Create Schedule</button>
      </div>
    `;
    bodyEl.querySelector("#btn-new-sch-empty")?.addEventListener("click", () => openScheduleModal());
    return;
  }

  const rowsHtml = schedules
    .map((s) => {
      const timingText = s.kind === "daily" ? `Daily at ${escapeHtml(s.time)} (${escapeHtml(s.timezone)})` : `Every ${escapeHtml(s.everyMinutes)}m`;

      return `
        <tr>
          <td><strong>${escapeHtml(s.name)}</strong></td>
          <td>
            <span class="badge ${s.enabled ? "badge-online" : "badge-offline"}">
              <span class="badge-dot"></span>
              ${s.enabled ? "Active" : "Disabled"}
            </span>
          </td>
          <td>${timingText}</td>
          <td style="max-width: 250px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
            ${escapeHtml(s.prompt)}
          </td>
          <td>${formatDate(s.nextRunAt)}</td>
          <td>${s.lastStatus ? `<span class="badge badge-${escapeHtml(s.lastStatus)}">${escapeHtml(s.lastStatus)}</span>` : "—"}</td>
          <td>
            <button class="btn btn-secondary btn-sm btn-run-schedule" data-id="${escapeHtml(s.id)}">Run Now</button>
            <button class="btn btn-secondary btn-sm btn-edit-schedule" data-id="${escapeHtml(s.id)}">Edit</button>
            <button class="btn btn-danger-outline btn-sm btn-delete-schedule" data-id="${escapeHtml(s.id)}">Delete</button>
          </td>
        </tr>
      `;
    })
    .join("");

  bodyEl.innerHTML = `
    <div class="card">
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Schedule Name</th>
              <th>Status</th>
              <th>Frequency</th>
              <th>Prompt</th>
              <th>Next Run</th>
              <th>Last Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  `;

  bodyEl.querySelectorAll(".btn-run-schedule").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      try {
        const res = await apiFetch(`/api/schedules/${id}/run`, { method: "POST" });
        showToast(`Job queued from schedule: ${res.jobId}`);
      } catch (err) {
        showToast(err.message, "error");
      }
    };
  });

  bodyEl.querySelectorAll(".btn-edit-schedule").forEach((btn) => {
    btn.onclick = () => {
      const sch = schedules.find((s) => s.id === btn.dataset.id);
      if (sch) openScheduleModal(sch);
    };
  });

  bodyEl.querySelectorAll(".btn-delete-schedule").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      if (!confirm(`Delete schedule ${id}?`)) return;
      try {
        await apiFetch(`/api/schedules/${id}`, { method: "DELETE" });
        showToast("Schedule deleted");
        await renderSchedules();
      } catch (err) {
        showToast(err.message, "error");
      }
    };
  });
}

async function openScheduleModal(sch = null) {
  let channels = [];
  try {
    channels = await apiFetch("/api/channels");
  } catch (e) {}

  let schDevices = [];
  try {
    schDevices = await apiFetch("/api/devices");
  } catch (e) {}
  const schDeviceOptions = schDevices
    .map((d) => `<option value="${escapeHtml(d.id)}" ${sch?.target?.deviceId === d.id ? "selected" : ""}>${escapeHtml(d.label)}</option>`)
    .join("");

  const channelOptions = channels
    .map((c) => `<option value="${escapeHtml(c.id)}" ${sch?.channelId === c.id ? "selected" : ""}>${escapeHtml(c.name)} (${c.type === "webhook" ? "webhook" : "Telegram"})</option>`)
    .join("");

  const localTz = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

  const contentHtml = `
    <form id="form-schedule">
      <div class="form-group">
        <label class="form-label" for="sch-name">Schedule Name *</label>
        <input class="input" type="text" id="sch-name" value="${escapeHtml(sch?.name || "")}" required placeholder="Daily Marketing Wallpaper">
      </div>

      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" id="sch-enabled" ${sch ? (sch.enabled ? "checked" : "") : "checked"}>
          Schedule Enabled
        </label>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="sch-kind">Schedule Type</label>
          <select class="select" id="sch-kind">
            <option value="daily" ${sch?.kind === "daily" ? "selected" : ""}>Daily at specific time</option>
            <option value="interval" ${sch?.kind === "interval" ? "selected" : ""}>Repeating interval</option>
          </select>
        </div>

        <div class="form-group" id="wrap-sch-time">
          <label class="form-label" for="sch-time">Time (HH:MM)</label>
          <input class="input" type="time" id="sch-time" value="${escapeHtml(sch?.time || "08:00")}">
        </div>

        <div class="form-group hidden" id="wrap-sch-interval">
          <label class="form-label" for="sch-interval">Every (minutes)</label>
          <input class="input" type="number" id="sch-interval" value="${sch?.everyMinutes || 60}" min="10">
        </div>
      </div>

      <div class="form-group">
        <label class="form-label" for="sch-tz">Timezone</label>
        <input class="input" type="text" id="sch-tz" value="${escapeHtml(sch?.timezone || localTz)}">
      </div>

      <div class="form-group">
        <label class="form-label" for="sch-prompt">Prompt *</label>
        <textarea class="textarea" id="sch-prompt" required placeholder="Generate an inspiring landscape...">${escapeHtml(sch?.prompt || "")}</textarea>
      </div>

      <div class="form-group">
        <label class="form-label" for="sch-conv-url">Existing Conversation URL (optional)</label>
        <input class="input" type="url" id="sch-conv-url" value="${escapeHtml(sch?.conversationUrl || "")}" placeholder="https://chatgpt.com/c/...">
        <div class="text-muted" style="font-size:12px">Open the old chat in ChatGPT and copy the address bar. The prompt above is sent into that chat as a new message (its memory and context are kept). Leave empty to use a new chat each run.</div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="sch-device">Run on device</label>
          <select class="select" id="sch-device">
            <option value="">Auto (any online device)</option>
            ${schDeviceOptions}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label" for="sch-tag">Or device tag</label>
          <input class="input" type="text" id="sch-tag" value="${escapeHtml(sch?.target?.tag || "")}" placeholder="e.g. art">
        </div>
      </div>

      <div class="form-row" id="wrap-sch-window">
        <div class="form-group">
          <label class="form-label" for="sch-active-from">Interval: active from (HH:MM)</label>
          <input class="input" type="time" id="sch-active-from" value="${escapeHtml(sch?.activeFrom || "")}">
        </div>
        <div class="form-group">
          <label class="form-label" for="sch-active-to">Interval: active until (HH:MM)</label>
          <input class="input" type="time" id="sch-active-to" value="${escapeHtml(sch?.activeTo || "")}">
        </div>
      </div>

      <div class="form-row">
        <div class="form-group">
          <label class="form-label" for="sch-channel">Notification Channel</label>
          <select class="select" id="sch-channel">
            <option value="">None (don't send anywhere)</option>
            ${channelOptions}
          </select>
        </div>

        <div class="form-group">
          <label class="form-label" for="sch-mode">Mode</label>
          <select class="select" id="sch-mode">
            <option value="image" ${sch?.mode === "image" ? "selected" : ""}>Image</option>
            <option value="text" ${sch?.mode === "text" ? "selected" : ""}>Text</option>
            <option value="auto" ${sch?.mode === "auto" ? "selected" : ""}>Auto</option>
          </select>
        </div>
      </div>

      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" id="sch-skip-unchanged" ${sch?.skipIfUnchanged ? "checked" : ""}>
          Skip notification if result is unchanged
        </label>
      </div>

      <div class="form-group">
        <label class="form-label" for="sch-skip-matches">Skip notification if text matches (regex, optional)</label>
        <input class="input mono" type="text" id="sch-skip-matches" value="${escapeHtml(sch?.skipIfMatches || "")}" placeholder="no new data|không có dữ liệu mới">
      </div>
    </form>
  `;

  showModal({
    title: sch ? "Edit Schedule" : "Create New Schedule",
    contentHtml,
    confirmText: sch ? "Update Schedule" : "Create Schedule",
    onConfirm: async () => {
      const name = document.getElementById("sch-name")?.value.trim();
      const prompt = document.getElementById("sch-prompt")?.value.trim();
      if (!name || !prompt) throw new Error("Name and Prompt are required");

      const kind = document.getElementById("sch-kind")?.value || "daily";
      const time = kind === "daily" ? document.getElementById("sch-time")?.value : null;
      const everyMinutes = kind === "interval" ? Number(document.getElementById("sch-interval")?.value) : null;
      const timezone = document.getElementById("sch-tz")?.value.trim() || "UTC";
      const enabled = document.getElementById("sch-enabled")?.checked;
      const channelId = document.getElementById("sch-channel")?.value || null;
      const mode = document.getElementById("sch-mode")?.value || "image";
      const skipIfUnchanged = document.getElementById("sch-skip-unchanged")?.checked || false;

      const conversationUrl = document.getElementById("sch-conv-url")?.value.trim() || null;
      const deviceId = document.getElementById("sch-device")?.value || "";
      const tag = document.getElementById("sch-tag")?.value.trim() || "";
      const target = deviceId ? { deviceId } : tag ? { tag } : null;
      const activeFrom = document.getElementById("sch-active-from")?.value || null;
      const activeTo = document.getElementById("sch-active-to")?.value || null;
      const skipIfMatches = document.getElementById("sch-skip-matches")?.value.trim() || null;

      const payload = {
        conversationUrl,
        target,
        activeFrom,
        activeTo,
        skipIfMatches,
        name,
        prompt,
        kind,
        time,
        everyMinutes,
        timezone,
        enabled,
        channelId,
        mode,
        skipIfUnchanged,
      };

      if (sch) {
        await apiFetch(`/api/schedules/${sch.id}`, { method: "PATCH", body: payload });
        showToast("Schedule updated");
      } else {
        await apiFetch("/api/schedules", { method: "POST", body: payload });
        showToast("Schedule created");
      }

      await renderSchedules();
    },
  });

  const kindSelect = document.getElementById("sch-kind");
  const timeWrap = document.getElementById("wrap-sch-time");
  const intervalWrap = document.getElementById("wrap-sch-interval");

  if (kindSelect && timeWrap && intervalWrap) {
    const updateVisibility = () => {
      if (kindSelect.value === "daily") {
        timeWrap.classList.remove("hidden");
        intervalWrap.classList.add("hidden");
      } else {
        timeWrap.classList.add("hidden");
        intervalWrap.classList.remove("hidden");
      }
    };
    kindSelect.onchange = updateVisibility;
    updateVisibility();
  }
}

// ============================================================================
// View: Channels (Telegram)
// ============================================================================

async function renderChannels() {
  const titleEl = document.getElementById("page-title");
  const actionsEl = document.getElementById("top-bar-actions");
  const bodyEl = document.getElementById("content-body");

  titleEl.textContent = "Notification Channels";
  actionsEl.innerHTML = `
    <button class="btn btn-primary" id="btn-add-channel">+ Add Channel</button>
  `;
  actionsEl.querySelector("#btn-add-channel").onclick = () => openChannelModal();

  const channels = await apiFetch("/api/channels");

  if (channels.length === 0) {
    bodyEl.innerHTML = `
      <div class="card card-body" style="text-align: center; padding: 48px;">
        <h3>No notification channels yet</h3>
        <p class="text-muted" style="margin: 8px 0 16px;">Send job and schedule results to a Telegram chat or to any external HTTP API (webhook).</p>
        <button class="btn btn-primary" id="btn-add-chan-empty">+ Add Channel</button>
      </div>
    `;
    bodyEl.querySelector("#btn-add-chan-empty")?.addEventListener("click", () => openChannelModal());
    return;
  }

  const rowsHtml = channels
    .map((c) => {
      const isHook = c.type === "webhook";
      const target = isHook ? c.config?.url : c.config?.chatId;
      const detail = isHook
        ? `${c.config?.method || "POST"} · images: ${c.config?.includeImages || "url"}${c.config?.hasSecret ? " · signed" : ""}`
        : `images as ${c.config?.sendAs || "photo"}`;
      const secret = isHook
        ? (c.config?.headerNames?.length ? `headers: ${c.config.headerNames.join(", ")}` : "—")
        : (c.config?.botTokenMasked || "••••••••");
      return `
      <tr>
        <td><strong>${escapeHtml(c.name)}</strong></td>
        <td><span class="tag-pill">${isHook ? "Webhook" : "Telegram"}</span></td>
        <td class="mono" style="max-width:280px; overflow-wrap:anywhere;">${escapeHtml(target || "—")}</td>
        <td>${escapeHtml(detail)}</td>
        <td class="mono text-muted">${escapeHtml(secret)}</td>
        <td>
          <button class="btn btn-secondary btn-sm btn-test-channel" data-id="${escapeHtml(c.id)}">Test</button>
          <button class="btn btn-secondary btn-sm btn-edit-channel" data-id="${escapeHtml(c.id)}">Edit</button>
          <button class="btn btn-danger-outline btn-sm btn-delete-channel" data-id="${escapeHtml(c.id)}">Delete</button>
        </td>
      </tr>
    `;
    })
    .join("");

  bodyEl.innerHTML = `
    <div class="card">
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Channel Name</th>
              <th>Type</th>
              <th>Target</th>
              <th>Details</th>
              <th>Credentials</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  `;

  bodyEl.querySelectorAll(".btn-test-channel").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      try {
        await apiFetch(`/api/channels/${id}/test`, { method: "POST" });
        showToast("Test message sent successfully");
      } catch (err) {
        showToast(err.message, "error");
      }
    };
  });

  bodyEl.querySelectorAll(".btn-edit-channel").forEach((btn) => {
    btn.onclick = () => {
      const chan = channels.find((c) => c.id === btn.dataset.id);
      if (chan) openChannelModal(chan);
    };
  });

  bodyEl.querySelectorAll(".btn-delete-channel").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      if (!confirm(`Delete channel ${id}?`)) return;
      try {
        await apiFetch(`/api/channels/${id}`, { method: "DELETE" });
        showToast("Channel deleted");
        await renderChannels();
      } catch (err) {
        showToast(err.message, "error");
      }
    };
  });
}

function parseHeaderLines(text) {
  const headers = {};
  for (const line of String(text || "").split("\n")) {
    const t = line.trim();
    if (!t) continue;
    const i = t.indexOf(":");
    if (i < 1) throw new Error(`Invalid header line: "${t}" (use Name: value)`);
    headers[t.slice(0, i).trim()] = t.slice(i + 1).trim();
  }
  return headers;
}

function openChannelModal(chan = null) {
  const type = chan?.type || "telegram";
  const cfg = chan?.config || {};
  const keepHint = chan ? " (leave blank to keep existing)" : "";
  const contentHtml = `
    <form id="form-channel">
      <div class="form-group">
        <label class="form-label" for="chan-type">Type</label>
        <select class="select" id="chan-type" ${chan ? "disabled" : ""}>
          <option value="telegram" ${type === "telegram" ? "selected" : ""}>Telegram bot</option>
          <option value="webhook" ${type === "webhook" ? "selected" : ""}>External API (webhook)</option>
        </select>
      </div>

      <div class="form-group">
        <label class="form-label" for="chan-name">Channel Name *</label>
        <input class="input" type="text" id="chan-name" value="${escapeHtml(chan?.name || "")}" placeholder="Marketing Updates" required>
      </div>

      <div id="sec-telegram">
        <div class="form-group">
          <label class="form-label" for="chan-bot-token">Telegram Bot Token ${chan ? keepHint : "*"}</label>
          <input class="input" type="password" id="chan-bot-token" placeholder="123456789:ABCdefGhIJKlmNoPQRsTUVwxyZ">
        </div>
        <div class="form-group">
          <label class="form-label" for="chan-chat-id">Chat ID *</label>
          <input class="input" type="text" id="chan-chat-id" value="${escapeHtml(cfg.chatId || "")}" placeholder="-1001234567890 or @channelusername">
        </div>
        <div class="form-group">
          <label class="form-label" for="chan-send-as">Send Images As</label>
          <select class="select" id="chan-send-as">
            <option value="photo" ${cfg.sendAs === "photo" || !cfg.sendAs ? "selected" : ""}>Photo (Compressed preview)</option>
            <option value="document" ${cfg.sendAs === "document" ? "selected" : ""}>Document (Uncompressed full quality)</option>
          </select>
        </div>
      </div>

      <div id="sec-webhook">
        <div class="form-row">
          <div class="form-group" style="flex:3">
            <label class="form-label" for="hook-url">Endpoint URL *</label>
            <input class="input" type="url" id="hook-url" value="${escapeHtml(cfg.url || "")}" placeholder="https://api.example.com/chatgpt-results">
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label" for="hook-method">Method</label>
            <select class="select" id="hook-method">
              ${["POST", "PUT", "PATCH"].map((m) => `<option ${((cfg.method || "POST") === m) ? "selected" : ""}>${m}</option>`).join("")}
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="hook-headers">Custom headers (one per line: <code>Name: value</code>)${chan ? keepHint : ""}</label>
          <textarea class="textarea" id="hook-headers" rows="3" placeholder="Authorization: Bearer xxxxx&#10;X-Api-Key: yyyyy"></textarea>
          ${chan && cfg.headerNames?.length ? `<div class="text-muted" style="font-size:12px">Currently set: ${escapeHtml(cfg.headerNames.join(", "))} (values hidden). Entering new headers replaces all of them.</div>` : ""}
        </div>
        <div class="form-row">
          <div class="form-group">
            <label class="form-label" for="hook-secret">Signing secret (optional)${chan ? (cfg.hasSecret ? " — set; blank keeps it, type a new one to replace" : "") : ""}</label>
            <input class="input" type="password" id="hook-secret" placeholder="HMAC-SHA256 secret">
          </div>
          <div class="form-group">
            <label class="form-label" for="hook-images">Images in payload</label>
            <select class="select" id="hook-images">
              <option value="url" ${(cfg.includeImages || "url") === "url" ? "selected" : ""}>Links (signed, valid 7 days)</option>
              <option value="base64" ${cfg.includeImages === "base64" ? "selected" : ""}>Embedded base64</option>
              <option value="none" ${cfg.includeImages === "none" ? "selected" : ""}>None (text only)</option>
            </select>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label" for="hook-template">Custom body template (optional)</label>
          <textarea class="textarea mono" id="hook-template" rows="4" placeholder='{"text": "{{markdown}}"}'>${escapeHtml(cfg.bodyTemplate || "")}</textarea>
          <div class="text-muted" style="font-size:12px">
            Leave empty to send the standard JSON (<code>event</code>, <code>job</code>, <code>schedule</code>, <code>result.text/markdown/images</code>).
            Placeholders: <code>{{text}} {{markdown}} {{prompt}} {{error}} {{state}} {{jobId}} {{scheduleName}} {{event}}</code> (JSON-escaped), <code>{{json}}</code> (whole payload).
            Requests carry <code>X-Broker-Event</code>; with a secret also <code>X-Broker-Timestamp</code> and <code>X-Broker-Signature: sha256=HMAC(secret, timestamp + "." + body)</code>.
          </div>
        </div>
      </div>
    </form>
  `;

  showModal({
    title: chan ? "Edit Channel" : "Add Channel",
    contentHtml,
    confirmText: chan ? "Update Channel" : "Save Channel",
    onConfirm: async () => {
      const kind = chan ? chan.type : document.getElementById("chan-type").value;
      const name = document.getElementById("chan-name")?.value.trim();
      if (!name) throw new Error("Name is required");
      let config;

      if (kind === "telegram") {
        const botToken = document.getElementById("chan-bot-token")?.value.trim();
        const chatId = document.getElementById("chan-chat-id")?.value.trim();
        const sendAs = document.getElementById("chan-send-as")?.value || "photo";
        if (!chatId) throw new Error("Chat ID is required");
        if (!chan && !botToken) throw new Error("Bot Token is required for new channels");
        config = { chatId, sendAs };
        if (botToken) config.botToken = botToken;
      } else {
        const url = document.getElementById("hook-url")?.value.trim();
        if (!url) throw new Error("Endpoint URL is required");
        config = {
          url,
          method: document.getElementById("hook-method").value,
          includeImages: document.getElementById("hook-images").value,
          bodyTemplate: document.getElementById("hook-template").value.trim(),
        };
        const headersText = document.getElementById("hook-headers").value;
        if (headersText.trim()) config.headers = parseHeaderLines(headersText);
        const secret = document.getElementById("hook-secret").value;
        if (secret) config.secret = secret;
        if (!config.bodyTemplate && !chan) delete config.bodyTemplate;
      }

      if (chan) {
        await apiFetch(`/api/channels/${chan.id}`, { method: "PATCH", body: { name, config } });
        showToast("Channel updated");
      } else {
        await apiFetch("/api/channels", { method: "POST", body: { type: kind, name, config } });
        showToast("Channel created");
      }
      await renderChannels();
    },
  });

  const sync = () => {
    const k = document.getElementById("chan-type").value;
    document.getElementById("sec-telegram").style.display = k === "telegram" ? "" : "none";
    document.getElementById("sec-webhook").style.display = k === "webhook" ? "" : "none";
  };
  document.getElementById("chan-type").addEventListener("change", sync);
  sync();
}

// ============================================================================
// View: API Keys
// ============================================================================

async function renderKeys() {
  const titleEl = document.getElementById("page-title");
  const actionsEl = document.getElementById("top-bar-actions");
  const bodyEl = document.getElementById("content-body");

  titleEl.textContent = "API Keys & Integrations";
  actionsEl.innerHTML = `
    <button class="btn btn-primary" id="btn-new-key">+ Create API Key</button>
  `;
  actionsEl.querySelector("#btn-new-key").onclick = openNewKeyModal;

  const keys = await apiFetch("/api/keys");

  const rowsHtml = keys
    .map((k) => `
      <tr>
        <td><strong>${escapeHtml(k.name)}</strong></td>
        <td><code class="mono">${escapeHtml(k.prefix)}••••••••</code></td>
        <td>${formatDate(k.createdAt)}</td>
        <td>${k.lastUsedAt ? formatTimeAgo(k.lastUsedAt) : "Never"}</td>
        <td>
          <button class="btn btn-danger-outline btn-sm btn-delete-key" data-id="${escapeHtml(k.id)}">Revoke</button>
        </td>
      </tr>
    `)
    .join("");

  bodyEl.innerHTML = `
    <!-- Integration Snippets Card -->
    <div class="card card-body" style="margin-bottom: 24px;">
      <h3 style="margin-bottom: 8px;">Claude Desktop / Code MCP Configuration</h3>
      <p class="text-muted">Use HTTP transport to connect Claude Desktop or Claude Code CLI to your broker:</p>
      
      <div class="code-box">
        <pre id="snippet-mcp">claude mcp add --transport http llm-broker "${location.origin}/mcp" --header "Authorization: Bearer &lt;YOUR_API_KEY&gt;"</pre>
        <button class="btn btn-secondary btn-sm copy-btn" id="btn-copy-mcp-snippet">Copy</button>
      </div>

      <h3 style="margin-top: 18px; margin-bottom: 8px;">REST API Quickstart</h3>
      <div class="code-box">
        <pre id="snippet-curl">curl -X POST "${location.origin}/v1/jobs?wait=120" \\
  -H "Authorization: Bearer &lt;YOUR_API_KEY&gt;" \\
  -H "Content-Type: application/json" \\
  -d '{"prompt": "Generate an image: a modern minimalist logo", "mode": "image"}'</pre>
        <button class="btn btn-secondary btn-sm copy-btn" id="btn-copy-curl-snippet">Copy</button>
      </div>
    </div>

    <!-- Keys Table -->
    <div class="card">
      <div class="card-header">
        <h3>Active API Keys</h3>
      </div>
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Prefix</th>
              <th>Created</th>
              <th>Last Used</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="5" style="text-align:center;" class="text-muted">No API keys created yet.</td></tr>'}
          </tbody>
        </table>
      </div>
    </div>
  `;

  bodyEl.querySelector("#btn-copy-mcp-snippet")?.addEventListener("click", () => {
    const text = document.getElementById("snippet-mcp")?.textContent || "";
    copyText(text);
    showToast("MCP command copied");
  });

  bodyEl.querySelector("#btn-copy-curl-snippet")?.addEventListener("click", () => {
    const text = document.getElementById("snippet-curl")?.textContent || "";
    copyText(text);
    showToast("cURL command copied");
  });

  bodyEl.querySelectorAll(".btn-delete-key").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      if (!confirm(`Revoke API key ${id}? Any client using it will be rejected.`)) return;
      try {
        await apiFetch(`/api/keys/${id}`, { method: "DELETE" });
        showToast("API key revoked");
        await renderKeys();
      } catch (err) {
        showToast(err.message, "error");
      }
    };
  });
}

function openNewKeyModal() {
  const contentHtml = `
    <form id="form-new-key">
      <div class="form-group">
        <label class="form-label" for="new-key-name">Key Description *</label>
        <input class="input" type="text" id="new-key-name" placeholder="e.g. Claude Code CLI, Jenkins Bot" required>
      </div>
    </form>
  `;

  showModal({
    title: "Generate API Key",
    contentHtml,
    confirmText: "Generate Key",
    onConfirm: async () => {
      const name = document.getElementById("new-key-name")?.value.trim();
      if (!name) throw new Error("Key name is required");

      const created = await apiFetch("/api/keys", {
        method: "POST",
        body: { name },
      });

      // Show key display modal (ONE TIME ONLY). Return false so the confirm handler
      // does not close the freshly opened success modal.
      await renderKeys();
      openKeySuccessModal(created);
      return false;
    },
  });
}

function openKeySuccessModal(keyData) {
  const mcpCommand = `claude mcp add --transport http llm-broker "${location.origin}/mcp" --header "Authorization: Bearer ${keyData.key}"`;
  const curlCommand = `curl -X POST "${location.origin}/v1/jobs?wait=120" -H "Authorization: Bearer ${keyData.key}" -H "Content-Type: application/json" -d '{"prompt":"Generate an image: a modern logo","mode":"image"}'`;

  const contentHtml = `
    <div>
      <div class="key-callout">
        <strong style="color: var(--warning-text);">Important:</strong>
        <p style="margin: 4px 0 0; font-size: 13px; color: var(--warning-text);">
          Please copy your API key now. For security reasons, it will <strong>never be shown again</strong>.
        </p>
      </div>

      <div class="form-group">
        <label class="form-label">API Key</label>
        <div class="code-box">
          <pre id="secret-key-display">${escapeHtml(keyData.key)}</pre>
          <button class="btn btn-primary btn-sm copy-btn" id="btn-copy-secret-key">Copy Key</button>
        </div>
      </div>

      <div class="form-group" style="margin-top: 16px;">
        <label class="form-label">Ready-to-use Claude MCP Command</label>
        <div class="code-box">
          <pre>${escapeHtml(mcpCommand)}</pre>
          <button class="btn btn-secondary btn-sm copy-btn" id="btn-copy-mcp-ready">Copy</button>
        </div>
      </div>
    </div>
  `;

  showModal({
    title: "API Key Created",
    contentHtml,
    hideConfirm: true,
    cancelText: "I have copied the key",
  });

  document.getElementById("btn-copy-secret-key")?.addEventListener("click", () => {
    copyText(keyData.key);
    showToast("API key copied to clipboard");
  });

  document.getElementById("btn-copy-mcp-ready")?.addEventListener("click", () => {
    copyText(mcpCommand);
    showToast("MCP command copied to clipboard");
  });
}

// ============================================================================
// View: Admin
// ============================================================================

async function renderAdmin() {
  if (state.currentUser?.role !== "admin") {
    navigate("#devices");
    return;
  }

  const titleEl = document.getElementById("page-title");
  const actionsEl = document.getElementById("top-bar-actions");
  const bodyEl = document.getElementById("content-body");

  titleEl.textContent = "Admin Management";
  actionsEl.innerHTML = `
    <button class="btn btn-primary" id="btn-add-user">+ Add User</button>
  `;
  actionsEl.querySelector("#btn-add-user").onclick = openAddUserModal;

  const [stats, users] = await Promise.all([
    apiFetch("/api/admin/stats"),
    apiFetch("/api/admin/users"),
  ]);

  const userRowsHtml = users
    .map((u) => `
      <tr>
        <td><strong>${escapeHtml(u.name)}</strong></td>
        <td>${escapeHtml(u.email)}</td>
        <td>
          <span class="badge ${u.role === "admin" ? "badge-paused" : "badge-offline"}">
            ${escapeHtml(u.role)}
          </span>
        </td>
        <td>
          <span class="badge ${u.disabled ? "badge-failed" : "badge-online"}">
            ${u.disabled ? "Disabled" : "Active"}
          </span>
        </td>
        <td>${u.deviceCount ?? 0}</td>
        <td>${formatDate(u.createdAt)}</td>
        <td>
          <button class="btn btn-secondary btn-sm btn-edit-user" data-id="${escapeHtml(u.id)}">Edit</button>
          ${u.id !== state.currentUser.id ? `
            <button class="btn btn-danger-outline btn-sm btn-delete-user" data-id="${escapeHtml(u.id)}">Delete</button>
          ` : ""}
        </td>
      </tr>
    `)
    .join("");

  bodyEl.innerHTML = `
    <!-- Stats Grid -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Total Users</div>
        <div class="stat-value">${stats.users}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Online Devices</div>
        <div class="stat-value text-success">${stats.devicesOnline} <span class="text-muted" style="font-size:14px;">/ ${stats.devicesTotal}</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Active Jobs</div>
        <div class="stat-value">${stats.jobsRunning} <span class="text-muted" style="font-size:14px;">(${stats.jobsQueued} queued)</span></div>
      </div>
      <div class="stat-card">
        <div class="stat-label">24h Jobs</div>
        <div class="stat-value">${stats.jobs24h}</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">24h Failures</div>
        <div class="stat-value ${stats.failed24h > 0 ? "text-danger" : ""}">${stats.failed24h}</div>
      </div>
    </div>

    <!-- Users Table Card -->
    <div class="card">
      <div class="card-header">
        <h3>User Accounts</h3>
      </div>
      <div class="table-responsive">
        <table class="data-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Devices</th>
              <th>Created</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            ${userRowsHtml}
          </tbody>
        </table>
      </div>
    </div>
  `;

  bodyEl.querySelectorAll(".btn-edit-user").forEach((btn) => {
    btn.onclick = () => {
      const u = users.find((usr) => usr.id === btn.dataset.id);
      if (u) openEditUserModal(u);
    };
  });

  bodyEl.querySelectorAll(".btn-delete-user").forEach((btn) => {
    btn.onclick = async () => {
      const id = btn.dataset.id;
      if (!confirm(`Delete user ${id}? All their devices and jobs will be removed.`)) return;
      try {
        await apiFetch(`/api/admin/users/${id}`, { method: "DELETE" });
        showToast("User deleted");
        await renderAdmin();
      } catch (err) {
        showToast(err.message, "error");
      }
    };
  });
}

function openAddUserModal() {
  const contentHtml = `
    <form id="form-add-user">
      <div class="form-group">
        <label class="form-label" for="add-user-name">Full Name *</label>
        <input class="input" type="text" id="add-user-name" required placeholder="Alex Smith">
      </div>

      <div class="form-group">
        <label class="form-label" for="add-user-email">Email Address *</label>
        <input class="input" type="email" id="add-user-email" required placeholder="alex@company.com">
      </div>

      <div class="form-group">
        <label class="form-label" for="add-user-password">Initial Password *</label>
        <input class="input" type="password" id="add-user-password" required placeholder="••••••••">
      </div>

      <div class="form-group">
        <label class="form-label" for="add-user-role">Role</label>
        <select class="select" id="add-user-role">
          <option value="user">Standard User</option>
          <option value="admin">Administrator</option>
        </select>
      </div>
    </form>
  `;

  showModal({
    title: "Create User Account",
    contentHtml,
    confirmText: "Create Account",
    onConfirm: async () => {
      const name = document.getElementById("add-user-name")?.value.trim();
      const email = document.getElementById("add-user-email")?.value.trim();
      const password = document.getElementById("add-user-password")?.value;
      const role = document.getElementById("add-user-role")?.value || "user";

      if (!name || !email || !password) throw new Error("All fields are required");

      await apiFetch("/api/admin/users", {
        method: "POST",
        body: { name, email, password, role },
      });

      showToast("User account created");
      await renderAdmin();
    },
  });
}

function openEditUserModal(user) {
  const contentHtml = `
    <form id="form-edit-user">
      <div class="form-group">
        <label class="form-label" for="edit-user-name">Full Name *</label>
        <input class="input" type="text" id="edit-user-name" value="${escapeHtml(user.name)}" required>
      </div>

      <div class="form-group">
        <label class="form-label" for="edit-user-role">Role</label>
        <select class="select" id="edit-user-role">
          <option value="user" ${user.role === "user" ? "selected" : ""}>Standard User</option>
          <option value="admin" ${user.role === "admin" ? "selected" : ""}>Administrator</option>
        </select>
      </div>

      <div class="form-group">
        <label class="form-label" for="edit-user-password">Reset Password (Optional)</label>
        <input class="input" type="password" id="edit-user-password" placeholder="Leave blank to keep current">
      </div>

      <div class="form-group">
        <label class="checkbox-label">
          <input type="checkbox" id="edit-user-disabled" ${user.disabled ? "checked" : ""}>
          Disable account (block sign in)
        </label>
      </div>
    </form>
  `;

  showModal({
    title: `Edit User: ${user.email}`,
    contentHtml,
    confirmText: "Save Changes",
    onConfirm: async () => {
      const name = document.getElementById("edit-user-name")?.value.trim();
      const role = document.getElementById("edit-user-role")?.value || "user";
      const disabled = document.getElementById("edit-user-disabled")?.checked || false;
      const password = document.getElementById("edit-user-password")?.value || undefined;

      if (!name) throw new Error("Name is required");

      const payload = { name, role, disabled };
      if (password) payload.password = password;

      await apiFetch(`/api/admin/users/${user.id}`, {
        method: "PATCH",
        body: payload,
      });

      showToast("User updated");
      await renderAdmin();
    },
  });
}

// ============================================================================
// Change Password Modal
// ============================================================================

function openChangePasswordModal() {
  const contentHtml = `
    <form id="form-change-pwd">
      <div class="form-group">
        <label class="form-label" for="pwd-current">Current Password *</label>
        <input class="input" type="password" id="pwd-current" required>
      </div>

      <div class="form-group">
        <label class="form-label" for="pwd-next">New Password *</label>
        <input class="input" type="password" id="pwd-next" required minlength="6">
        <div class="form-help">Must be at least 6 characters.</div>
      </div>

      <div class="form-group">
        <label class="form-label" for="pwd-confirm">Confirm New Password *</label>
        <input class="input" type="password" id="pwd-confirm" required minlength="6">
      </div>
    </form>
  `;

  showModal({
    title: "Change Password",
    contentHtml,
    confirmText: "Update Password",
    onConfirm: async () => {
      const current = document.getElementById("pwd-current")?.value;
      const next = document.getElementById("pwd-next")?.value;
      const confirm = document.getElementById("pwd-confirm")?.value;

      if (!current || !next) throw new Error("All fields are required");
      if (next !== confirm) throw new Error("New passwords do not match");

      await apiFetch("/api/me/password", {
        method: "POST",
        body: { current, next },
      });

      showToast("Password updated successfully");
    },
  });
}

// ============================================================================
// Initialization & Global Event Listeners
// ============================================================================

document.addEventListener("DOMContentLoaded", () => {
  // Login form handler
  const loginForm = document.getElementById("login-form");
  const loginError = document.getElementById("login-error");

  if (loginForm) {
    loginForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      loginError?.classList.add("hidden");

      const email = document.getElementById("login-email")?.value.trim();
      const password = document.getElementById("login-password")?.value;

      try {
        const res = await apiFetch("/api/auth/login", {
          method: "POST",
          body: { email, password },
        });

        state.currentUser = res.user;
        updateUserUI();
        navigate("#devices");
      } catch (err) {
        if (loginError) {
          loginError.textContent = err.message;
          loginError.classList.remove("hidden");
        }
      }
    });
  }

  // Logout button handler
  document.getElementById("btn-logout")?.addEventListener("click", async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch (e) {}
    state.currentUser = null;
    navigate("#login");
  });

  // Password change button
  document.getElementById("btn-change-password")?.addEventListener("click", openChangePasswordModal);

  // Global Esc key to close modals
  window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closeModal();
  });

  // Listen to hash changes
  window.addEventListener("hashchange", handleRouteChange);

  // Initial routing
  handleRouteChange();
});
