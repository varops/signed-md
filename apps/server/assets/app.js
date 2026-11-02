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
