// Guided signing: inline fields, Start/Next navigation, progress, and "Adopt your signature".
// Without JavaScript the page still works: inputs are plain form fields and signatures can be typed.
(function () {
  var form = document.getElementById("sign-form");
  if (!form) return;
  document.body.classList.add("js");

  var fields = Array.prototype.slice.call(form.querySelectorAll("[data-smd-field]"));
  var required = fields.filter(function (f) { return f.hasAttribute("data-required"); });
  // One main button walks through the fields: Start, then Next, then Finish once everything is
  // filled in. Back returns to the previous field. Without JavaScript it is a plain Finish button.
  var nextBtn = document.getElementById("guide-next");
  var backBtn = document.getElementById("guide-back");
  var progress = document.getElementById("guide-progress");
  var finishBtns = [nextBtn];
  var started = false;
  var cursor = -1;

  // ---- Field state ----
  function isDone(f) {
    if (f.classList.contains("smd-sign")) return f.classList.contains("smd-done");
    if (f.type === "checkbox") return f.checked;
    return (f.value || "").trim() !== "";
  }
  function refresh() {
    var left = 0;
    fields.forEach(function (f) {
      var done = isDone(f);
      f.classList.toggle("smd-done", done);
      if (f.hasAttribute("data-required") && !done) left++;
      var key = f.getAttribute("data-smd-field");
      document.querySelectorAll('[data-mirror="' + CSS.escape(key) + '"]').forEach(function (m) { m.textContent = f.value || "…"; });
    });
    var total = required.length;
    progress.textContent = left === 0 ? "All required fields are done" : (total - left) + " of " + total + " required fields done";
    // "Start" only while nothing is filled in and the signer hasn't begun; then "Next"; then "Finish".
    var filled = fields.some(isDone);
    if (filled) started = true;
    nextBtn.textContent = left === 0 ? "Finish" : started ? "Next" : "Start";
    nextBtn.classList.toggle("breathe", left === 0);
    if (backBtn) backBtn.hidden = !started || left === 0 || cursor <= 0;
    if (left === 0) fields.forEach(function (x) { x.classList.remove("smd-current"); });
    return left;
  }
  fields.forEach(function (f) {
    f.addEventListener("input", refresh);
    f.addEventListener("change", refresh);
    f.addEventListener("focus", function () { started = true; refresh(); });
  });

  // ---- Start / Next / Back ----
  function focusField(f) {
    fields.forEach(function (x) { x.classList.remove("smd-current"); });
    f.classList.add("smd-current");
    f.scrollIntoView({ behavior: "smooth", block: "center" });
    if (f.classList.contains("smd-sign")) f.querySelector(".smd-sign-tag").focus({ preventScroll: true });
    else f.focus({ preventScroll: true });
  }
  nextBtn.addEventListener("click", function (e) {
    started = true;
    if (refresh() === 0) return; // Finish: let the form submit
    e.preventDefault();
    var order = required.length ? required : fields;
    for (var i = 1; i <= order.length; i++) {
      var f = order[(cursor + i) % order.length];
      if (!isDone(f)) { cursor = order.indexOf(f); focusField(f); refresh(); return; }
    }
  });
  if (backBtn) backBtn.addEventListener("click", function () {
    var order = required.length ? required : fields;
    if (cursor <= 0) return;
    cursor -= 1;
    focusField(order[cursor]);
    refresh();
  });

  form.addEventListener("submit", function (e) {
    var left = refresh();
    if (left > 0) {
      e.preventDefault();
      started = true;
      nextBtn.click();
      return;
    }
    finishBtns.forEach(function (b) { b.disabled = true; b.textContent = "Finishing…"; });
  });

  // ---- Adopt your signature ----
  var dialog = document.getElementById("adopt");
  var adopted = { signature: null, initials: null };
  var target = null;
  var mode = "typed";
  var pad = null;
  var canvas = document.getElementById("adopt-pad");
  var textInput = document.getElementById("adopt-text");
  var preview = document.getElementById("adopt-preview");
  var tabs = dialog.querySelectorAll(".sig-modes button");

  function setMode(m) {
    mode = m;
    tabs.forEach(function (t) {
      var on = t.getAttribute("data-mode") === m;
      t.setAttribute("aria-pressed", on ? "true" : "false");
      t.classList.toggle("outline", !on);
    });
    dialog.querySelector('[data-pane="typed"]').hidden = m !== "typed";
    dialog.querySelector('[data-pane="drawn"]').hidden = m !== "drawn";
    if (m === "drawn") sizePad();
  }
  function sizePad() {
    if (!pad) return;
    var ratio = Math.max(window.devicePixelRatio || 1, 1);
    canvas.width = canvas.offsetWidth * ratio;
    canvas.height = canvas.offsetHeight * ratio;
    canvas.getContext("2d").scale(ratio, ratio);
    pad.clear();
  }
  if (window.SignaturePad && canvas) pad = new window.SignaturePad(canvas, { penColor: "#0f172a", backgroundColor: "rgba(255,255,255,0)" });
  else tabs[1].hidden = true;
  tabs.forEach(function (t) { t.addEventListener("click", function () { setMode(t.getAttribute("data-mode")); }); });
  document.getElementById("adopt-clear").addEventListener("click", function (e) { e.preventDefault(); if (pad) pad.clear(); });
  textInput.addEventListener("input", function () { preview.textContent = textInput.value; });

  function apply(box, value) {
    var kindInput = box.querySelector('input[name$=":kind"]');
    var imageInput = box.querySelector('input[name$=":image"]');
    var textField = box.querySelector('input[name$=":text"]');
    var shown = box.querySelector(".smd-sign-value");
    kindInput.value = value.kind;
    imageInput.value = value.kind === "drawn" ? value.image : "";
    textField.value = value.kind === "typed" ? value.text : "";
    shown.innerHTML = "";
    if (value.kind === "drawn") {
      var img = document.createElement("img");
      img.src = value.image;
      img.alt = "Signature";
      shown.appendChild(img);
    } else {
      var span = document.createElement("span");
      span.className = "smd-signature-typed";
      span.textContent = value.text;
      shown.appendChild(span);
    }
    box.classList.add("smd-done");
    refresh();
  }

  function open(box) {
    target = box;
    var kind = box.getAttribute("data-sign");
    var initials = kind === "initials";
    document.getElementById("adopt-title").textContent = initials ? "Adopt your initials" : "Adopt your signature";
    document.getElementById("adopt-text-label").textContent = initials ? "Initials" : "Full name";
    var existing = adopted[kind];
    textInput.value = existing && existing.kind === "typed" ? existing.text : dialog.getAttribute(initials ? "data-initials" : "data-name");
    preview.textContent = textInput.value;
    preview.classList.toggle("initials", initials);
    dialog.showModal();
    setMode(existing && existing.kind === "drawn" ? "drawn" : "typed");
  }

  document.getElementById("adopt-ok").addEventListener("click", function () {
    var kind = target.getAttribute("data-sign");
    var value;
    if (mode === "drawn") {
      if (!pad || pad.isEmpty()) { canvas.classList.add("shake"); setTimeout(function () { canvas.classList.remove("shake"); }, 400); return; }
      value = { kind: "drawn", image: pad.toDataURL("image/png") };
    } else {
      var t = textInput.value.trim();
      if (!t) { textInput.focus(); return; }
      value = { kind: "typed", text: t };
    }
    adopted[kind] = value;
    apply(target, value);
    dialog.close();
    // Move straight on to the next field, like a guided signing flow.
    setTimeout(function () { if (refresh() > 0) nextBtn.click(); else focusField(target); }, 150);
  });

  form.querySelectorAll(".smd-sign").forEach(function (box) {
    box.querySelector(".smd-sign-tag").addEventListener("click", function () {
      started = true;
      var kind = box.getAttribute("data-sign");
      if (adopted[kind]) {
        apply(box, adopted[kind]);
        setTimeout(function () { if (refresh() > 0) nextBtn.click(); }, 150);
      } else open(box);
    });
    // Click (or Enter/Space on) an applied signature to change it.
    var shown = box.querySelector(".smd-sign-value");
    shown.addEventListener("click", function () { open(box); });
    shown.addEventListener("keydown", function (e) { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); open(box); } });
  });

  var err = document.getElementById("sign-error");
  if (err) { started = true; err.focus(); }

  // Light dismiss for browsers without <dialog closedby> (Safari): close on a press and release outside.
  if (!("closedBy" in HTMLDialogElement.prototype)) {
    var outside = function (e) {
      var r = dialog.getBoundingClientRect();
      return e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom;
    };
    var pressedOutside = false;
    dialog.addEventListener("pointerdown", function (e) { pressedOutside = outside(e); });
    dialog.addEventListener("pointerup", function (e) { if (pressedOutside && outside(e)) dialog.close(); });
  }
  refresh();
})();
