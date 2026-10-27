// Set the light/dark look before the first paint (the app's own copy of this lives in src/ui/theme.ts).
(function () {
  var t = null;
  try { t = localStorage.getItem("pinr.theme"); } catch (e) {}
  if (t !== "light" && t !== "dark") t = matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  document.documentElement.dataset.theme = t;
})();
