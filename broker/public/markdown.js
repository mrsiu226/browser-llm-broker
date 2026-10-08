// Small, dependency-free Markdown renderer. Everything is HTML-escaped first; only a fixed set of tags is produced.
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

function inline(text) {
  const codes = [];
  let s = text.replace(/`([^`\n]+)`/g, (_, c) => { codes.push(`<code>${esc(c)}</code>`); return `\u0000${codes.length - 1}\u0000`; });
  // Inline math: $...$ and \(...\) (not "$5 and $10": no space inside the dollars, no digit right after the closing one)
  s = s.replace(/\\\(([^]*?)\\\)/g, (_, t) => { codes.push(`<span class="math" data-tex="${esc(t.trim())}"></span>`); return `\u0000${codes.length - 1}\u0000`; })
    .replace(/\$(?=\S)([^$\n]*?\S)\$(?!\d)/g, (_, t) => { codes.push(`<span class="math" data-tex="${esc(t)}"></span>`); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s
    .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (_, t, u) => `<a href="${u}" target="_blank" rel="noopener noreferrer">${t}</a>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>")
    .replace(/~~([^~\n]+)~~/g, "<del>$1</del>");
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => codes[Number(i)]);
}

function renderList(lines, start, baseIndent) {
  const firstMarker = /^(\s*)([-*+]|\d+\.)\s+/.exec(lines[start]);
  const ordered = /\d/.test(firstMarker[2]);
  const tag = ordered ? "ol" : "ul";
  const startNo = ordered ? parseInt(firstMarker[2], 10) : 1;
  let html = `<${tag}${ordered && startNo !== 1 ? ` start="${startNo}"` : ""}>`;
  let i = start;
  while (i < lines.length) {
    const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i]);
    if (!m) {
      // Indented continuation of the previous item (extra text or a $$ math block).
      const c = /^(\s+)(\S.*)$/.exec(lines[i]);
      if (c && c[1].length > baseIndent && html.endsWith("</li>")) {
        let extra;
        if (/^(\$\$|\\\[)/.test(c[2])) {
          const close = c[2].startsWith("$$") ? "$$" : "\\]";
          let rest = c[2].slice(close === "$$" ? 2 : 2);
          const buf = [];
          while (true) {
            const k = rest.indexOf(close);
            if (k >= 0) { buf.push(rest.slice(0, k)); break; }
            buf.push(rest);
            i++;
            if (i >= lines.length) break;
            rest = lines[i].trim();
          }
          extra = `<div class="math" data-display="1" data-tex="${esc(buf.join("\n").trim())}"></div>`;
        } else {
          extra = `<br>${inline(c[2])}`;
        }
        html = html.replace(/<\/li>$/, "") + extra + "</li>";
        i++;
        continue;
      }
      // A blank line does not end the list if the next non-blank line is a sibling item.
      if (!lines[i].trim()) {
        let j = i + 1;
        while (j < lines.length && !lines[j].trim()) j++;
        const nx = j < lines.length ? /^(\s*)([-*+]|\d+\.)\s+/.exec(lines[j]) : null;
        if (nx && nx[1].length === baseIndent && /\d/.test(nx[2]) === ordered) { i = j; continue; }
      }
      break;
    }
    const indent = m[1].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      const sub = renderList(lines, i, indent);
      html = html.replace(/<\/li>$/, "") + sub.html + "</li>";
      i = sub.next;
      continue;
    }
    html += `<li>${inline(m[3])}</li>`;
    i++;
  }
  return { html: html + `</${tag}>`, next: i };
}

export function renderMarkdown(src) {
  const lines = String(src ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }

    // Display math: $$ ... $$ (one or many lines) or \[ ... \]
    const dm = /^\s*(\$\$|\\\[)(.*)$/.exec(line);
    if (dm) {
      const close = dm[1] === "$$" ? "$$" : "\\]";
      let rest = dm[2];
      const buf = [];
      let done = false;
      while (true) {
        const k = rest.indexOf(close);
        if (k >= 0) { buf.push(rest.slice(0, k)); done = true; break; }
        buf.push(rest);
        i++;
        if (i >= lines.length) break;
        rest = lines[i];
      }
      i++;
      out.push(`<div class="math" data-display="1" data-tex="${esc(buf.join("\n").trim())}"></div>`);
      continue;
    }

    const fence = /^```(\w*)\s*$/.exec(line);
    if (fence) {
      const code = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push(`<pre class="md-code"><code>${esc(code.join("\n"))}</code></pre>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push(`<h${h[1].length + 1} class="md-h">${inline(h[2])}</h${h[1].length + 1}>`); i++; continue; }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { out.push("<hr>"); i++; continue; }
    if (/^\s*([-*+]|\d+\.)\s+/.test(line)) {
      const r = renderList(lines, i, /^(\s*)/.exec(line)[1].length);
      out.push(r.html);
      i = r.next;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<blockquote>${inline(q.join(" "))}</blockquote>`);
      continue;
    }
    if (/^\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /^\|.*\|\s*$/.test(lines[i])) rows.push(cells(lines[i++]));
      out.push(
        `<div class="md-table-wrap"><table class="md-table"><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>` +
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("") + "</tbody></table></div>",
      );
      continue;
    }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^(```|#{1,6}\s|>\s?|\s*([-*+]|\d+\.)\s+|-{3,}\s*$)/.test(lines[i])) para.push(lines[i++]);
    out.push(`<p>${inline(para.join("\n")).replace(/\n/g, "<br>")}</p>`);
  }
  return out.join("\n");
}

/** Renders <.math> placeholders produced by renderMarkdown with KaTeX (if it loaded). */
export function typesetMath(container) {
  if (typeof window === "undefined" || !window.katex) return;
  for (const el of container.querySelectorAll(".math[data-tex]")) {
    try {
      window.katex.render(el.dataset.tex, el, { displayMode: el.dataset.display === "1", throwOnError: false });
    } catch (e) {
      el.textContent = el.dataset.tex;
    }
  }
}
