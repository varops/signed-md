// Small progressive enhancements for the admin UI.
(function () {
  document.querySelectorAll("[data-confirm]").forEach(function (el) {
    el.addEventListener("submit", function (e) { if (!window.confirm(el.getAttribute("data-confirm"))) e.preventDefault(); });
  });
  // Folder cards: rename in place. Enter saves through the form's own submit (safe with input
  // methods); Escape or Cancel puts the name back.
  document.querySelectorAll(".folder-card").forEach(function (card) {
    var form = card.querySelector(".folder-rename");
    var edit = card.querySelector("[data-rename]");
    if (!form || !edit) return;
    var input = form.querySelector('input[name="name"]');
    function cancel() { input.value = input.defaultValue; form.hidden = true; edit.focus(); }
    edit.addEventListener("click", function () { form.hidden = false; input.focus(); input.select(); });
    form.querySelector("[data-rename-cancel]").addEventListener("click", cancel);
    form.addEventListener("keydown", function (e) { if (e.key === "Escape") { e.preventDefault(); cancel(); } });
  });
  // Buttons with commandfor/command open and close dialogs natively. This covers browsers without it.
  if (!("commandForElement" in HTMLButtonElement.prototype)) {
    document.addEventListener("click", function (e) {
      var b = e.target.closest && e.target.closest("button[commandfor]");
      var d = b && document.getElementById(b.getAttribute("commandfor"));
      if (!d || !d.showModal) return;
      var cmd = b.getAttribute("command");
      if (cmd === "show-modal" && !d.open) d.showModal();
      else if (cmd === "close") d.close();
    });
  }
  // Light dismiss for browsers without <dialog closedby> (Safari): close on a press and release outside.
  if (!("closedBy" in HTMLDialogElement.prototype)) {
    document.querySelectorAll('dialog[closedby="any"]').forEach(function (dialog) {
      var outside = function (e) {
        var r = dialog.getBoundingClientRect();
        return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
      };
      var pressedOutside = false;
      dialog.addEventListener("pointerdown", function (e) { pressedOutside = outside(e); });
      dialog.addEventListener("pointerup", function (e) { if (pressedOutside && outside(e)) dialog.close(); });
    });
  }
  // Copy to the clipboard. The Clipboard API only exists on secure pages (HTTPS or localhost), so on
  // plain HTTP (a server on the local network) fall back to selecting a hidden textarea and copying.
  function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
    return new Promise(function (resolve, reject) {
      var area = document.createElement("textarea");
      area.value = text;
      area.setAttribute("readonly", "");
      area.style.cssText = "position:fixed;top:0;left:0;width:1px;height:1px;opacity:0";
      document.body.appendChild(area);
      area.select();
      area.setSelectionRange(0, text.length);
      var ok = false;
      try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
      area.remove();
      ok ? resolve() : reject(new Error("copy failed"));
    });
  }
  document.querySelectorAll("[data-copy]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.preventDefault();
      var flash = el.hasAttribute("data-copy-flash");
      copyText(el.getAttribute("data-copy")).then(function () {
        if (flash) { el.classList.add("copied"); setTimeout(function () { el.classList.remove("copied"); }, 1200); return; }
        var t = el.textContent; el.textContent = "Copied"; setTimeout(function () { el.textContent = t; }, 1200);
      }, function () {
        // Last resort: select the text so the person can press Cmd/Ctrl+C.
        var range = document.createRange(); range.selectNodeContents(el);
        var sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      });
    });
  });
  var add = document.getElementById("add-signer");
  if (add) add.addEventListener("click", function (e) {
    e.preventDefault();
    var list = document.getElementById("signers");
    var n = list.querySelectorAll(".signer-row").length;
    var row = list.querySelector(".signer-row").cloneNode(true);
    row.querySelectorAll("input").forEach(function (i) {
      i.name = i.name.replace(/signers\[\d+\]/, "signers[" + n + "]");
      i.id = i.id.replace(/signer-\d+-/, "signer-" + n + "-");
      if (i.type !== "number") i.value = ""; else i.value = "1";
      i.readOnly = false;
    });
    row.querySelectorAll("label[for]").forEach(function (l) { l.htmlFor = l.htmlFor.replace(/signer-\d+-/, "signer-" + n + "-"); });
    row.querySelector("legend").textContent = "Signer " + (n + 1);
    list.appendChild(row);
    row.querySelector("input:not([readonly])").focus();
  });
})();
// Avatars: drop the image if it fails, showing the initials underneath. Keep colour pickers in sync.
(function () {
  document.querySelectorAll('figure[data-variant="avatar"] img').forEach(function (img) {
    function drop() { img.remove(); }
    if (img.complete && img.naturalWidth === 0) drop(); else img.addEventListener("error", drop);
  });
  document.querySelectorAll("[data-sync]").forEach(function (picker) {
    var text = document.getElementById(picker.getAttribute("data-sync"));
    picker.addEventListener("input", function () { text.value = picker.value; });
    text.addEventListener("input", function () { if (/^#[0-9a-fA-F]{6}$/.test(text.value)) picker.value = text.value; });
  });
})();
// Markdown editors: OverType on top of the textarea, and a preview rendered on the server as you type.
(function () {
  // Highlight our own syntax. OverType hands over each line's HTML; we may only wrap text in tags,
  // never add or remove characters, or the highlighting drifts away from the text.
  function smdSyntax(html) {
    return html
      .replace(/\{\{([^<{}]*?)\}\}/g, function (m, inner) {
        return '<span class="smd-ot-field' + (inner.charAt(0) === "$" ? " smd-ot-value" : "") + '">' + m + "</span>";
      })
      .replace(/&lt;!--\s*\/?columns?\s*--&gt;/g, '<span class="smd-ot-columns">$&</span>');
  }
  // No colours: text in the page's foreground, Markdown markers muted. Follows light and dark mode.
  var fg = "var(--foreground)";
  var theme = {
    name: "signed-md",
    colors: {
      bgPrimary: "var(--background)", bgSecondary: "var(--background)", text: fg,
      h1: fg, h2: fg, h3: fg, strong: fg, em: fg, link: fg, code: fg, codeBg: "var(--muted)",
      blockquote: fg, hr: "var(--muted-foreground)", syntaxMarker: "var(--muted-foreground)",
      cursor: fg, selection: "color-mix(in srgb, var(--foreground) 18%, transparent)"
    }
  };

  function enhance(area) {
    if (!window.OverType) return area;
    var host = document.createElement("div");
    host.className = "ot-host";
    area.parentNode.insertBefore(host, area);
    var props = { name: area.name, id: area.id, spellcheck: "false", autocapitalize: "none", autocorrect: "off", "data-font": area.getAttribute("data-font") || "" };
    var editor = new window.OverType(host, {
      value: area.value, theme: theme, fontSize: "13.5px", lineHeight: 1.6, padding: area.getAttribute("data-ot-padding") || "14px",
      textareaProps: props, customSyntax: smdSyntax, toolbar: false
    })[0];
    area.remove();
    return editor.textarea;
  }

  document.querySelectorAll("[data-preview-source]").forEach(function (original) {
    var area = enhance(original);
    var target = area.closest(".editor, .editor-scope").querySelector("[data-preview-target]");
    var csrf = area.form && area.form.querySelector("input[name=_csrf]");
    if (!target || !csrf) return;
    var timer = null, seq = 0;
    function render() {
      var mine = ++seq;
      var body = new URLSearchParams({ _csrf: csrf.value, source: area.value, font: area.getAttribute("data-font") || "" });
      fetch("/preview", { method: "POST", body: body, credentials: "same-origin" })
        .then(function (r) { return r.ok ? r.text() : null; })
        .then(function (htmlText) {
          if (htmlText === null || mine !== seq) return;
          var top = target.scrollTop;
          target.innerHTML = htmlText;
          target.querySelectorAll("[data-paginate]").forEach(window.smdPaginate);
          target.scrollTop = top;
        })
        .catch(function () {});
    }
    area.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(render, 300); });
  });
})();

// A menu item that opens a dialog (such as New → Folder) closes its menu first.
document.addEventListener("click", (e) => {
  const item = e.target instanceof Element ? e.target.closest("[popover] [role='menuitem'][commandfor]") : null;
  item?.closest("[popover]")?.hidePopover();
});

// Previews as A4 pages: move each block onto the current page until it is full, then start a new
// page. A block taller than a page gets a page of its own. Runs again when the width or fonts change.
window.smdPaginate = function (box) {
  const pages = [...box.querySelectorAll(":scope > .doc.page")];
  if (!pages.length) return;
  const blocks = pages.flatMap((p) => [...p.querySelector(".page-body").children]);
  const shell = pages[0].cloneNode(false);
  box.classList.add("paged");
  box.replaceChildren();
  const fresh = () => {
    const page = shell.cloneNode(false);
    const body = document.createElement("div");
    body.className = "page-body";
    page.append(body);
    box.append(page);
    return body;
  };
  let body = fresh();
  for (const block of blocks) {
    body.append(block);
    if (body.scrollHeight > body.clientHeight + 1 && body.children.length > 1) {
      block.remove();
      // Keep a heading with the text after it.
      const last = body.lastElementChild;
      const carry = last && /^H[1-6]$/.test(last.tagName) && body.children.length > 1 ? last : null;
      body = fresh();
      if (carry) body.append(carry);
      body.append(block);
    }
  }
  const all = box.children;
  [...all].forEach((p, i) => {
    p.setAttribute("aria-label", `Page ${i + 1} of ${all.length}`);
    // The page number at the bottom right, as in the PDF's footer.
    const foot = document.createElement("div");
    foot.className = "page-number";
    foot.setAttribute("aria-hidden", "true");
    foot.textContent = `Page ${i + 1} of ${all.length}`;
    p.append(foot);
  });
};
(() => {
  const run = () => document.querySelectorAll("[data-paginate]").forEach(window.smdPaginate);
  run();
  document.fonts?.ready.then(run);
  let width = 0, timer;
  new ResizeObserver((entries) => {
    const w = Math.round(entries[0].contentRect.width);
    if (w === width) return;
    width = w;
    clearTimeout(timer);
    timer = setTimeout(run, 150);
  }).observe(document.body);
})();

// The sidebar collapses to an icon rail (the button next to the logo) and expands again (the icon).
// Remembered in a cookie so the server draws it right. In the rail, links show their name on hover.
document.querySelectorAll("[data-smd-sidebar-toggle]").forEach((button) => {
  button.addEventListener("click", () => {
    const app = button.closest(".app");
    const collapsed = !app.hasAttribute("data-collapsed");
    app.toggleAttribute("data-collapsed", collapsed);
    app.querySelectorAll("[data-smd-sidebar-toggle]").forEach((b) => b.setAttribute("aria-expanded", String(!collapsed)));
    app.querySelectorAll(".side-nav a").forEach((a) => (collapsed ? a.setAttribute("title", a.textContent.trim()) : a.removeAttribute("title")));
    document.cookie = `smd_sidebar=${collapsed ? "collapsed" : "open"}; path=/; max-age=31536000; samesite=lax`;
    app.querySelector(collapsed ? ".rail-logo" : ".sidebar-toggle")?.focus();
  });
});

// Zoom on the pages, from 50% to 200%. The level is a per-browser preference.
(() => {
  const read = () => { try { return Number(localStorage.getItem("smd-zoom")) || 1; } catch { return 1; } };
  const apply = (box, level) => {
    box.style.setProperty("--zoom", String(level));
    const out = box.querySelector(".zoom-controls output");
    if (out) out.textContent = `${Math.round(level * 100)}%`;
    box.querySelectorAll("[data-paginate]").forEach(window.smdPaginate);
  };
  document.querySelectorAll(".zoomable").forEach((box) => apply(box, read()));
  document.addEventListener("click", (e) => {
    const button = e.target instanceof Element ? e.target.closest(".zoom-controls [data-zoom]") : null;
    if (!button) return;
    const box = button.closest(".zoomable");
    const now = Number(box.style.getPropertyValue("--zoom")) || 1;
    const level = Math.min(2, Math.max(0.5, Math.round((now + Number(button.dataset.zoom) * 0.1) * 10) / 10));
    apply(box, level);
    try { localStorage.setItem("smd-zoom", String(level)); } catch {}
  });
})();

// Theme: apply the choice at once and save it in the background.
document.querySelectorAll("form[data-theme-form]").forEach((form) => {
  form.addEventListener("change", () => {
    const theme = new FormData(form).get("theme");
    document.querySelector('meta[name="color-scheme"]')?.setAttribute("content", theme === "system" ? "light dark" : String(theme));
    fetch(form.action, { method: "POST", body: new URLSearchParams(new FormData(form)), headers: { accept: "application/json" }, credentials: "same-origin" }).catch(() => {});
  });
});

// Import: choosing a file uploads it at once.
document.querySelectorAll("form[data-auto-import]").forEach((form) => {
  const input = form.querySelector('input[type="file"]');
  input?.addEventListener("change", () => {
    if (!input.files?.length) return;
    form.setAttribute("aria-busy", "true");
    const label = form.querySelector(".import-label");
    if (label) label.textContent = "Importing…";
    form.submit();
  });
});

// Full-width pages show messages floating at the top. Success messages ("Saved.") go away on their own.
document.querySelectorAll('.wrap.full > .note[data-variant="success"]').forEach((note) => {
  setTimeout(() => {
    note.style.transition = "opacity .3s";
    note.style.opacity = "0";
    setTimeout(() => note.remove(), 300);
  }, 3500);
});

// Signing order 0 means "any order" (everyone signs at once), for every signer or none. Choosing 0
// moves the others to 0; a mix of 0 and numbers can't be saved.
function checkSignerOrders(form) {
  const inputs = [...form.querySelectorAll("[data-signer-order]")];
  const mixed = inputs.some((i) => i.value === "0") && inputs.some((i) => i.value !== "0");
  inputs.forEach((i) => i.setCustomValidity(mixed && i.value !== "0" ? "Use 0 (any order) for every signer, or a number for every signer." : ""));
}
document.addEventListener("change", (e) => {
  const input = e.target instanceof HTMLInputElement && e.target.matches("[data-signer-order]") ? e.target : null;
  const form = input?.closest("form");
  if (!input || !form) return;
  if (input.value === "0") form.querySelectorAll("[data-signer-order]").forEach((other) => { other.value = "0"; });
  checkSignerOrders(form);
});
