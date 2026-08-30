const state = { csrfToken: '', email: '' };

const ROUTES = ['ask', 'add', 'documents', 'account'];
const DEFAULT_ROUTE = 'ask';
const SIGNIN_ROUTE = 'signin';

const THEMES = ['system', 'light', 'dark'];
const THEME_KEY = 'baby-model-theme';
const THEME_COLORS = { light: '#f4f7fc', dark: '#080d1a' };

const $ = (id) => document.getElementById(id);

/** Reads the stored preference; falls back to following the system theme. */
function storedTheme() {
  try {
    const value = window.localStorage.getItem(THEME_KEY);
    return THEMES.includes(value) ? value : 'system';
  } catch {
    return 'system';
  }
}

/**
 * Applies a theme preference. `system` follows the device setting; the
 * resolved palette is always written to `data-theme` on the root element so
 * the stylesheet only ever describes the light palette once.
 */
function applyTheme(theme) {
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme;
  document.documentElement.setAttribute('data-theme', resolved);
  $('theme-color').setAttribute('content', THEME_COLORS[resolved]);
  for (const name of THEMES) {
    $(`theme-${name}`).setAttribute('aria-pressed', String(name === theme));
  }
}

function setTheme(theme) {
  applyTheme(theme);
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // A blocked storage API only costs persistence, not the theme itself.
  }
}

function setStatus(message, isError = false) {
  const status = $('status');
  status.textContent = message;
  status.classList.toggle('error', isError);
}

