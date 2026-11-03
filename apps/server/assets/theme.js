// Basecoat switches themes with a "dark" class on <html>. Follow the system setting, before first paint.
(function () {
  var mq = window.matchMedia && window.matchMedia("(prefers-color-scheme: dark)");
  function apply() { document.documentElement.classList.toggle("dark", !!(mq && mq.matches)); }
  apply();
  if (mq && mq.addEventListener) mq.addEventListener("change", apply);
})();
