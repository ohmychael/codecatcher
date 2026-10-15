// Applies the saved light/dark choice before the panel paints, so it doesn't flash.
try {
  var t = localStorage.getItem('cc-theme');
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t;
} catch (e) { /* ignore */ }