async function api(path, { method = 'GET', body, form } = {}) {
  const headers = {};
  if (state.csrfToken) {
    headers['X-CSRF-Token'] = state.csrfToken;
  }
  let payload;
  if (form) {
    payload = form;
  } else if (body) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(path, { method, headers, body: payload, credentials: 'same-origin' });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

/** Runs an action and surfaces any failure in the status line. */
async function guard(action) {
  try {
    await action();
  } catch (error) {
    setStatus(error.message, true);
  }
}

/** Reads the route from the location hash, e.g. `#/documents` -> `documents`. */
function routeFromHash() {
  const name = window.location.hash.replace(/^#\/?/, '');
  return ROUTES.includes(name) ? name : DEFAULT_ROUTE;
}

/** Shows exactly one page, because every view of the portal does a single thing. */
function render() {
  const signedIn = state.csrfToken !== '';
  const route = signedIn ? routeFromHash() : SIGNIN_ROUTE;
  for (const name of [SIGNIN_ROUTE, ...ROUTES]) {
    const page = $(`${name}-page`);
    const active = name === route;
    page.hidden = !active;
    if (active) {
      page.querySelector('h1')?.focus({ preventScroll: true });
    }
  }
  $('tabbar').hidden = !signedIn;
  for (const name of ROUTES) {
    const tab = $(`tab-${name}`);
    tab.classList.toggle('active', name === route);
    if (name === route) {
      tab.setAttribute('aria-current', 'page');
    } else {
      tab.removeAttribute('aria-current');
    }
  }
  window.scrollTo(0, 0);
}

/** Navigates to a page; the hash change triggers the render. */
function navigate(route) {
  const target = `#/${route}`;
  if (window.location.hash === target) {
    render();
    return;
  }
  window.location.hash = target;
}

function showSignedIn(session, route = routeFromHash()) {
  state.csrfToken = session.csrfToken;
  state.email = session.email;
  $('session-email').textContent = session.email;
  navigate(route);
}

function showSignedOut() {
  state.csrfToken = '';
  state.email = '';
  $('session-email').textContent = '';
  const answer = $('answer');
  answer.replaceChildren();
  answer.hidden = true;
  $('question').value = '';
  $('document-list').replaceChildren();
  render();
}

async function refreshDocuments() {
  const { documents } = await api('/api/documents');
  const list = $('document-list');
  list.replaceChildren();
  if (documents.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No documents yet. Add one to teach your private model.';
    list.append(empty);
    return;
  }
  for (const doc of documents) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    label.className = 'document-label';
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = doc.category;
    const title = document.createElement('span');
    title.className = 'document-title';
    title.textContent = doc.title;
    const meta = document.createElement('span');
    meta.className = 'document-meta';
    meta.textContent = `${doc.byteSize} bytes`;
    label.append(badge, title, meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger small';
    remove.textContent = 'Delete';
    remove.addEventListener('click', () =>
      guard(async () => {
        await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
        setStatus('Document deleted.');
        await refreshDocuments();
      }),
    );
    item.append(label, remove);
    list.append(item);
  }
}

function renderAnswer(result) {
  const container = $('answer');
  container.replaceChildren();
  const heading = document.createElement('h2');
  heading.textContent = result.grounded ? 'Answer from your documents' : 'No grounded answer';
  const paragraph = document.createElement('p');
  paragraph.textContent = result.answer;
  container.append(heading, paragraph);
  if (result.citations.length > 0) {
    const list = document.createElement('ul');
    list.className = 'citations';
    for (const citation of result.citations) {
      const item = document.createElement('li');
      item.textContent = `${citation.documentTitle} (${citation.category}, section ${citation.position + 1}) — relevance ${citation.score}`;
      list.append(item);
    }
    container.append(list);
  }
  container.hidden = false;
}

async function handleAuth(action) {
  const email = $('email').value;
  const password = $('password').value;
  const session = await api(`/api/auth/${action}`, { method: 'POST', body: { email, password } });
  showSignedIn(session, DEFAULT_ROUTE);
  $('password').value = '';
  setStatus(action === 'register' ? 'Vault created.' : 'Signed in.');
  await refreshDocuments();
}

function wire() {
  window.addEventListener('hashchange', render);

  for (const name of THEMES) {
    $(`theme-${name}`).addEventListener('click', () => setTheme(name));
  }
  // Keeps `system` in step with the OS switching between light and dark.
  const systemTheme = window.matchMedia('(prefers-color-scheme: light)');
  const syncSystemTheme = () => applyTheme(storedTheme());
  if (typeof systemTheme.addEventListener === 'function') {
    systemTheme.addEventListener('change', syncSystemTheme);
  } else {
    systemTheme.addListener(syncSystemTheme);
  }

  $('auth-form').addEventListener('submit', (event) => {
    event.preventDefault();
    guard(() => handleAuth('login'));
  });

  $('register-button').addEventListener('click', () => guard(() => handleAuth('register')));

  $('logout-button').addEventListener('click', () =>
    guard(async () => {
      await api('/api/auth/logout', { method: 'POST' });
      showSignedOut();
      setStatus('Signed out.');
    }),
  );

  $('upload-form').addEventListener('submit', (event) => {
    event.preventDefault();
    guard(async () => {
      const form = new FormData();
      form.append('title', $('title').value);
      form.append('category', $('category').value);
      form.append('content', $('content').value);
      const file = $('file').files[0];
      if (file) {
        form.append('file', file);
      }
      await api('/api/documents', { method: 'POST', form });
      $('upload-form').reset();
      await refreshDocuments();
      navigate('documents');
      setStatus('Document stored and encrypted.');
    });
  });

  $('ask-form').addEventListener('submit', (event) => {
    event.preventDefault();
    guard(async () => {
      const result = await api('/api/ask', {
        method: 'POST',
        body: { question: $('question').value },
      });
      renderAnswer(result);
      setStatus('');
    });
  });

  $('export-button').addEventListener('click', () =>
    guard(async () => {
      const data = await api('/api/account/export');
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = 'baby-model-export.json';
      link.click();
      setTimeout(() => URL.revokeObjectURL(link.href), 0);
      setStatus('Export downloaded.');
    }),
  );

  $('delete-account-button').addEventListener('click', () =>
    guard(async () => {
      if (!window.confirm('Permanently delete your account and every document?')) {
        return;
      }
      await api('/api/account', { method: 'DELETE' });
      showSignedOut();
      setStatus('Account and all documents erased.');
    }),
  );
}

async function boot() {
  applyTheme(storedTheme());
  wire();
  try {
    const session = await api('/api/auth/me');
    showSignedIn(session);
    await refreshDocuments();
  } catch {
    showSignedOut();
  }
}

boot();
