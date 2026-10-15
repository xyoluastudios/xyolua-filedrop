import {
  $,
  h,
  icon,
  t,
  api,
  initChrome,
  loadConfig,
  formatBytes,
  formatRemaining,
  fileBadge,
  errorMessage,
  copyButton,
  renderQr,
  forgetRecent,
  toast,
} from './common.js';

const id = location.pathname.split('/').filter(Boolean).pop();
const ownerKey = new URLSearchParams(location.hash.slice(1)).get('owner') || '';
const shareUrl = `${location.origin}/d/${id}`;

const state = {
  config: null,
  view: 'loading', // loading | locked | files | link | gone | error
  goneReason: 'gone', // gone | deleted | last
  drop: null,
  error: '',
  clockOffset: 0, // server time minus local time, so countdowns survive a wrong local clock
  timer: null,
  refreshTimer: null,
};

const card = $('#view');

// ---------- data ----------

const ownerHeaders = () => (ownerKey ? { 'X-Owner-Key': ownerKey } : {});

async function fetchDrop() {
  if (ownerKey) {
    // Unlocking with the owner key also sets the access cookie for password-protected drops.
    try {
      return await api(`/api/drops/${id}/unlock`, { method: 'POST', json: {}, headers: ownerHeaders() });
    } catch (err) {
      if (err.status === 404) throw err;
      // wrong owner key: continue as a normal visitor
    }
  }
  return api(`/api/drops/${id}`);
}

function applyDrop(drop) {
  state.drop = drop;
  if (drop.now) state.clockOffset = drop.now - Date.now();
  state.view = drop.type === 'link' ? 'link' : 'files';
}

function handleLoadError(err) {
  if (err.code === 'locked') {
    state.view = 'locked';
  } else if (err.status === 404) {
    goGone('gone');
    return;
  } else {
    state.view = 'error';
    state.error = err.code;
  }
  render();
}

function goGone(reason) {
  state.view = 'gone';
  state.goneReason = reason;
  forgetRecent(id);
  render();
}

async function load() {
  try {
    applyDrop(await fetchDrop());
    render();
  } catch (err) {
    handleLoadError(err);
  }
}

/** After a download starts, refresh the counters; the drop may be used up now. */
function refreshSoon() {
  clearTimeout(state.refreshTimer);
  state.refreshTimer = setTimeout(async () => {
    try {
      applyDrop(await api(`/api/drops/${id}`, { headers: ownerHeaders() }));
      render();
    } catch (err) {
      if (err.status === 404) goGone('last');
    }
  }, 1500);
}

// ---------- building blocks ----------

function statusIcon(name, variant = '') {
  return h('div', { class: `status-icon ${variant}` }, icon(name));
}

function countdownChip(drop) {
  const text = h('span');
  const chip = h('span', { class: 'meta-chip' }, icon('clock'), text);
  const update = () => {
    const left = drop.expiresAt - (Date.now() + state.clockOffset);
    if (left <= 0) {
      clearInterval(state.timer);
      setTimeout(() => goGone('gone')); // not during render()
      return;
    }
    text.textContent = t('chip.expiresIn', { time: formatRemaining(left) });
    chip.classList.toggle('warn', left < 3600_000);
  };
  update();
  state.timer = setInterval(update, 1000);
  return chip;
}

function metaChips(drop) {
  const chips = [countdownChip(drop)];
  const isLink = drop.type === 'link';
  if (drop.owner) {
    chips.push(
      h(
        'span',
        { class: 'meta-chip' },
        icon('download'),
        drop.maxDownloads ? t('chip.used', { count: drop.downloads, max: drop.maxDownloads }) : t('chip.usedUnlimited', { count: drop.downloads }),
      ),
    );
  } else if (drop.maxDownloads) {
    const key = isLink ? 'chip.opensLeft' : 'chip.left';
    chips.push(h('span', { class: `meta-chip ${drop.remaining === 1 ? 'warn' : ''}` }, icon('download'), t(key, { count: drop.remaining })));
  }
  if (drop.protected) chips.push(h('span', { class: 'meta-chip accent' }, icon('lock'), t('chip.protected')));
  return h('div', { class: 'meta-chips' }, chips);
}

function ownerBar() {
  return h('div', { class: 'owner-bar' }, icon('settings'), h('strong', { text: t('owner.title') }));
}

