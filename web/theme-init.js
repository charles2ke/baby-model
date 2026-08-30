/**
 * Applies a pinned theme before the first paint so a light-mode user never
 * sees a flash of the dark palette. Loaded synchronously in the document head
 * because the Content-Security-Policy forbids inline scripts.
 */
try {
  var theme = window.localStorage.getItem('baby-model-theme');
  if (theme === 'light' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  }
} catch {
  // Storage can be blocked; the system preference is then used.
}
