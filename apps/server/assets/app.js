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
