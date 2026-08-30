/**
 * Resolves the theme before the first paint so no one sees a flash of the
 * wrong palette. Loaded synchronously in the document head because the
 * Content-Security-Policy forbids inline scripts; `app.js` takes over once it
 * loads and keeps the resolved palette in step with changes.
 */
var stored = null;
try {
  stored = window.localStorage.getItem('baby-model-theme');
} catch {
  // Storage can be blocked; the device preference is then used.
}
if (stored !== 'light' && stored !== 'dark') {
  stored = window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
document.documentElement.setAttribute('data-theme', stored);
