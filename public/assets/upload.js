import {
  $,
  h,
  api,
  icon,
  t,
  show,
  initChrome,
  loadConfig,
  formatBytes,
  formatDuration,
  formatRemaining,
  fileBadge,
  errorMessage,
  copyButton,
  renderQr,
  getRecent,
  saveRecent,
  storageGet,
  storageSet,
  toast,
} from './common.js';

const UPLOAD_KEY_STORAGE = 'filedrop.uploadKey';
const DOWNLOAD_PRESETS = [1, 3, 10, 50, 100];

const state = {
  config: null,
  mode: 'files',
  files: [],
  expiry: 0,
  maxDownloads: 0,
  xhr: null,
  result: null,
  qrRendered: false,
};

const ui = {
  composer: $('#composer'),
  progress: $('#progress'),
  result: $('#result'),
  modeSwitch: $('#mode-switch'),
  filesPane: $('#files-pane'),
  linkPane: $('#link-pane'),
  dropzone: $('#dropzone'),
  dzTitle: $('#dz-title'),
  dzLimits: $('#dz-limits'),
  fileInput: $('#file-input'),
  fileList: $('#file-list'),
  listFoot: $('#list-foot'),
  filesSummary: $('#files-summary'),
  linkInput: $('#link-input'),
  expiryChips: $('#expiry-chips'),
  downloadChips: $('#download-chips'),
  downloadsLabel: $('#downloads-label'),
  passwordInput: $('#password-input'),
  togglePassword: $('#toggle-password'),
  uploadKeyField: $('#upload-key-field'),
  uploadKeyInput: $('#upload-key-input'),
  formError: $('#form-error'),
  formErrorText: $('#form-error-text'),
  submit: $('#submit-btn'),
  progressTitle: $('#progress-title'),
  progressPct: $('#progress-pct'),
  progressBar: $('#progress-bar'),
  progressBytes: $('#progress-bytes'),
  progressSpeed: $('#progress-speed'),
  cancel: $('#cancel-btn'),
  resultChips: $('#result-chips'),
  shareUrl: $('#share-url'),
  shareRow: $('#share-row'),
  manageUrl: $('#manage-url'),
  manageRow: $('#manage-row'),
  qrBox: $('#qr-box'),
  qr: $('#qr'),
  openDrop: $('#open-drop'),
  newDrop: $('#new-drop'),
  recent: $('#recent'),
  recentList: $('#recent-list'),
  clearRecent: $('#clear-recent'),
};

// ---------- views ----------

function setView(name) {
  show(ui.composer, name === 'composer');
  show(ui.progress, name === 'progress');
  show(ui.result, name === 'result');
}

function showError(message) {
  ui.formErrorText.textContent = message;
  show(ui.formError, true);
}

function hideError() {
  show(ui.formError, false);
}

// ---------- compose ----------

function totalSize() {
  return state.files.reduce((sum, f) => sum + f.size, 0);
}

function setMode(mode) {
  state.mode = mode;
  for (const btn of ui.modeSwitch.querySelectorAll('button')) btn.setAttribute('aria-pressed', String(btn.dataset.mode === mode));
  show(ui.filesPane, mode === 'files');
  show(ui.linkPane, mode === 'link');
  ui.downloadsLabel.dataset.i18n = mode === 'link' ? 'opt.opens' : 'opt.downloads';
  ui.downloadsLabel.textContent = t(ui.downloadsLabel.dataset.i18n);
  hideError();
}

function chip(label, pressed, onClick) {
  return h('button', { type: 'button', class: 'chip', 'aria-pressed': String(pressed), onClick }, label);
}

