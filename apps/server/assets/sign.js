// Signing page: drawn or typed signatures. Without JavaScript, typed signatures still work.
(function () {
  document.querySelectorAll("[data-sig]").forEach(function (box) {
    var key = box.getAttribute("data-sig");
    var kind = box.querySelector('input[name="f:' + key + ':kind"]');
    var image = box.querySelector('input[name="f:' + key + ':image"]');
    var text = box.querySelector('input[name="f:' + key + ':text"]');
    var canvas = box.querySelector("canvas");
    var drawPane = box.querySelector("[data-pane=draw]");
    var typePane = box.querySelector("[data-pane=type]");
    var preview = box.querySelector(".typed-preview");
    var tabs = box.querySelectorAll(".tabs button");
    var pad = null;

    function resize() {
      if (!pad) return;
      var data = pad.toData();
      var ratio = Math.max(window.devicePixelRatio || 1, 1);
      canvas.width = canvas.offsetWidth * ratio;
      canvas.height = canvas.offsetHeight * ratio;
      canvas.getContext("2d").scale(ratio, ratio);
      pad.clear();
      pad.fromData(data);
    }
    function select(mode) {
      kind.value = mode;
      tabs.forEach(function (t) { t.classList.toggle("active", t.getAttribute("data-mode") === mode); });
      drawPane.classList.toggle("hidden", mode !== "drawn");
      typePane.classList.toggle("hidden", mode !== "typed");
      if (mode === "drawn") resize();
    }
    if (window.SignaturePad && canvas) {
      pad = new window.SignaturePad(canvas, { penColor: "#111827", backgroundColor: "rgba(255,255,255,0)" });
      pad.addEventListener("endStroke", function () { image.value = pad.isEmpty() ? "" : pad.toDataURL("image/png"); });
      window.addEventListener("resize", resize);
      box.querySelector("[data-clear]").addEventListener("click", function (e) { e.preventDefault(); pad.clear(); image.value = ""; });
      tabs.forEach(function (t) { t.addEventListener("click", function (e) { e.preventDefault(); select(t.getAttribute("data-mode")); }); });
      box.querySelector(".tabs").classList.remove("hidden");
      select("drawn");
    } else {
      select("typed");
    }
    if (text && preview) text.addEventListener("input", function () { preview.textContent = text.value; });
  });

  var form = document.getElementById("sign-form");
  if (form) form.addEventListener("submit", function () {
    var b = form.querySelector("button[type=submit]");
    if (b) { b.disabled = true; b.textContent = "Signing…"; }
  });
})();
