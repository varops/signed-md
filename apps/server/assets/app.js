// Small progressive enhancements for the admin UI.
(function () {
  document.querySelectorAll("[data-confirm]").forEach(function (el) {
    el.addEventListener("submit", function (e) { if (!window.confirm(el.getAttribute("data-confirm"))) e.preventDefault(); });
  });
  document.querySelectorAll("[data-copy]").forEach(function (el) {
    el.addEventListener("click", function (e) {
      e.preventDefault();
      navigator.clipboard.writeText(el.getAttribute("data-copy")).then(function () {
        var t = el.textContent; el.textContent = "Copied"; setTimeout(function () { el.textContent = t; }, 1200);
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
      if (i.type !== "number") i.value = ""; else i.value = "1";
      i.readOnly = false;
    });
    list.appendChild(row);
  });
})();
// Avatars: drop the image if it fails, showing the initials underneath. Keep colour pickers in sync.
(function () {
  document.querySelectorAll(".avatar img").forEach(function (img) {
    function drop() { img.remove(); }
    if (img.complete && img.naturalWidth === 0) drop(); else img.addEventListener("error", drop);
  });
  document.querySelectorAll("[data-sync]").forEach(function (picker) {
    var text = document.getElementById(picker.getAttribute("data-sync"));
    picker.addEventListener("input", function () { text.value = picker.value; });
    text.addEventListener("input", function () { if (/^#[0-9a-fA-F]{6}$/.test(text.value)) picker.value = text.value; });
  });
})();
// Role selects on the Team page save on change.
(function () {
  document.querySelectorAll("select[data-autosubmit]").forEach(function (sel) {
    sel.addEventListener("change", function () { sel.form.submit(); });
  });
})();
// Markdown editors: re-render the preview on the server as you type.
(function () {
  document.querySelectorAll("[data-preview-source]").forEach(function (area) {
    var target = area.closest(".editor").querySelector("[data-preview-target]");
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
          target.scrollTop = top;
        })
        .catch(function () {});
    }
    area.addEventListener("input", function () { clearTimeout(timer); timer = setTimeout(render, 300); });
  });
})();
// Hosted account menu: close on a click outside it, or on Escape.
(function () {
  var menu = document.querySelector(".account-menu");
  if (!menu) return;
  document.addEventListener("click", function (e) { if (menu.open && !menu.contains(e.target)) menu.open = false; });
  document.addEventListener("keydown", function (e) { if (e.key === "Escape" && menu.open) { menu.open = false; menu.querySelector("summary").focus(); } });
})();