function renderOptions() {
  const { config } = state;
  ui.expiryChips.replaceChildren(
    ...config.expiryPresets.map((seconds) =>
      chip(formatDuration(seconds), seconds === state.expiry, () => {
        state.expiry = seconds;
        renderOptions();
      }),
    ),
  );

  const presets = DOWNLOAD_PRESETS.filter((n) => n <= config.maxDownloads);
  if (!presets.includes(config.maxDownloads) && !config.allowUnlimitedDownloads) presets.push(config.maxDownloads);
  if (config.allowUnlimitedDownloads) presets.push(0);
  ui.downloadChips.replaceChildren(
    ...presets.map((n) =>
      chip(n === 0 ? t('opt.unlimited') : String(n), n === state.maxDownloads, () => {
        state.maxDownloads = n;
        renderOptions();
      }),
    ),
  );
}

function renderFiles() {
  const { config } = state;
  const count = state.files.length;
  ui.fileList.replaceChildren(
    ...state.files.map((file, index) =>
      h(
        'li',
        { class: 'file' },
        fileBadge(file.name),
        h('div', { class: 'file-main' }, h('span', { class: 'file-name', title: file.name, text: file.name }), h('span', { class: 'file-size', text: formatBytes(file.size) })),
        h(
          'button',
          {
            type: 'button',
            class: 'icon-btn',
            'aria-label': t('files.remove', { name: file.name }),
            onClick: () => {
              state.files.splice(index, 1);
              renderFiles();
            },
          },
          icon('x'),
        ),
      ),
    ),
  );
  ui.fileList.classList.toggle('scroll', count > 5);
  ui.dropzone.classList.toggle('compact', count > 0);
  ui.dzTitle.textContent = t(count ? 'dz.titleMore' : 'dz.title');
  ui.dzLimits.textContent = t('dz.limits', { size: formatBytes(config.maxUploadSize), count: config.maxFiles });
  show(ui.listFoot, count > 0);
  ui.filesSummary.textContent = `${t('files.count', { count })} · ${formatBytes(totalSize())}`;

  if (totalSize() > config.maxUploadSize) showError(errorMessage('too_large', config));
  else if (ui.formErrorText.dataset.kind !== 'server') hideError();
}

function addFiles(list) {
  const { config } = state;
  const incoming = [...list].filter((f) => f instanceof File);
  if (!incoming.length) return;
  let skipped = 0;
  for (const file of incoming) {
    const duplicate = state.files.some((f) => f.name === file.name && f.size === file.size && f.lastModified === file.lastModified);
    if (duplicate) continue;
    if (state.files.length >= config.maxFiles) {
      skipped += 1;
      continue;
    }
    state.files.push(file);
  }
  if (skipped) toast(errorMessage('too_many_files', config), 'error');
  if (state.mode !== 'files') setMode('files');
  ui.formErrorText.dataset.kind = '';
  renderFiles();
}

/** Collects dropped files, skipping folders (they arrive as unreadable pseudo-files). */
function filesFromDrop(dataTransfer) {
  const items = [...(dataTransfer.items || [])];
  if (!items.length) return [...dataTransfer.files];
  const files = [];
  let folders = 0;
  for (const item of items) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry?.isDirectory) {
      folders += 1;
      continue;
    }
    const file = item.getAsFile();
    if (file) files.push(file);
  }
  if (folders) toast(t('err.empty_upload'), 'error');
  return files;
}

function setupDragAndDrop() {
  let depth = 0;
  const active = () => !ui.composer.hidden && state.mode === 'files';
  const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');

  window.addEventListener('dragenter', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    if (active()) ui.dropzone.classList.add('dragging');
  });
  window.addEventListener('dragleave', () => {
    depth = Math.max(0, depth - 1);
    if (!depth) ui.dropzone.classList.remove('dragging');
  });
  window.addEventListener('dragover', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = active() ? 'copy' : 'none';
  });
  window.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); // never let the browser navigate to a dropped file
    depth = 0;
    ui.dropzone.classList.remove('dragging');
    if (!ui.composer.hidden) addFiles(filesFromDrop(e.dataTransfer));
  });

  ui.dropzone.addEventListener('click', () => ui.fileInput.click());
  ui.dropzone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      ui.fileInput.click();
    }
  });
  ui.fileInput.addEventListener('change', () => {
    addFiles(ui.fileInput.files);
    ui.fileInput.value = '';
  });
  window.addEventListener('paste', (e) => {
    if (ui.composer.hidden) return;
    const files = [...(e.clipboardData?.files || [])];
    if (files.length) {
      e.preventDefault();
      addFiles(files);
    }
  });
}

