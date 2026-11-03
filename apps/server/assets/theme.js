// Basecoat switches themes with a "dark" class on <html>. Admin pages carry the person's choice
// in data-theme ("light", "dark", or "system"); signing pages have none and follow the device.
(function () {
  var root = document.documentElement;
  var choice = root.getAttribute("data-theme") || "system";
  var mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  function apply() { root.classList.toggle("dark", choice === "dark" || (choice === "system" && !!(mq && mq.matches))); }
  apply();
  if (choice === "system" && mq && mq.addEventListener) mq.addEventListener("change", apply);
})();