function ownerPanel(drop) {
  const qrBox = h('div', { class: 'qr-box', hidden: true }, h('div', { class: 'qr' }));
  let qrDone = false;
  const qrBtn = h('button', { type: 'button', class: 'btn btn-sm', 'aria-expanded': 'false' }, icon('qr'), h('span', { text: t('btn.qr') }));
  qrBtn.addEventListener('click', async () => {
    qrBox.hidden = !qrBox.hidden;
    qrBtn.setAttribute('aria-expanded', String(!qrBox.hidden));
    if (!qrBox.hidden && !qrDone) {
      await renderQr(qrBox.firstChild, shareUrl);
      qrDone = true;
    }
  });

  const label = h('span', { text: t('btn.delete') });
  const del = h('button', { type: 'button', class: 'btn btn-danger btn-block' }, icon('trash'), label);
  let armed = null;
  del.addEventListener('click', async () => {
    if (!armed) {
      del.classList.add('confirm');
      label.textContent = t('btn.confirmDelete');
      armed = setTimeout(() => {
        armed = null;
        del.classList.remove('confirm');
        label.textContent = t('btn.delete');
      }, 4000);
      return;
    }
    clearTimeout(armed);
    del.disabled = true;
    try {
      await api(`/api/drops/${id}`, { method: 'DELETE', headers: ownerHeaders() });
      goGone('deleted');
    } catch (err) {
      if (err.status === 404) return goGone('gone');
      del.disabled = false;
      toast(errorMessage(err.code, state.config), 'error');
    }
  });

  return [
    h('div', { class: 'divider' }),
    h('div', { class: 'field-label' }, icon('link'), h('span', { text: t('done.share') })),
    h('div', { class: 'copy-row' }, h('input', { class: 'input mono', readonly: true, value: shareUrl }), copyButton(() => shareUrl, { className: 'btn btn-sm btn-primary' }), qrBtn),
    qrBox,
    drop.type === 'files' && drop.maxDownloads ? h('p', { class: 'hint', text: t('owner.note') }) : null,
    h('div', { class: 'divider' }),
    del,
  ];
}

// ---------- views ----------

function loadingView() {
  return [h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' }), h('div', { class: 'skeleton' })];
}

function lockedView() {
  const input = h('input', {
    class: 'input',
    type: 'password',
    autocomplete: 'current-password',
    maxlength: '256',
    placeholder: t('locked.placeholder'),
    'aria-label': t('locked.placeholder'),
  });
  const eye = h('button', { type: 'button', class: 'icon-btn', 'aria-label': t('opt.showPassword') }, icon('eye'));
  eye.addEventListener('click', () => {
    const visible = input.type === 'text';
    input.type = visible ? 'password' : 'text';
    eye.replaceChildren(icon(visible ? 'eye' : 'eyeOff'));
    eye.setAttribute('aria-label', t(visible ? 'opt.showPassword' : 'opt.hidePassword'));
  });
  const button = h('button', { type: 'submit', class: 'btn btn-primary' }, icon('lock'), h('span', { text: t('btn.unlock') }));
  const errorText = h('span');
  const error = h('div', { class: 'form-error', role: 'alert', hidden: true }, icon('alert'), errorText);

  const form = h('form', { class: 'form-row', novalidate: true }, h('div', { class: 'input-wrap' }, input, eye), button);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    if (!input.value) return input.focus();
    button.disabled = true;
    try {
      applyDrop(await api(`/api/drops/${id}/unlock`, { method: 'POST', json: { password: input.value } }));
      render();
    } catch (err) {
      button.disabled = false;
      if (err.status === 404) return goGone('gone');
      errorText.textContent = errorMessage(err.code, state.config);
      error.hidden = false;
      form.classList.remove('shake');
      void form.offsetWidth; // restart the animation
      form.classList.add('shake');
      input.select();
    }
  });
  setTimeout(() => input.focus(), 50);

  return [
    statusIcon('lock', 'lock'),
    h('h1', { class: 'panel-title', text: t('locked.title') }),
    h('p', { class: 'panel-sub', text: t('locked.sub') }),
    form,
    h('div', { class: 'form-row' }, error),
  ];
}

function filesView() {
  const drop = state.drop;
  const count = drop.files.length;
  const single = count === 1;

  const fileRows = drop.files.map((file) => {
    const download = h(
      'a',
      { class: single ? 'icon-btn' : 'btn btn-sm', href: `/api/drops/${id}/files/${file.index}`, download: '', 'aria-label': `${t('btn.download')}: ${file.name}` },
      icon('download'),
      single ? null : h('span', { class: 'label', text: t('btn.download') }),
    );
    download.addEventListener('click', refreshSoon);
    return h(
      'li',
      { class: 'file' },
      fileBadge(file.name),
      h('div', { class: 'file-main' }, h('span', { class: 'file-name', title: file.name, text: file.name }), h('span', { class: 'file-size', text: formatBytes(file.size) })),
      download,
    );
  });

  let primary = null;
  if (single) {
    primary = h('a', { class: 'btn btn-primary btn-block', href: `/api/drops/${id}/files/0`, download: '' }, icon('download'), h('span', { text: t('btn.download') }));
  } else if (drop.zip) {
    primary = h('a', { class: 'btn btn-primary btn-block', href: `/api/drops/${id}/zip`, download: '' }, icon('download'), h('span', { text: t('btn.zip') }));
  }
  primary?.addEventListener('click', refreshSoon);

  return [
    drop.owner ? ownerBar() : null,
    h(
      'div',
      { class: 'drop-head' },
      statusIcon(single ? 'file' : 'files', 'lock'),
      h(
        'div',
        {},
        h('h1', { text: drop.owner ? t('drop.yours') : t('drop.files', { count }) }),
        h('p', { text: `${t('files.count', { count })} · ${formatBytes(drop.totalSize)}` }),
      ),
    ),
    metaChips(drop),
    h('ul', { class: `file-list ${count > 6 ? 'scroll' : ''}` }, fileRows),
    primary ? h('div', { class: 'submit-row' }, primary) : null,
    drop.maxDownloads && !drop.owner ? h('p', { class: 'hint center', text: t('drop.countNote') }) : null,
    ...(drop.owner ? ownerPanel(drop) : []),
  ];
}