// ---------- upload ----------

function validLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

async function submit() {
  const { config } = state;
  hideError();
  ui.formErrorText.dataset.kind = '';

  const form = new FormData();
  form.append('type', state.mode);
  form.append('expiresIn', String(state.expiry));
  form.append('maxDownloads', String(state.maxDownloads));
  const password = ui.passwordInput.value;
  if (password) form.append('password', password);

  if (state.mode === 'files') {
    if (!state.files.length) return showError(t('err.no_files'));
    if (totalSize() > config.maxUploadSize) return showError(errorMessage('too_large', config));
  } else {
    let link = ui.linkInput.value.trim();
    if (link && !/^[a-z][a-z0-9+.-]*:/i.test(link)) link = `https://${link}`;
    if (!validLink(link)) {
      ui.linkInput.focus();
      return showError(t('err.invalid_url'));
    }
    form.append('url', link);
  }

  let uploadKey = '';
  if (config.uploadKeyRequired) {
    uploadKey = ui.uploadKeyInput.value;
    if (!uploadKey) {
      ui.uploadKeyInput.focus();
      return showError(t('err.upload_key_invalid'));
    }
    // Check the key first, so a typo does not cost a full upload.
    ui.submit.disabled = true;
    try {
      await api('/api/upload-key', { method: 'POST', json: {}, headers: { 'X-Upload-Key': uploadKey } });
    } catch (err) {
      ui.formErrorText.dataset.kind = 'server';
      showError(errorMessage(err.code, config));
      if (err.code === 'upload_key_invalid') ui.uploadKeyInput.select();
      return;
    } finally {
      ui.submit.disabled = false;
    }
  }
  // Files last: the server can validate all options before the (possibly large) file data arrives.
  if (state.mode === 'files') for (const file of state.files) form.append('files', file, file.name);

  upload(form, uploadKey);
}

function upload(form, uploadKey) {
  const xhr = new XMLHttpRequest();
  state.xhr = xhr;
  xhr.open('POST', '/api/drops');
  xhr.responseType = 'json';
  xhr.setRequestHeader('Accept', 'application/json');
  if (uploadKey) xhr.setRequestHeader('X-Upload-Key', uploadKey);

  const samples = [];
  const isFiles = state.mode === 'files';

  xhr.upload.addEventListener('progress', (e) => {
    if (!e.lengthComputable) return;
    const now = performance.now();
    samples.push({ now, loaded: e.loaded });
    while (samples.length > 2 && now - samples[0].now > 4000) samples.shift();
    const first = samples[0];
    const speed = now > first.now ? ((e.loaded - first.loaded) / (now - first.now)) * 1000 : 0;
    const pct = Math.min(100, Math.floor((e.loaded / e.total) * 100));
    ui.progressPct.textContent = `${pct}%`;
    ui.progressBar.style.width = `${pct}%`;
    ui.progressBytes.textContent = t('up.of', { done: formatBytes(e.loaded), total: formatBytes(e.total) });
    ui.progressSpeed.textContent =
      speed > 0 && e.loaded < e.total ? `${formatBytes(speed)}/s · ${t('up.left', { time: formatRemaining(((e.total - e.loaded) / speed) * 1000) })}` : '';
  });
  xhr.upload.addEventListener('load', () => {
    ui.progressTitle.textContent = t('up.finishing');
    ui.progressPct.textContent = '100%';
    ui.progressBar.style.width = '100%';
    ui.progressSpeed.textContent = '';
  });

  const finish = (error) => {
    state.xhr = null;
    ui.submit.disabled = false;
    if (!error) return;
    setView('composer');
    if (error === 'cancelled') return toast(t('err.cancelled'), 'error');
    ui.formErrorText.dataset.kind = 'server';
    showError(errorMessage(error, state.config));
    if (error === 'upload_key_invalid') {
      storageSet(UPLOAD_KEY_STORAGE, null);
      ui.uploadKeyInput.focus();
    }
  };

  xhr.addEventListener('load', () => {
    if (xhr.status === 201 && xhr.response?.id) {
      finish();
      if (state.config.uploadKeyRequired) storageSet(UPLOAD_KEY_STORAGE, ui.uploadKeyInput.value);
      showResult(xhr.response);
    } else {
      finish(xhr.response?.error || (xhr.status === 413 ? 'too_large' : `http_${xhr.status}`));
    }
  });
  xhr.addEventListener('error', () => finish('network'));
  xhr.addEventListener('abort', () => finish('cancelled'));

  ui.submit.disabled = true;
  if (isFiles) {
    ui.progressTitle.textContent = t('up.title');
    ui.progressPct.textContent = '0%';
    ui.progressBar.style.width = '0%';
    ui.progressBytes.textContent = '';
    ui.progressSpeed.textContent = '';
    setView('progress');
  }
  xhr.send(form);
}

