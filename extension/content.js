/**
 * Browser LLM Broker - Content Script
 * Injected into chatgpt.com to automate prompt submission and image retrieval.
 */

(function () {
  // Prevent duplicate injection in the same frame
  if (window.__CHATGPT_MCP_CONTENT_INJECTED__) return;
  window.__CHATGPT_MCP_CONTENT_INJECTED__ = true;

  function log(...args) {
    console.log("[ChatGPT-MCP-CS]", ...args);
  }

  // Listen for messages from background script
  chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
    if (request.action === "ping") {
      sendResponse({ pong: true });
      return true;
    }

    if (request.action === "start_generation") {
      sendResponse({ acknowledged: true });
      handleImageGeneration(request.id, request.prompt, request.timeoutMs, !!request.existingChat, request.mode || "image");
      return true;
    }

    return false;
  });

  // -------------------------------------------------------------------------
  // Main Workflow
  // -------------------------------------------------------------------------

  async function handleImageGeneration(id, prompt, timeoutMs, existingChat, mode) {
    log(`Handling image generation [${id}]:`, prompt);

    let isFinished = false;
    let observer = null;

    const timeoutTimer = setTimeout(() => {
      if (isFinished) return;
      isFinished = true;
      if (observer) observer.disconnect();
      reportFailed(id, `Generation timed out in page after ${timeoutMs}ms`);
    }, timeoutMs);

    try {
      // 1. Check login state
      checkLoginStatus();

      // 2. Wait for prompt textarea / composer
      reportProgress(id, "Locating prompt composer...");
      const composer = await waitForComposer(20000);

      // Existing conversation: let history render, then remember how many turns/images
      // are already there so only the NEW reply is returned.
      if (existingChat) await sleep(2500);
      const baseline = takeBaseline();

      // 3. Fill prompt
      reportProgress(id, "Filling prompt...");
      await fillPrompt(composer, prompt);

      // Brief delay to allow React state to settle
      await sleep(400);

      // 4. Submit prompt
      reportProgress(id, "Submitting prompt...");
      await submitPrompt(composer);
      await confirmSent(id, composer, prompt, baseline);

      // 5. Wait for generation to start and finish
      reportProgress(id, "Waiting for image generation to complete...");
      const reply = await waitForReply(id, timeoutMs - 15000, baseline, mode);

      if (isFinished) return;
      isFinished = true;
      clearTimeout(timeoutTimer);

      log(`Reply: ${reply.images.length} image(s), ${reply.text.length} chars of text`);
      reportSuccess(id, reply.images, reply.text, reply.markdown);
    } catch (err) {
      if (isFinished) return;
      isFinished = true;
      clearTimeout(timeoutTimer);
      if (observer) observer.disconnect();

      log(`Error during generation [${id}]:`, err);
      reportFailed(id, err.message || "Failed to generate image in ChatGPT", err.code, err.resetsAt);
    }
  }

  // -------------------------------------------------------------------------
  // Login Check
  // -------------------------------------------------------------------------

  function checkLoginStatus() {
    const url = window.location.href;
    if (url.includes("/auth/login") || url.includes("/login")) {
      throw new Error("User is not logged in to ChatGPT (on login page)");
    }

    // Check for login / signup banner buttons when not logged in
    const loginButton = document.querySelector('button[data-testid="login-button"], a[href*="/login"]');
    const composer = getComposerElement();
    if (loginButton && !composer) {
      throw new Error("User is not logged in to ChatGPT. Please log in to your account first.");
    }
  }

  // -------------------------------------------------------------------------
  // Composer Selection & Input
  // -------------------------------------------------------------------------

  function getComposerElement() {
    const selectors = [
      "#prompt-textarea",
      "div#prompt-textarea",
      "div[contenteditable='true']#prompt-textarea",
      "textarea[data-id='root']",
      "textarea[placeholder*='Ask']",
      "textarea[placeholder*='Message']",
      "div[contenteditable='true'][data-placeholder]",
      "div[contenteditable='true']",
    ];

    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (el && isElementVisible(el)) {
        return el;
      }
    }
    return null;
  }

  async function waitForComposer(timeoutMs) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      checkLoginStatus();
      const el = getComposerElement();
      if (el) return el;
      await sleep(300);
    }
    throw new Error("Could not find ChatGPT input composer (#prompt-textarea)");
  }

  async function fillPrompt(el, text) {
    el.focus();

    if (el.tagName.toLowerCase() === "textarea") {
      el.value = text;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
    } else {
      // Contenteditable (React / ProseMirror / Lexical)
      document.execCommand("selectAll", false, null);
      const inserted = document.execCommand("insertText", false, text);

      if (!inserted || el.innerText.trim() === "") {
        el.textContent = text;
        el.dispatchEvent(
          new InputEvent("input", {
            bubbles: true,
            cancelable: true,
            inputType: "insertText",
            data: text,
          })
        );
      }
    }

    // Dispatch input & keyup events to update internal state
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new KeyboardEvent("keyup", { bubbles: true }));

    // Verify the editor really holds the prompt (it may not when the tab is in the background);
    // if not, simulate a paste, which ProseMirror handles reliably.
    const current = () => ((el.value ?? el.innerText) || "").trim();
    const probe = text.trim().slice(0, 20);
    if (!current().includes(probe)) {
      el.focus();
      document.execCommand("selectAll", false, null);
      const dt = new DataTransfer();
      dt.setData("text/plain", text);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
      await sleep(300);
    }
  }

  // -------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------

  function getSendButton() {
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label*="Send"]',
      'button[data-testid="fruitjuice-send-button"]',
    ];

    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && isElementVisible(btn)) {
        return btn;
      }
    }
    // Fallback: a send-like / submit button inside the composer's form.
    const form = (getComposerElement() || document.body).closest("form");
    if (form) {
      for (const b of form.querySelectorAll("button")) {
        const label = `${b.getAttribute("aria-label") || ""} ${b.getAttribute("data-testid") || ""}`;
        if (/send|submit/i.test(label) && !/stop|voice|dictat/i.test(label) && isElementVisible(b)) return b;
      }
      const sub = form.querySelector('button[type="submit"]');
      if (sub && isElementVisible(sub) && !/stop|voice/i.test(sub.getAttribute("aria-label") || "")) return sub;
    }
    return null;
  }

  function composerDiag(composer) {
    const form = composer.closest("form");
    const buttons = form
      ? [...form.querySelectorAll("button")].map((b) => `${b.getAttribute("aria-label") || b.getAttribute("data-testid") || b.textContent.trim().slice(0, 15) || "?"}${b.disabled ? "(disabled)" : ""}`)
      : ["no-form"];
    const text = ((composer.value ?? composer.innerText) || "").trim();
    return JSON.stringify({ composerLen: text.length, composerStart: text.slice(0, 30), buttons, sendFound: !!getSendButton() });
  }

  async function submitPrompt(composer) {
    // Wait up to 3s for send button to become enabled
    const start = Date.now();
    let sendBtn = null;

    while (Date.now() - start < 3000) {
      sendBtn = getSendButton();
      if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute("aria-disabled") !== "true") {
        break;
      }
      await sleep(150);
    }

    if (sendBtn && !sendBtn.disabled && sendBtn.getAttribute("aria-disabled") !== "true") {
      log("Clicking send button");
      sendBtn.click();
      return;
    }

    // Fallbacks: submit the form, then an Enter keypress on the composer
    log("Send button disabled or not found; trying form submit / Enter");
    composer.focus();
    try { composer.closest("form")?.requestSubmit(); } catch (e) {}
    composer.dispatchEvent(
      new KeyboardEvent("keydown", {
        key: "Enter",
        code: "Enter",
        keyCode: 13,
        which: 13,
        bubbles: true,
        cancelable: true,
      })
    );
  }

  // After submitting, make sure ChatGPT really received the message (a new "You said:" turn or a running
  // reply). If the prompt is still sitting in the composer, fill and submit again; give up with a clear error.
  async function confirmSent(id, composer, prompt, baseline) {
    const composerText = () => ((composer.value ?? composer.innerText) || "").trim();
    for (let attempt = 1; attempt <= 3; attempt++) {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        if (userLabels().length > baseline.users || isStopButtonVisible()) return;
        await sleep(500);
      }
      if (!composerText()) continue; // composer was cleared: the send is probably just slow, keep waiting
      reportProgress(id, `Prompt not sent yet (attempt ${attempt}); retrying. Tab visible: ${document.visibilityState}, focused: ${document.hasFocus()} ${composerDiag(composer)}`);
      composer.focus();
      await fillPrompt(composer, prompt);
      await sleep(400);
      await submitPrompt(composer);
    }
    if (userLabels().length > baseline.users || isStopButtonVisible()) return;
    const notSent = new Error(
      `Prompt was not sent to ChatGPT (tab visible: ${document.visibilityState}, focused: ${document.hasFocus()}). Keep a Chrome window open and not minimized. ${composerDiag(composer)}`
    );
    notSent.code = "prompt_not_sent";
    throw notSent;
  }

  // -------------------------------------------------------------------------
  // Generation & Image Observation
  // -------------------------------------------------------------------------

  function isStopButtonVisible() {
    const selectors = [
      'button[data-testid="stop-button"]',
      'button[aria-label="Stop streaming"]',
      'button[aria-label*="Stop"]',
    ];
    for (const sel of selectors) {
      const btn = document.querySelector(sel);
      if (btn && isElementVisible(btn)) return true;
    }
    return false;
  }

  function checkForPageErrors() {
    // Look for error alerts or banners inside chat
    const errorSelectors = [
      '[data-testid="conversation-turn-error"]',
      'div[class*="text-red"]',
      'div[class*="error-message"]',
    ];

    for (const sel of errorSelectors) {
      const el = document.querySelector(sel);
      if (el && isElementVisible(el)) {
        const text = el.innerText.trim();
        if (
          text.includes("Something went wrong") ||
          text.includes("rate limit") ||
          text.includes("capacity") ||
          text.includes("content policy")
        ) {
          return text;
        }
      }
    }
    return null;
  }

  /**
   * Find candidate generated images in the assistant messages.
   */
  // The current ChatGPT UI has no data-testid / data-message-author-role attributes; each turn is
  // introduced by an (invisible) "You said:" / "ChatGPT said:" label, so we locate turns by those labels.
  const ASSISTANT_LABEL = /^(ChatGPT said|ChatGPT đã nói)\s*:?$/i;
  const USER_LABEL = /^(You said|Bạn đã nói)\s*:?$/i;

  function assistantLabels() {
    const root = document.querySelector("main") || document.body;
    return [...root.querySelectorAll("*")].filter((e) => e.children.length === 0 && ASSISTANT_LABEL.test((e.textContent || "").trim()));
  }

  function userLabels() {
    const root = document.querySelector("main") || document.body;
    return [...root.querySelectorAll("*")].filter((e) => e.children.length === 0 && USER_LABEL.test((e.textContent || "").trim()));
  }

  function takeBaseline() {
    const assistants = assistantLabels().length;
    const users = userLabels().length;
    const srcs = new Set([...document.querySelectorAll("img")].map((i) => i.src).filter(Boolean));
    log(`Baseline: ${assistants} assistant turns, ${srcs.size} images`);
    return { assistants, users, srcs };
  }

  function findGeneratedImages(baseline) {
    if (baseline) {
      // Only images located after the first NEW "ChatGPT said:" label.
      const first = assistantLabels()[baseline.assistants];
      if (!first) return [];
      const root = document.querySelector("main") || document.body;
      const out = [];
      const seen = new Set();
      for (const img of root.querySelectorAll("img")) {
        const src = img.src || img.currentSrc;
        if (!src || seen.has(src) || baseline.srcs.has(src) || img.closest("form") || !isChatGPTHosted(img)) continue;
        if (!(first.compareDocumentPosition(img) & Node.DOCUMENT_POSITION_FOLLOWING) || isAvatarOrIcon(img)) continue;
        if (img.naturalWidth > 100 || img.width > 100 || isDalleImage(img)) {
          seen.add(src);
          out.push(img);
        }
      }
      return out;
    }

    // Collect images inside assistant turns / markdown responses
    const assistantSelectors = [
      'article[data-testid^="conversation-turn"]',
      'div[data-message-author-role="assistant"]',
      'div.markdown',
    ];

    const foundImages = [];
    const seenSrcs = new Set();

    for (const containerSel of assistantSelectors) {
      const containers = document.querySelectorAll(containerSel);
      // Examine the latest assistant containers first
      for (let i = containers.length - 1; i >= 0; i--) {
        const imgs = containers[i].querySelectorAll("img");
        for (const img of imgs) {
          const src = img.src || img.currentSrc;
          if (!src || seenSrcs.has(src)) continue;

          // Exclude user avatars or UI icons
          if (isAvatarOrIcon(img)) continue;

          // Check if image is loaded and reasonably sized
          if (img.naturalWidth > 100 || img.width > 100 || isDalleImage(img)) {
            seenSrcs.add(src);
            foundImages.push(img);
          }
        }
      }
    }

    // Fallback: check any <img> in the main page with oaiusercontent or dalle characteristics
    if (foundImages.length === 0) {
      const allImgs = document.querySelectorAll("main img, img");
      for (const img of allImgs) {
        const src = img.src || img.currentSrc;
        if (!src || seenSrcs.has(src)) continue;
        if (isAvatarOrIcon(img)) continue;

        if (isDalleImage(img) && (img.naturalWidth > 100 || img.width > 100)) {
          seenSrcs.add(src);
          foundImages.push(img);
        }
      }
    }

    return foundImages;
  }

  // Images ChatGPT generated live on chatgpt.com (estuary/backend-api) or *.oaiusercontent.com, or are blob:/data:.
  // Third-party pictures embedded in answers (web search thumbnails, etc.) are not "generated images".
  function isChatGPTHosted(img) {
    const src = img.src || img.currentSrc || "";
    if (src.startsWith("blob:") || src.startsWith("data:image/")) return true;
    try {
      const u = new URL(src, location.href);
      // images.openai.com/static-rsc/... are thumbnails of web results shown inside answers, not generated images.
      if (u.pathname.startsWith("/static-rsc")) return false;
      return u.hostname === location.hostname || /(^|\.)(chatgpt\.com|openai\.com|oaiusercontent\.com)$/.test(u.hostname);
    } catch (e) {
      return false;
    }
  }

  function isAvatarOrIcon(img) {
    const alt = (img.alt || "").toLowerCase();
    if (alt.includes("user") || alt.includes("avatar") || alt.includes("profile")) {
      return true;
    }
    // Avatars are typically small squares (e.g. 24x24, 28x28, 32x32)
    const w = img.naturalWidth || img.width || 0;
    const h = img.naturalHeight || img.height || 0;
    if (w > 0 && w <= 48 && h > 0 && h <= 48) {
      return true;
    }
    return false;
  }

  function isDalleImage(img) {
    const src = (img.src || "").toLowerCase();
    const alt = (img.alt || "").toLowerCase();
    return (
      src.includes("files.oaiusercontent.com") ||
      src.includes("dalle") ||
      src.startsWith("blob:") ||
      src.startsWith("data:image/") ||
      alt.includes("generated") ||
      alt.includes("dall")
    );
  }

  function getNewAssistantText(baseline) {
    const root = document.querySelector("main") || document.body;
    // Read the text with UI buttons (follow-up suggestion chips, "Edit", "Copy code"...) hidden.
    // The style is added and removed synchronously, so nothing is ever painted with it applied.
    const hide = document.createElement("style");
    hide.textContent = 'main button:not(form button), main [role="button"]:not(form [role="button"]) { display: none !important; }';
    document.head.appendChild(hide);
    let raw = "";
    try { raw = root.innerText || ""; } finally { hide.remove(); }
    const lines = raw.split("\n");
    const segs = [];
    let cur = null;
    for (const line of lines) {
      const t = line.trim();
      if (ASSISTANT_LABEL.test(t)) { cur = { role: "a", text: [] }; segs.push(cur); }
      else if (USER_LABEL.test(t)) { cur = { role: "u", text: [] }; segs.push(cur); }
      else if (cur) cur.text.push(line);
    }
    const parts = segs
      .filter((s) => s.role === "a")
      .slice(baseline.assistants)
      .map((s) => s.text.join("\n").split(/(?:^|\n)(?:ChatGPT can make mistakes|Latest response|Files, images, and data analysis are unavailable)/)[0].replace(/(^|\n)Edit(?=\n|$)/g, "$1").trim())
      .filter(Boolean);
    return parts.join("\n\n");
  }

  // ---- HTML -> Markdown (best effort) for the assistant's rendered reply ----
  function htmlToMarkdown(root) {
    const SKIP = new Set(["BUTTON", "SVG", "STYLE", "SCRIPT", "IMG", "NOSCRIPT"]);
    const inline = (node) => [...node.childNodes].map(walk).join("");
    const indent = (s, pad) => s.split("\n").map((l) => (l ? pad + l : l)).join("\n");

    function list(el, ordered) {
      let n = 1;
      const items = [];
      for (const li of el.children) {
        if (li.tagName !== "LI") continue;
        const parts = [];
        const nested = [];
        for (const ch of li.childNodes) {
          if (ch.nodeType === 1 && (ch.tagName === "UL" || ch.tagName === "OL")) nested.push(list(ch, ch.tagName === "OL"));
          else parts.push(walk(ch));
        }
        const bullet = ordered ? `${n++}. ` : "- ";
        let text = parts.join("").trim().replace(/\n{2,}/g, "\n");
        text = indent(text, " ".repeat(bullet.length)).trimStart();
        let out = bullet + text;
        for (const nl of nested) out += "\n" + indent(nl.trim(), "  ");
        items.push(out);
      }
      return items.join("\n") + "\n\n";
    }

    function table(el) {
      const rows = [...el.querySelectorAll("tr")].map((tr) => [...tr.children].map((c) => inline(c).trim().replace(/\|/g, "\\|").replace(/\n+/g, " ")));
      if (!rows.length) return "";
      const w = Math.max(...rows.map((r) => r.length));
      const fmt = (r) => "| " + Array.from({ length: w }, (_, i) => r[i] ?? "").join(" | ") + " |";
      return [fmt(rows[0]), "| " + Array(w).fill("---").join(" | ") + " |", ...rows.slice(1).map(fmt)].join("\n") + "\n\n";
    }

    function walk(node) {
      if (node.nodeType === 3) return node.textContent.replace(/\s+/g, " ");
      if (node.nodeType !== 1 || SKIP.has(node.tagName.toUpperCase())) return "";
      const tag = node.tagName.toLowerCase();
      const cls = node.classList;
      // Current ChatGPT UI: <span data-math-source="TeX" [data-math-display="true"]>…rendered KaTeX…</span>
      const src = node.getAttribute && node.getAttribute("data-math-source");
      if (src) {
        return node.getAttribute("data-math-display") === "true" ? `\n\n$$\n${src.trim()}\n$$\n\n` : `$${src.trim()}$`;
      }
      if (node.getAttribute && node.getAttribute("data-markdown-copy") === "inline-code") return "`" + node.textContent + "`";
      if (cls && (cls.contains("katex-display") || cls.contains("katex") || cls.contains("math-display") || cls.contains("math-inline"))) {
        const ann = node.querySelector('annotation[encoding="application/x-tex"]');
        const tex = ann ? ann.textContent.trim() : "";
        if (tex) {
          const display = cls.contains("katex-display") || cls.contains("math-display") || !!node.closest(".katex-display");
          return display ? `\n\n$$\n${tex}\n$$\n\n` : `$${tex}$`;
        }
        if (cls.contains("katex-display") || cls.contains("katex")) return inline(node.querySelector(".katex-mathml") || node);
      }
      switch (tag) {
        case "h1": case "h2": case "h3": case "h4": case "h5": case "h6":
          return "#".repeat(Number(tag[1])) + " " + inline(node).trim() + "\n\n";
        case "p": return inline(node).trim() + "\n\n";
        case "br": return "\n";
        case "hr": return "---\n\n";
        case "strong": case "b": { const t = inline(node).trim(); return t ? `**${t}**` : ""; }
        case "em": case "i": { const t = inline(node).trim(); return t ? `*${t}*` : ""; }
        case "del": case "s": return `~~${inline(node).trim()}~~`;
        case "code": return "`" + node.textContent + "`";
        case "pre": {
          const code = node.querySelector("code");
          const lang = ((code && /language-([\w+-]+)/.exec(code.className)) || [])[1] || "";
          return "```" + lang + "\n" + (code ? code.textContent : node.textContent).replace(/\n$/, "") + "\n```\n\n";
        }
        case "a": {
          const t = inline(node).trim();
          const href = node.getAttribute("href") || "";
          return /^https?:/i.test(href) && t ? `[${t}](${href})` : t;
        }
        case "ul": return list(node, false);
        case "ol": return list(node, true);
        case "blockquote": return indent(inline(node).trim(), "> ").replace(/^ /, "") + "\n\n";
        case "table": return table(node);
        default: return inline(node);
      }
    }
    return walk(root).replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function getNewAssistantMarkdown(baseline) {
    const first = assistantLabels()[baseline.assistants];
    if (!first) return "";
    const root = document.querySelector("main") || document.body;
    const after = (el) => !el.closest("form") && first.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING;
    let blocks = [...root.querySelectorAll('[data-markdown-text-style="assistant-message"]')].filter(after);
    if (!blocks.length) blocks = [...root.querySelectorAll(".markdown")].filter(after);
    // Keep the outermost blocks only.
    const top = blocks.filter((el) => !blocks.some((o) => o !== el && o.contains(el)));
    return top.map(htmlToMarkdown).filter(Boolean).join("\n\n");
  }

  function diagnostics(baseline) {
    return JSON.stringify({
      url: location.pathname,
      assistantLabels: assistantLabels().length,
      stopVisible: isStopButtonVisible(),
      baseline: baseline && { assistants: baseline.assistants },
      mainTail: ((document.querySelector("main") || document.body).innerText || "").slice(-150),
    });
  }

  /**
   * mode: "image" (wait for an image), "text" (text reply only), "auto" (image if any, else text).
   * Returns { images, text }.
   */
  async function waitForReply(id, maxWaitMs, baseline, mode) {
    const startTime = Date.now();
    let hasStarted = false;
    let stopGone = 0;
    let lastText = "";
    let unchanged = 0;
    let tickNo = 0;
    let skipImages = false;

    while (Date.now() - startTime < maxWaitMs) {
      const errMsg = checkForPageErrors();
      if (errMsg) throw new Error(`ChatGPT reported an error: ${errMsg}`);

      const stopVisible = isStopButtonVisible();
      if (stopVisible) {
        hasStarted = true;
        stopGone = 0;
        reportProgress(id, "ChatGPT is replying...");
      } else if (hasStarted) {
        stopGone++;
      }

      const text = getNewAssistantText(baseline);
      unchanged = text && text === lastText ? unchanged + 1 : 0;
      lastText = text;

      // Reply considered finished: stop button was seen and has been gone for 3s,
      // or (never saw it) text has been stable for 5s.
      const finished = hasStarted ? stopGone >= 3 : unchanged >= 5 && Date.now() - startTime > 20000;

      const imageEls = mode === "text" || skipImages ? [] : findGeneratedImages(baseline);
      const imagesReady =
        imageEls.length > 0 && imageEls.every((img) => img.complete && (img.naturalWidth > 0 || img.width > 0));

      if (imagesReady && (hasStarted ? stopGone >= 3 : !stopVisible)) {
        log(`Detected ${imageEls.length} complete generated image(s)`);
        const images = await extractBase64Images(imageEls);
        if (images.length || mode === "image") {
          if (!images.length) throw new Error("Found image elements but failed to extract image data");
          return { images, text, markdown: getNewAssistantMarkdown(baseline) };
        }
        // auto mode: the pictures could not be read (e.g. blocked) - fall back to the text reply.
        skipImages = true;
      }

      // Text mode: normally wait until the stop button was seen and has gone. If it was never seen
      // (very fast reply), accept stable text only after 20s so we don't grab placeholder/banner text.
      if (mode === "text" && text) {
        if (hasStarted ? stopGone >= 3 : unchanged >= 5 && Date.now() - startTime > 20000) return { images: [], text, markdown: getNewAssistantMarkdown(baseline) };
        if (unchanged >= 45) return { images: [], text, markdown: getNewAssistantMarkdown(baseline) };
      }

      if (mode !== "text" && /unavailable until usage resets|usage limit|reached the limit/i.test(text)) {
        const e = new Error(`ChatGPT usage limit reached: ${text.slice(0, 300)}`);
        e.code = "usage_limit";
        e.resetsAt = parseResetTime(text);
        throw e;
      }

      if (finished && imageEls.length === 0) {
        if (mode === "text" && text) return { images: [], text, markdown: getNewAssistantMarkdown(baseline) };
        // auto: allow a grace period for a late-rendering image before settling for text
        if (mode === "auto" && text && (hasStarted ? stopGone >= 8 : unchanged >= 8)) return { images: [], text, markdown: getNewAssistantMarkdown(baseline) };
        if (mode === "image" && (hasStarted ? stopGone >= 15 : unchanged >= 15)) {
          throw new Error(`ChatGPT finished without producing an image. Reply: ${text.slice(0, 500)}`);
        }
      }

      if (++tickNo % 5 === 0) {
        reportProgress(id, `diag ${diagnostics(baseline)} textLen=${text.length} unchanged=${unchanged} hasStarted=${hasStarted} stopGone=${stopGone}`);
      }
      await sleep(1000);
    }

    throw new Error(`Timed out waiting for ChatGPT reply after ${Math.round(maxWaitMs / 1000)}s. Page state: ${diagnostics(baseline)}. Text so far: ${lastText.slice(0, 200)}`);
  }

  // -------------------------------------------------------------------------
  // Image Extraction (Fetch + Canvas fallback)
  // -------------------------------------------------------------------------

  async function extractBase64Images(imgEls) {
    const results = [];

    for (const img of imgEls) {
      try {
        const item = await extractSingleImage(img);
        if (item && item.base64) {
          results.push(item);
        }
      } catch (err) {
        log("Failed to extract image via primary method, attempting canvas fallback:", err);
        try {
          const fallbackItem = extractViaCanvas(img);
          if (fallbackItem && fallbackItem.base64) {
            results.push(fallbackItem);
          }
        } catch (canvasErr) {
          log("Canvas fallback also failed:", canvasErr);
        }
      }
    }

    return results;
  }

  async function extractSingleImage(img) {
    const src = img.src || img.currentSrc;
    if (!src) throw new Error("Image has no src");

    // If it's already a data URL
    if (src.startsWith("data:image/")) {
      const parts = src.split(",");
      const mimeMatch = parts[0].match(/data:(image\/[^;]+);base64/);
      const mime = mimeMatch ? mimeMatch[1] : "image/png";
      return { mime, base64: parts[1] };
    }

    // In-page fetch with credentials (gets raw binary stream)
    try {
      const resp = await fetch(src, { credentials: "include" });
      if (!resp.ok) {
        throw new Error(`Fetch failed with status ${resp.status}`);
      }
      const blob = await resp.blob();
      return { mime: blob.type || "image/png", base64: await blobToBase64(blob) };
    } catch (err) {
      // Cross-origin (e.g. oaiusercontent): content scripts obey page CORS, so retry from background.
      const r = await chrome.runtime.sendMessage({ action: "fetch_image", url: src });
      if (!r || !r.base64) throw new Error((r && r.error) || err.message);
      return { mime: r.mime, base64: r.base64 };
    }
  }

  function extractViaCanvas(img) {
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || img.width || 1024;
    canvas.height = img.naturalHeight || img.height || 1024;

    const ctx = canvas.getContext("2d");
    ctx.drawImage(img, 0, 0);

    const dataUrl = canvas.toDataURL("image/png");
    const commaIdx = dataUrl.indexOf(",");
    const base64 = commaIdx !== -1 ? dataUrl.slice(commaIdx + 1) : dataUrl;

    return { mime: "image/png", base64 };
  }

  function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onloadend = () => {
        const res = reader.result;
        if (typeof res === "string") {
          const commaIdx = res.indexOf(",");
          resolve(commaIdx !== -1 ? res.slice(commaIdx + 1) : res);
        } else {
          reject(new Error("FileReader result is not a string"));
        }
      };
      reader.onerror = reject;
      reader.readAsDataURL(blob);
    });
  }

  // -------------------------------------------------------------------------
  // Helpers & Messaging
  // -------------------------------------------------------------------------

  function reportProgress(id, message) {
    log(`Progress [${id}]:`, message);
    try {
      chrome.runtime.sendMessage({
        action: "generation_progress",
        id,
        message,
      });
    } catch (e) {}
  }

  function chatUrlNow() {
    return /^https:\/\/(chatgpt\.com|chat\.openai\.com)\/c\/[\w-]+/.test(location.href) ? location.href.split(/[?#]/)[0] : null;
  }

  function reportSuccess(id, images, text, markdown) {
    try {
      chrome.runtime.sendMessage({
        action: "generation_success",
        id,
        images,
        text,
        markdown,
        conversationUrl: chatUrlNow(),
      });
    } catch (e) {}
  }

  // "... until usage resets at 8:48 PM" -> next occurrence of that local time as ISO string.
  function parseResetTime(text) {
    const m = /resets? (?:at )?(\d{1,2}):(\d{2})\s*(AM|PM)?/i.exec(text);
    if (!m) return null;
    let h = Number(m[1]);
    const ap = (m[3] || "").toUpperCase();
    if (ap === "PM" && h < 12) h += 12;
    if (ap === "AM" && h === 12) h = 0;
    const d = new Date();
    d.setHours(h, Number(m[2]), 0, 0);
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }

  function reportFailed(id, error, code, resetsAt) {
    try {
      chrome.runtime.sendMessage({
        action: "generation_failed",
        id,
        error,
        code,
        resetsAt,
      });
    } catch (e) {}
  }

  function isElementVisible(el) {
    if (!el) return false;
    const style = window.getComputedStyle(el);
    return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
  }

  function sleep(ms) {
    return new Promise((r) => setTimeout(r, ms));
  }

  log("Browser LLM Broker content script initialized");
})();