function linkView() {
  const drop = state.drop;
  const nodes = [drop.owner ? ownerBar() : null];

  const dest = h(
    'div',
    { class: 'dest' },
    icon('globe'),
    h('div', { class: 'file-main' }, h('span', { class: 'dest-label', text: t('link.dest') }), h('span', { class: 'dest-host', text: drop.owner ? drop.url : drop.linkHost })),
  );

  let action;
  if (drop.owner) {
    action = h('a', { class: 'btn btn-block', href: drop.url, target: '_blank', rel: 'noopener noreferrer' }, icon('external'), h('span', { text: t('btn.openLink') }));
  } else {
    action = h('button', { type: 'button', class: 'btn btn-primary btn-block' }, icon('external'), h('span', { text: t('btn.openLink') }));
    action.addEventListener('click', async () => {
      action.disabled = true;
      try {
        const { url } = await api(`/api/drops/${id}/open`, { method: 'POST', json: {} });
        if (/^https?:\/\//i.test(url)) location.href = url;
      } catch (err) {
        action.disabled = false;
        if (err.status === 404) return goGone('gone');
        toast(errorMessage(err.code, state.config), 'error');
      }
    });
  }

  nodes.push(
    h(
      'div',
      { class: 'center' },
      statusIcon('link', 'link'),
      h('h1', { class: 'panel-title', text: drop.owner ? t('drop.yours') : t('link.title') }),
      dest,
      metaChips(drop),
      drop.owner ? null : h('p', { class: 'hint', text: t('link.warn') }),
    ),
    h('div', { class: 'submit-row' }, action),
    ...(drop.owner ? ownerPanel(drop) : []),
  );
  return nodes;
}

const GONE_VARIANTS = {
  gone: ['hourglass', 'gone.title', 'gone.sub'],
  deleted: ['trash', 'deleted.title', 'deleted.sub'],
  last: ['check', 'last.title', 'last.sub'],
};

function goneView() {
  const [iconName, title, sub] = GONE_VARIANTS[state.goneReason] || GONE_VARIANTS.gone;
  return [
    statusIcon(iconName, state.goneReason === 'last' ? '' : 'gone'),
    h('h1', { class: 'panel-title', text: t(title) }),
    h('p', { class: 'panel-sub', text: t(sub) }),
    h('a', { class: 'btn btn-primary', href: '/' }, icon('plus'), h('span', { text: t('btn.home') })),
  ];
}

function errorView() {
  const retry = h('button', { type: 'button', class: 'btn' }, h('span', { text: t('btn.retry') }));
  retry.addEventListener('click', () => {
    state.view = 'loading';
    render();
    load();
  });
  return [statusIcon('alert', 'gone'), h('p', { class: 'panel-sub', text: errorMessage(state.error, state.config) }), retry];
}

const VIEWS = { loading: loadingView, locked: lockedView, files: filesView, link: linkView, gone: goneView, error: errorView };
const CENTERED = new Set(['locked', 'gone', 'error']);

function render() {
  clearInterval(state.timer);
  card.className = `card${CENTERED.has(state.view) ? ' center' : ''}`;
  card.replaceChildren(...VIEWS[state.view]().flat().filter(Boolean));

  const site = state.config?.siteName || 'XyoLua FileDrop';
  const titles = {
    locked: t('locked.title'),
    files: state.drop?.owner ? t('drop.yours') : t('drop.files', { count: state.drop?.files?.length ?? 0 }),
    link: t('link.title'),
    gone: t((GONE_VARIANTS[state.goneReason] || GONE_VARIANTS.gone)[1]),
  };
  document.title = titles[state.view] ? `${titles[state.view]} · ${site}` : site;
}

// ---------- boot ----------

state.config = await loadConfig();
initChrome(state.config);
window.addEventListener('langchange', render);
if (!/^[A-Za-z0-9]{8,32}$/.test(id || '')) goGone('gone');
else load();