// ---------- result ----------

function resultChips(drop) {
  const chips = [
    h('span', { class: 'meta-chip' }, icon('clock'), t('chip.expiresIn', { time: formatRemaining(drop.expiresAt - drop.now) })),
    h(
      'span',
      { class: 'meta-chip' },
      icon('download'),
      drop.maxDownloads
        ? t(drop.type === 'link' ? 'chip.opens' : 'chip.downloads', { count: drop.maxDownloads })
        : t('chip.unlimited'),
    ),
  ];
  if (drop.protected) chips.push(h('span', { class: 'meta-chip accent' }, icon('lock'), t('chip.protected')));
  return chips;
}

function renderResult() {
  const drop = state.result;
  if (!drop) return;
  ui.resultChips.replaceChildren(...resultChips(drop));
  ui.shareUrl.value = drop.url;
  ui.manageUrl.value = drop.manageUrl;
  ui.openDrop.href = drop.url;

  const qrBtn = h('button', { type: 'button', class: 'btn btn-sm', 'aria-expanded': String(!ui.qrBox.hidden) }, icon('qr'), h('span', { text: t('btn.qr') }));
  qrBtn.addEventListener('click', async () => {
    const open = ui.qrBox.hidden;
    show(ui.qrBox, open);
    qrBtn.setAttribute('aria-expanded', String(open));
    if (open && !state.qrRendered) {
      await renderQr(ui.qr, drop.url);
      state.qrRendered = true;
    }
  });
  ui.shareRow.replaceChildren(ui.shareUrl, copyButton(() => drop.url, { className: 'btn btn-sm btn-primary' }), qrBtn);
  ui.manageRow.replaceChildren(ui.manageUrl, copyButton(() => drop.manageUrl));
}

function showResult(drop) {
  const title =
    drop.type === 'link'
      ? new URL(ui.linkInput.value.includes('://') ? ui.linkInput.value.trim() : `https://${ui.linkInput.value.trim()}`).host
      : state.files.length > 1
        ? `${state.files[0].name} +${state.files.length - 1}`
        : state.files[0].name;

  state.result = drop;
  state.qrRendered = false;
  show(ui.qrBox, false);
  ui.qr.replaceChildren();
  renderResult();
  setView('result');
  ui.result.scrollIntoView({ behavior: 'smooth', block: 'start' });

  const recent = getRecent().filter((d) => d.id !== drop.id);
  recent.unshift({
    id: drop.id,
    type: drop.type,
    title,
    size: drop.totalSize,
    url: drop.url,
    manageUrl: drop.manageUrl,
    expiresAt: drop.expiresAt,
    createdAt: Date.now(),
  });
  saveRecent(recent);
  renderRecent();

  // reset the composer for the next drop
  state.files = [];
  ui.passwordInput.value = '';
  ui.linkInput.value = '';
  renderFiles();
}

