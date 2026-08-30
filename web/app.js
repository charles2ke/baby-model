const state = { csrfToken: '', email: '' };

const $ = (id) => document.getElementById(id);

function setStatus(message, isError = false) {
  const status = $('status');
  status.textContent = message;
  status.style.color = isError ? 'var(--danger)' : 'var(--muted)';
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

function showSignedIn(session) {
  state.csrfToken = session.csrfToken;
  state.email = session.email;
  $('session-email').textContent = session.email;
  $('session-bar').hidden = false;
  $('auth-view').hidden = true;
  $('app-view').hidden = false;
}

function showSignedOut() {
  state.csrfToken = '';
  state.email = '';
  $('session-bar').hidden = true;
  $('auth-view').hidden = false;
  $('app-view').hidden = true;
  $('answer').hidden = true;
  $('document-list').replaceChildren();
}

async function refreshDocuments() {
  const { documents } = await api('/api/documents');
  const list = $('document-list');
  list.replaceChildren();
  if (documents.length === 0) {
    const empty = document.createElement('li');
    empty.textContent = 'No documents yet. Add one above to teach your private model.';
    list.append(empty);
    return;
  }
  for (const doc of documents) {
    const item = document.createElement('li');
    const label = document.createElement('span');
    const badge = document.createElement('span');
    badge.className = 'badge';
    badge.textContent = doc.category;
    label.append(badge, document.createTextNode(` ${doc.title} · ${doc.byteSize} bytes`));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'link danger';
    remove.textContent = 'Delete';
    remove.addEventListener('click', async () => {
      await api(`/api/documents/${doc.id}`, { method: 'DELETE' });
      setStatus('Document deleted.');
      await refreshDocuments();
    });
    item.append(label, remove);
    list.append(item);
  }
}

function renderAnswer(result) {
  const container = $('answer');
  container.replaceChildren();
  const heading = document.createElement('h3');
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
  showSignedIn(session);
  $('password').value = '';
  setStatus(action === 'register' ? 'Vault created.' : 'Signed in.');
  await refreshDocuments();
}

function wire() {
  $('auth-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      await handleAuth('login');
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  $('register-button').addEventListener('click', async () => {
    try {
      await handleAuth('register');
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  $('logout-button').addEventListener('click', async () => {
    await api('/api/auth/logout', { method: 'POST' });
    showSignedOut();
    setStatus('Signed out.');
  });

  $('upload-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = new FormData();
    form.append('title', $('title').value);
    form.append('category', $('category').value);
    form.append('content', $('content').value);
    const file = $('file').files[0];
    if (file) {
      form.append('file', file);
    }
    try {
      await api('/api/documents', { method: 'POST', form });
      $('upload-form').reset();
      setStatus('Document stored and encrypted.');
      await refreshDocuments();
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  $('ask-form').addEventListener('submit', async (event) => {
    event.preventDefault();
    try {
      const result = await api('/api/ask', {
        method: 'POST',
        body: { question: $('question').value },
      });
      renderAnswer(result);
      setStatus('');
    } catch (error) {
      setStatus(error.message, true);
    }
  });

  $('export-button').addEventListener('click', async () => {
    const data = await api('/api/account/export');
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'baby-model-export.json';
    link.click();
    URL.revokeObjectURL(link.href);
    setStatus('Export downloaded.');
  });

  $('delete-account-button').addEventListener('click', async () => {
    if (!window.confirm('Permanently delete your account and every document?')) {
      return;
    }
    await api('/api/account', { method: 'DELETE' });
    showSignedOut();
    setStatus('Account and all documents erased.');
  });
}

async function boot() {
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
