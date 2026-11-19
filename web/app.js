const state = {
  csrfToken: '',
  email: '',
  integrations: [],
  documents: [],
  statusRoute: '',
  // The document the reader shows, and what an answer quoted from it.
  readerId: undefined,
  highlight: undefined,
};

const ROUTES = ['ask', 'add', 'documents', 'account'];
const DEFAULT_ROUTE = 'ask';
const SIGNIN_ROUTE = 'signin';
/** A single stored document, opened from the list or from an answer's citation. */
const READER_ROUTE = 'document';
const READER_PATH = /^documents\/(\d+)$/;

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

/** Reads the page path from the location hash, e.g. `#/documents/7` -> `documents/7`. */
function pathFromHash() {
  const path = window.location.hash.replace(/^#\/?/, '');
  return ROUTES.includes(path) || READER_PATH.test(path) ? path : DEFAULT_ROUTE;
}

/** Reads the route from the location hash, e.g. `#/documents` -> `documents`. */
function routeFromHash() {
  const path = pathFromHash();
  return READER_PATH.test(path) ? READER_ROUTE : path;
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
  for (const name of [SIGNIN_ROUTE, ...ROUTES, READER_ROUTE]) {
    const page = $(`${name}-page`);
    const active = name === route;
    page.hidden = !active;
    if (active) {
      page.querySelector('h1')?.focus({ preventScroll: true });
    }
  }
  $('tabbar').hidden = !signedIn;
  // An open document still belongs to the Documents section.
  const section = route === READER_ROUTE ? 'documents' : route;
  for (const name of ROUTES) {
    const tab = $(`tab-${name}`);
    tab.classList.toggle('active', name === section);
    if (name === route) {
      tab.setAttribute('aria-current', 'page');
    } else {
      tab.removeAttribute('aria-current');
    }
  }
  window.scrollTo(0, 0);
  // Pages showing live data load it as they open.
  if (route === READER_ROUTE) {
    const documentId = Number(READER_PATH.exec(pathFromHash())[1]);
    guard(() => openDocument(documentId));
  } else {
    closeDocument();
  }
  if (route === 'account') {
    guard(refreshSessions);
  }
}

/** Navigates to a page, e.g. `documents` or `documents/7`; the hash change triggers the render. */
function navigate(path) {
  const target = `#/${path}`;
  if (window.location.hash === target) {
    render();
    return;
  }
  window.location.hash = target;
}

function showSignedIn(session, path = pathFromHash()) {
  state.csrfToken = session.csrfToken;
  state.email = session.email;
  $('session-email').textContent = session.email;
  $('account-username').value = session.email;
  navigate(path);
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
  $('account-username').value = '';
  const answer = $('answer');
  answer.replaceChildren();
  answer.hidden = true;
  $('question').value = '';
  hidePassword();
  clearPasswordChange();
  $('sessions-summary').textContent = '';
  state.documents = [];
  clearDocumentFilters();
  $('document-filters').hidden = true;
  $('document-filter-summary').hidden = true;
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
  state.documents = documents;
  applyDocumentCount(documents.length);
  renderDocuments();
}

/** A comparable form of free text, so case and Unicode variants still match. */
function searchKey(text) {
  return text.normalize('NFKC').toLocaleLowerCase();
}

function clearDocumentFilters() {
  $('document-search').value = '';
  $('document-filter').value = '';
}

/** Lists the stored documents matching the title search and category filter. */
function renderDocuments() {
  const documents = state.documents;
  const list = $('document-list');
  const summary = $('document-filter-summary');
  $('document-filters').hidden = documents.length === 0;
  if (documents.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No documents yet. Add one to teach your private model.';
    const link = document.createElement('a');
    link.href = '#/add';
    link.textContent = 'Add a document';
    empty.append(' ', link);
    list.replaceChildren(empty);
    summary.hidden = true;
    return;
  }
  const query = searchKey($('document-search').value.trim());
  const category = $('document-filter').value;
  const shown = documents.filter(
    (doc) =>
      (category === '' || doc.category === category) && searchKey(doc.title).includes(query),
  );
  summary.hidden = query === '' && category === '';
  summary.textContent = `Showing ${shown.length} of ${documents.length} ${documents.length === 1 ? 'document' : 'documents'}`;
  if (shown.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'empty';
    empty.textContent = 'No documents match your search.';
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'secondary small';
    reset.textContent = 'Clear filters';
    reset.addEventListener('click', () => {
      clearDocumentFilters();
      renderDocuments();
      $('document-search').focus();
    });
    empty.append(' ', reset);
    list.replaceChildren(empty);
    return;
  }
  list.replaceChildren(...shown.map(documentItem));
}

function documentItem(doc) {
  const item = document.createElement('li');
  const label = document.createElement('span');
  label.className = 'document-label';
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = doc.category;
  const title = document.createElement('a');
  title.className = 'document-title';
  title.href = `#/documents/${doc.id}`;
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
  return item;
}

// The server quotes documents sentence by sentence, normalised and with
// invisible characters removed; the reader mirrors that to find the quotes.
// Written without lookbehind, which older Safari versions cannot parse.
const SENTENCE_BREAK = /([.!?])\s+|\r?\n+/g;
const INVISIBLE_CHARACTERS = /[\u00AD\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

/** Where each sentence of a text starts and ends, split as the server splits it. */
function sentenceRanges(text) {
  const ranges = [];
  const add = (from, to) => {
    const sentence = text.slice(from, to);
    const start = from + sentence.length - sentence.trimStart().length;
    const end = to - (sentence.length - sentence.trimEnd().length);
    if (end > start) {
      ranges.push([start, end]);
    }
  };
  let from = 0;
  for (const match of text.matchAll(SENTENCE_BREAK)) {
    // A sentence keeps its closing punctuation; only the break is dropped.
    add(from, match[1] === undefined ? match.index : match.index + 1);
    from = match.index + match[0].length;
  }
  add(from, text.length);
  return ranges;
}

/** A sentence as the server quotes it: normalised, with invisible characters removed. */
function quoteKey(sentence) {
  return sentence.normalize('NFKC').replace(INVISIBLE_CHARACTERS, '');
}

/**
 * Spells a passage out of whole sentences, taken in the order given and joined
 * by single spaces. Returns the indexes of the spelling whose last sentence
 * comes earliest, or undefined when the passage cannot be spelled out.
 */
function earliestSpelling(excerpt, keys) {
  // Where a sentence may start in the passage, with the lowest index it may
  // have there and the step that led there. The end of the passage counts as
  // one past its length, as though a space followed it.
  const reached = new Map([[0, { next: 0 }]]);
  for (let position = 0; position < excerpt.length; position += 1) {
    const step = reached.get(position);
    if (step === undefined) {
      continue;
    }
    for (let index = step.next; index < keys.length; index += 1) {
      const key = keys[index];
      const end = position + key.length;
      if (
        key !== '' &&
        excerpt.startsWith(key, position) &&
        (end === excerpt.length || excerpt[end] === ' ') &&
        !(reached.get(end + 1)?.next <= index + 1)
      ) {
        reached.set(end + 1, { next: index + 1, from: position, index });
      }
    }
  }
  const used = [];
  for (let step = reached.get(excerpt.length + 1); step?.from !== undefined; step = reached.get(step.from)) {
    used.unshift(step.index);
  }
  return used.length > 0 ? used : undefined;
}

/**
 * Finds the sentences a quoted passage was built from: whole sentences of the
 * document, in document order, joined by spaces. Where its sentences appear
 * more than once, the earliest place that has them all close together wins.
 * Returns their indexes, or undefined when the passage cannot be spelled out,
 * as when part of it was redacted.
 */
function spellOut(excerpt, keys) {
  const earliest = earliestSpelling(excerpt, keys);
  if (earliest === undefined) {
    return undefined;
  }
  // Spelling the passage backwards from where it ends soonest takes each
  // repeated sentence from as close to the rest of the passage as possible.
  const last = earliest[earliest.length - 1];
  const reverse = (text) => text.split('').reverse().join('');
  return earliestSpelling(reverse(excerpt), keys.slice(0, last + 1).reverse().map(reverse))
    .map((index) => last - index)
    .reverse();
}

/** Whether a passage contains this sentence whole, not just part of a longer one. */
function containsSentence(excerpt, key) {
  if (key === '') {
    return false;
  }
  for (let index = excerpt.indexOf(key); index !== -1; index = excerpt.indexOf(key, index + 1)) {
    const end = index + key.length;
    if ((index === 0 || excerpt[index - 1] === ' ') && (end === excerpt.length || excerpt[end] === ' ')) {
      return true;
    }
  }
  return false;
}

/**
 * Shows a document as written, marking the sentences an answer quoted from it.
 * Built from text nodes, so nothing in a document is ever parsed as markup.
 * Returns the first marked sentence, if any.
 */
function fillReader(text, excerpt) {
  const ranges = sentenceRanges(text);
  const keys = ranges.map(([start, end]) => quoteKey(text.slice(start, end)));
  const used = excerpt === '' ? [] : spellOut(excerpt, keys);
  // Where redaction changed the quote, the sentences it still holds whole are marked.
  const quoted = used
    ? used.map((index) => ranges[index])
    : ranges.filter((_, index) => containsSentence(excerpt, keys[index]));
  const nodes = [];
  let cursor = 0;
  for (const [start, end] of quoted) {
    const mark = document.createElement('mark');
    mark.textContent = text.slice(start, end);
    nodes.push(text.slice(cursor, start), mark);
    cursor = end;
  }
  nodes.push(text.slice(cursor));
  $('reader-content').replaceChildren(...nodes);
  return quoted.length > 0 ? $('reader-content').querySelector('mark') : null;
}

/** Opens a stored document, highlighting what the answer it was cited in quoted. */
async function openDocument(documentId) {
  const excerpt = state.highlight?.documentId === documentId ? state.highlight.excerpt : '';
  closeDocument();
  state.readerId = documentId;
  $('reader-title').textContent = 'Opening document…';
  const reply = await api(`/api/documents/${documentId}`).catch((error) => {
    if (state.readerId === documentId) {
      $('reader-title').textContent = 'Document unavailable';
    }
    throw error;
  });
  // The visitor may have moved on while the document was loading.
  if (state.readerId !== documentId) {
    return;
  }
  const stored = reply.document;
  $('reader-title').textContent = stored.title;
  const added = formatDate(stored.createdAt);
  $('reader-meta').textContent = [stored.category, formatBytes(stored.byteSize), added && `added ${added}`]
    .filter(Boolean)
    .join(' · ');
  const first = fillReader(stored.content, excerpt);
  $('reader-note').hidden = first === null;
  first?.scrollIntoView({ block: 'center' });
}

/**
 * Empties the reader, so a document's text does not linger once it is closed.
 * A highlight only ever applies to the document its citation opened.
 */
function closeDocument() {
  state.readerId = undefined;
  state.highlight = undefined;
  $('reader-title').textContent = '';
  $('reader-meta').textContent = '';
  $('reader-note').hidden = true;
  $('reader-content').replaceChildren();
}

/** Says how many other devices or browsers are signed in to the account. */
async function refreshSessions() {
  const { others } = await api('/api/account/sessions');
  $('sessions-summary').textContent =
    others === 0
      ? 'No other session is signed in to your account.'
      : `${others} other ${others === 1 ? 'session is' : 'sessions are'} signed in to your account.`;
}

/** Empties the password change form, so no password is left behind in it. */
function clearPasswordChange() {
  for (const id of ['current-password', 'new-password', 'confirm-password']) {
    $(id).value = '';
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
      const link = document.createElement('a');
      link.href = `#/documents/${citation.documentId}`;
      link.textContent = citation.documentTitle;
      // The reader then marks the sentences this citation quoted.
      link.addEventListener('click', () => {
        state.highlight = { documentId: citation.documentId, excerpt: citation.excerpt };
      });
      item.append(
        link,
        ` (${citation.category}, section ${citation.position + 1}) — relevance ${citation.score}`,
      );
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
        // A filter left on from earlier could hide the document just stored.
        clearDocumentFilters();
        await refreshDocuments();
        navigate('documents');
        setStatus(
          integration ? `Imported from ${integration.label} and encrypted.` : 'Document stored and encrypted.',
        );
      }),
    );
  });

  $('source').addEventListener('change', applySource);

  // The category filter offers the same categories a document can be stored under.
  for (const option of $('category').options) {
    $('document-filter').append(new Option(option.textContent, option.value));
  }
  $('document-search').addEventListener('input', renderDocuments);
  $('document-filter').addEventListener('change', renderDocuments);

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

  $('password-form').addEventListener('submit', (event) => {
    event.preventDefault();
    guard((origin) =>
      busy($('change-password-button'), 'Changing…', async () => {
        const newPassword = $('new-password').value;
        if (newPassword !== $('confirm-password').value) {
          throw new Error('The new password and its confirmation do not match.');
        }
        const { csrfToken, signedOutSessions } = await api('/api/account/password', {
          method: 'POST',
          body: { currentPassword: $('current-password').value, newPassword },
        });
        // The server replaces this session along with the password.
        state.csrfToken = csrfToken;
        clearPasswordChange();
        setStatus(
          signedOutSessions === 0
            ? 'Password changed.'
            : `Password changed and ${signedOutSessions} other ${signedOutSessions === 1 ? 'session' : 'sessions'} signed out.`,
          false,
          origin,
        );
        await refreshSessions();
      }),
    );
  });

  $('sign-out-others-button').addEventListener('click', () =>
    guard(async (origin) => {
      if (!window.confirm('Sign out every other device and browser using your account?')) {
        return;
      }
      let signedOut = 0;
      await busy($('sign-out-others-button'), 'Signing out…', async () => {
        ({ signedOut } = await api('/api/account/sessions/others', { method: 'DELETE' }));
      });
      setStatus(
        signedOut === 0
          ? 'No other session was signed in.'
          : `Signed out ${signedOut} other ${signedOut === 1 ? 'session' : 'sessions'}.`,
        false,
        origin,
      );
      await refreshSessions();
    }),
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