// ---------- recent drops ----------

function renderRecent() {
  const now = Date.now();
  const list = getRecent().filter((d) => d.expiresAt > now);
  saveRecent(list);
  show(ui.recent, list.length > 0);
  ui.recentList.replaceChildren(
    ...list.map((d) =>
      h(
        'li',
        { class: 'recent-item' },
        d.type === 'link' ? h('span', { class: 'ext', 'data-kind': 'code', 'aria-hidden': 'true' }, icon('link')) : fileBadge(d.title || ''),
        h(
          'div',
          { class: 'file-main' },
          h('a', { class: 'file-name', href: d.url, target: '_blank', rel: 'noopener', text: d.title || d.id }),
          h('span', {
            class: 'file-size',
            text: [d.type === 'files' ? formatBytes(d.size) : null, t('chip.expiresIn', { time: formatRemaining(d.expiresAt - now) })]
              .filter(Boolean)
              .join(' · '),
          }),
        ),
        h('a', { class: 'ghost-btn', href: d.manageUrl, target: '_blank', rel: 'noopener' }, icon('settings'), h('span', { class: 'label', text: t('recent.manage') })),
      ),
    ),
  );
}

// ---------- boot ----------

async function main() {
  const config = await loadConfig();
  initChrome(config);
  if (!config) {
    showError(t('err.network'));
    ui.submit.disabled = true;
    return;
  }
  state.config = config;
  document.title = config.siteName;
  state.expiry = config.expiryPresets.includes(config.defaultExpiry) ? config.defaultExpiry : config.expiryPresets[0];
  state.maxDownloads = config.allowUnlimitedDownloads ? 0 : 1;

  if (!config.allowLinks) show(ui.modeSwitch, false);
  if (config.uploadKeyRequired) {
    show(ui.uploadKeyField, true);
    ui.uploadKeyInput.value = storageGet(UPLOAD_KEY_STORAGE) || '';
  }

  for (const btn of ui.modeSwitch.querySelectorAll('button')) {
    btn.addEventListener('click', () => {
      setMode(btn.dataset.mode);
      if (state.mode === 'link') ui.linkInput.focus();
    });
  }
  ui.togglePassword.addEventListener('click', () => {
    const visible = ui.passwordInput.type === 'text';
    ui.passwordInput.type = visible ? 'password' : 'text';
    ui.togglePassword.replaceChildren(icon(visible ? 'eye' : 'eyeOff'));
    ui.togglePassword.dataset.i18nAriaLabel = visible ? 'opt.showPassword' : 'opt.hidePassword';
    ui.togglePassword.setAttribute('aria-label', t(ui.togglePassword.dataset.i18nAriaLabel));
  });
  $('#clear-files').addEventListener('click', () => {
    state.files = [];
    renderFiles();
  });
  ui.submit.addEventListener('click', submit);
  ui.linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit();
  });
  ui.cancel.addEventListener('click', () => state.xhr?.abort());
  ui.newDrop.addEventListener('click', () => {
    state.result = null;
    setView('composer');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });
  ui.clearRecent.addEventListener('click', () => {
    saveRecent([]);
    renderRecent();
  });
  window.addEventListener('beforeunload', (e) => {
    if (state.xhr) e.preventDefault();
  });
  window.addEventListener('langchange', () => {
    renderOptions();
    renderFiles();
    renderRecent();
    renderResult();
    setMode(state.mode);
  });
  setupDragAndDrop();

  renderOptions();
  renderFiles();
  renderRecent();
  setInterval(renderRecent, 30_000);
}

main();
