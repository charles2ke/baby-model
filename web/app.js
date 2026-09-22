const state = { csrfToken: '', email: '', integrations: [], statusRoute: '' };

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

/**
 * Shows a message for the page that produced it. `origin` is the route the
 * request started on, so a reply that lands after the visitor moved on is
 * dropped instead of appearing on the page now on screen.
 */
function setStatus(message, isError = false, origin = currentRoute()) {
  if (message !== '' && origin !== currentRoute()) {
    return;
  }
  const status = $('status');
  status.textContent = message;
  status.classList.toggle('error', isError);
  state.statusRoute = message === '' ? '' : origin;
}

/**
 * Runs an action with its button disabled and relabelled, so a slow request
 * is visible and cannot be submitted twice by an impatient tap.
 */
async function busy(button, label, action) {
  const original = button.textContent;
  button.disabled = true;
  button.setAttribute('aria-busy', 'true');
  button.textContent = label;
  try {
    await action();
  } finally {
    button.disabled = false;
    button.removeAttribute('aria-busy');
    button.textContent = original;
  }
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

/**
 * Runs an action and surfaces any failure in the status line. The route the
 * action started on is captured up front and handed to the action, so slow
 * requests report on the page that initiated them or not at all.
 */
async function guard(action) {
  const origin = currentRoute();
  try {
    await action(origin);
  } catch (error) {
    setStatus(error.message, true, origin);
  }
}

/** Reads the route from the location hash, e.g. `#/documents` -> `documents`. */
function routeFromHash() {
  const name = window.location.hash.replace(/^#\/?/, '');
  return ROUTES.includes(name) ? name : DEFAULT_ROUTE;
}

/** The page actually on screen: signed-out visitors only ever see sign-in. */
function currentRoute() {
  return state.csrfToken === '' ? SIGNIN_ROUTE : routeFromHash();
}

/** Shows exactly one page, because every view of the portal does a single thing. */
function render() {
  const signedIn = state.csrfToken !== '';
  const route = currentRoute();
  // A message belongs to the page that produced it and would be confusing
  // once another page is on screen.
  if (state.statusRoute !== '' && state.statusRoute !== route) {
    setStatus('');
  }
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

/** Returns the password field to its masked state, never leaving it revealed. */
function hidePassword() {
  $('password').type = 'password';
  $('password-toggle').textContent = 'Show';
  $('password-toggle').setAttribute('aria-pressed', 'false');
}

function showSignedOut() {
  state.csrfToken = '';
  state.email = '';
  $('session-email').textContent = '';
  const answer = $('answer');
  answer.replaceChildren();
  answer.hidden = true;
  $('question').value = '';
  hidePassword();
  $('document-list').replaceChildren();
  applyDocumentCount(0);
  state.integrations = [];
  $('source').replaceChildren(new Option('Plain text or text file', 'text'));
  render();
}

/** Human-readable document size: bytes are precise but rarely meaningful. */
function formatBytes(bytes) {
  if (bytes < 1024) {
    return `${bytes} bytes`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Formats the stored ISO timestamp in the visitor's own locale. */
function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

/** Keeps the vault-dependent parts of the portal in step with its contents. */
function applyDocumentCount(count) {
  $('document-count').textContent =
    count === 0
      ? 'Nothing stored yet'
      : `${count} ${count === 1 ? 'document' : 'documents'} stored`;
  $('ask-empty').hidden = count > 0;
}

async function refreshDocuments() {
  const { documents } = await api('/api/documents');
  const list = $('document-list');
  list.replaceChildren();
  applyDocumentCount(documents.length);
  if (documents.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No documents yet. Add one to teach your private model.';
    const link = document.createElement('a');
    link.href = '#/add';
    link.textContent = 'Add a document';
    empty.append(' ', link);
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
    const added = formatDate(doc.createdAt);
    meta.textContent = added ? `${formatBytes(doc.byteSize)} · added ${added}` : formatBytes(doc.byteSize);
    label.append(badge, title, meta);
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'danger small';
    remove.textContent = 'Delete';
    remove.setAttribute('aria-label', `Delete ${doc.title}`);
    remove.addEventListener('click', () =>
      guard(async (origin) => {
        // Deleting a document is irreversible, so it is always confirmed.
        if (!window.confirm(`Delete “${doc.title}” permanently?`)) {
          return;
        }
        await busy(remove, 'Deleting…', async () => {
          await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
        });
        setStatus('Document deleted.', false, origin);
        await refreshDocuments();
      }),
    );
    item.append(label, remove);
    list.append(item);
  }
}

/** Loads the real-world import sources offered by the server. */
async function refreshIntegrations() {
  const { integrations } = await api('/api/integrations');
  state.integrations = integrations;
  const select = $('source');
  select.replaceChildren(new Option('Plain text or text file', 'text'));
  for (const integration of integrations) {
    const option = document.createElement('option');
    option.value = integration.id;
    option.textContent = integration.label;
    select.append(option);
  }
  applySource();
}

/** Returns the integration currently selected on the Add page, if any. */
function selectedIntegration() {
  return state.integrations.find((integration) => integration.id === $('source').value);
}

/** Adapts the Add form to the selected source: hints, file filter, title. */
function applySource() {
  const integration = selectedIntegration();
  $('source-hint').textContent = integration ? integration.description : '';
  $('file-label').textContent = integration
    ? `Upload the export file (${integration.fileExtensions.join(', ')})`
    : '…or upload a UTF-8 text file';
  $('file').setAttribute(
    'accept',
    integration ? integration.fileExtensions.join(',') : '.txt,.md,.csv,.json,text/*',
  );
  $('content-label').textContent = integration
    ? '…or paste the contents of the export'
    : 'Paste text';
  $('title').required = !integration;
  if (integration) {
    $('category').value = integration.defaultCategory;
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
  if (result.skill) {
    const skill = document.createElement('p');
    skill.className = 'skill';
    skill.textContent = `Skill applied: ${result.skill.name}`;
    container.append(skill);
  }
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
  // Moves the reader straight to the result instead of leaving it below the fold.
  container.focus({ preventScroll: true });
  container.scrollIntoView({ block: 'nearest' });
}

async function handleAuth(action) {
  const email = $('email').value;
  const password = $('password').value;
  const session = await api(`/api/auth/${action}`, { method: 'POST', body: { email, password } });
  showSignedIn(session, DEFAULT_ROUTE);
  $('password').value = '';
  hidePassword();
  setStatus(action === 'register' ? 'Vault created.' : 'Signed in.');
  await refreshIntegrations();
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
  } else if (typeof systemTheme.addListener === 'function') {
    systemTheme.addListener(syncSystemTheme);
  }

  $('auth-form').addEventListener('submit', (event) => {
    event.preventDefault();
    guard(() => busy($('login-button'), 'Signing in…', () => handleAuth('login')));
  });

  $('register-button').addEventListener('click', () =>
    guard(() => busy($('register-button'), 'Creating…', () => handleAuth('register'))),
  );

  // Typos are the usual reason a long password is rejected, so it can be read back.
  $('password-toggle').addEventListener('click', () => {
    const field = $('password');
    const reveal = field.type === 'password';
    field.type = reveal ? 'text' : 'password';
    $('password-toggle').textContent = reveal ? 'Hide' : 'Show';
    $('password-toggle').setAttribute('aria-pressed', String(reveal));
    field.focus();
  });

  $('logout-button').addEventListener('click', () =>
    guard(async () => {
      await api('/api/auth/logout', { method: 'POST' });
      showSignedOut();
      setStatus('Signed out.');
    }),
  );

  $('upload-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const submit = $('save-button');
    guard(() =>
      busy(submit, 'Saving…', async () => {
        const integration = selectedIntegration();
        const form = new FormData();
        form.append('title', $('title').value);
        form.append('category', $('category').value);
        form.append('content', $('content').value);
        const file = $('file').files[0];
        if (file) {
          form.append('file', file);
        }
        const path = integration ? `/api/integrations/${integration.id}/import` : '/api/documents';
        await api(path, { method: 'POST', form });
        $('upload-form').reset();
        applySource();
        await refreshDocuments();
        navigate('documents');
        setStatus(
          integration ? `Imported from ${integration.label} and encrypted.` : 'Document stored and encrypted.',
        );
      }),
    );
  });

  $('source').addEventListener('change', applySource);

  $('ask-form').addEventListener('submit', (event) => {
    event.preventDefault();
    const submit = $('ask-button');
    guard(() =>
      busy(submit, 'Asking…', async () => {
        setStatus('');
        const result = await api('/api/ask', {
          method: 'POST',
          body: { question: $('question').value },
        });
        renderAnswer(result);
      }),
    );
  });

  $('export-button').addEventListener('click', () =>
    guard((origin) =>
      busy($('export-button'), 'Preparing…', async () => {
        const data = await api('/api/account/export');
        const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
        const link = document.createElement('a');
        link.href = URL.createObjectURL(blob);
        link.download = 'baby-model-export.json';
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 0);
        setStatus('Export downloaded.', false, origin);
      }),
    ),
  );

  $('delete-account-button').addEventListener('click', () =>
    guard(async () => {
      if (!window.confirm('Permanently delete your account and every document?')) {
        return;
      }
      await busy($('delete-account-button'), 'Deleting…', async () => {
        await api('/api/account', { method: 'DELETE' });
      });
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
    await refreshIntegrations();
    await refreshDocuments();
  } catch {
    showSignedOut();
  }
}

boot();
