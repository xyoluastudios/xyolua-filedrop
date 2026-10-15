// Shared helpers for all pages: i18n, icons, formatting, API access, small UI utilities.
import { LANGUAGES } from './i18n.js';

// ---------- storage (may be unavailable in private mode) ----------

export function storageGet(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

export function storageSet(key, value) {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // ignore
  }
}

// ---------- i18n ----------

const LANG_KEY = 'filedrop.lang';

function detectLang() {
  const saved = storageGet(LANG_KEY);
  if (saved && LANGUAGES[saved]) return saved;
  for (const candidate of navigator.languages || [navigator.language]) {
    const base = String(candidate || '').slice(0, 2).toLowerCase();
    if (LANGUAGES[base]) return base;
  }
  return 'en';
}

export let lang = detectLang();

function formatNumber(n) {
  return new Intl.NumberFormat(lang).format(n);
}

/** Translates `key`. {placeholders} are replaced from `vars`; `count === 1` selects the ".one" variant. */
export function t(key, vars = {}) {
  const dict = LANGUAGES[lang] || LANGUAGES.en;
  const singular = `${key}.one`;
  const useSingular = vars.count === 1 && (dict[singular] ?? LANGUAGES.en[singular]) !== undefined;
  const k = useSingular ? singular : key;
  const template = dict[k] ?? LANGUAGES.en[k] ?? key;
  return template.replace(/\{(\w+)\}/g, (match, name) => {
    if (!(name in vars)) return match;
    const value = vars[name];
    return typeof value === 'number' ? formatNumber(value) : String(value);
  });
}

export function applyI18n(root = document) {
  document.documentElement.lang = lang;
  for (const el of root.querySelectorAll('[data-i18n]')) el.textContent = t(el.dataset.i18n);
  for (const attr of ['placeholder', 'title', 'aria-label']) {
    for (const el of root.querySelectorAll(`[data-i18n-${attr}]`)) el.setAttribute(attr, t(el.getAttribute(`data-i18n-${attr}`)));
  }
}

export function setLang(next) {
  if (!LANGUAGES[next] || next === lang) return;
  lang = next;
  storageSet(LANG_KEY, next);
  applyI18n();
  window.dispatchEvent(new CustomEvent('langchange'));
}

// ---------- icons (inline SVG, 24x24 stroke) ----------

const ICONS = {
  upload: '<path d="M12 15V3m0 0L7.5 7.5M12 3l4.5 4.5"/><path d="M4 15v3a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-3"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
  files: '<path d="M15 3H9a2 2 0 0 0-2 2v11a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2V7z"/><path d="M15 3v4h4"/><path d="M4 8v11a2 2 0 0 0 2 2h9"/>',
  link: '<path d="M10 13.5a4.5 4.5 0 0 0 6.36 0l3-3a4.5 4.5 0 0 0-6.36-6.36l-1.25 1.25"/><path d="M14 10.5a4.5 4.5 0 0 0-6.36 0l-3 3a4.5 4.5 0 0 0 6.36 6.36l1.25-1.25"/>',
  x: '<path d="M18 6 6 18M6 6l12 12"/>',
  lock: '<rect x="4.5" y="10.5" width="15" height="10.5" rx="2.5"/><path d="M8 10.5V7a4 4 0 0 1 8 0v3.5"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3.2 2"/>',
  download: '<path d="M12 3v12m0 0-4.5-4.5M12 15l4.5-4.5"/><path d="M4 17v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1"/>',
  copy: '<rect x="8.5" y="8.5" width="12" height="12" rx="2.5"/><path d="M15.5 8.5V6A2.5 2.5 0 0 0 13 3.5H6A2.5 2.5 0 0 0 3.5 6v7A2.5 2.5 0 0 0 6 15.5h2.5"/>',
  check: '<path d="M20 6 9 17l-5-5"/>',
  trash: '<path d="M4 7h16"/><path d="M10 11v6M14 11v6"/><path d="m6 7 1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12"/><path d="M9 7V4.5A1.5 1.5 0 0 1 10.5 3h3A1.5 1.5 0 0 1 15 4.5V7"/>',
  eye: '<path d="M2.5 12S6 5 12 5s9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7z"/><circle cx="12" cy="12" r="3"/>',
  eyeOff: '<path d="m3 3 18 18"/><path d="M10.6 5.1A9.9 9.9 0 0 1 12 5c6 0 9.5 7 9.5 7a17 17 0 0 1-2.6 3.5M6.6 6.6C3.9 8.3 2.5 12 2.5 12S6 19 12 19a9.6 9.6 0 0 0 4.4-1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  qr: '<rect x="3.5" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="14" y="3.5" width="6.5" height="6.5" rx="1.2"/><rect x="3.5" y="14" width="6.5" height="6.5" rx="1.2"/><path d="M14 14h2.5v2.5H14zM18 18h2.5v2.5H18zM14 18.5v2M18.5 14h2"/>',
  shield: '<path d="M12 3 4.5 6v5.5c0 4.6 3.2 8.4 7.5 9.5 4.3-1.1 7.5-4.9 7.5-9.5V6z"/><path d="m9 12 2 2 4-4"/>',
  flame: '<path d="M12 21c-3.9 0-7-2.9-7-6.8 0-3.2 2.1-5.3 3.7-7.1.5 1.9 1.7 3 2.8 3.4C11.2 7.1 12.4 4.6 15 3c-.3 2.6.8 4.5 2.1 6.1 1.2 1.5 1.9 3.2 1.9 5.1C19 18.1 15.9 21 12 21z"/>',
  gauge: '<path d="m12 14 4-4"/><path d="M3.5 17a9 9 0 1 1 17 0"/>',
  code: '<path d="m8 8-5 4 5 4M16 8l5 4-5 4M14 4l-4 16"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 3.8 5.6 3.8 9s-1.3 6.4-3.8 9c-2.5-2.6-3.8-5.6-3.8-9S9.5 5.6 12 3z"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9"/><path d="M18 14v4a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4"/>',
  alert: '<path d="M12 9v4m0 3.5v.01"/><path d="M10.3 4.2 2.6 17.5a2 2 0 0 0 1.7 3h15.4a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0z"/>',
  key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 9-9M17 6l3 3M15 8l2 2"/>',
  settings: '<path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="16" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/>',
  arrowRight: '<path d="M5 12h14M13 6l6 6-6 6"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  hourglass: '<path d="M6 3h12M6 21h12"/><path d="M7 3v3a5 5 0 0 0 10 0V3M7 21v-3a5 5 0 0 1 10 0v3"/>',
};

export function icon(name) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('class', 'i');
  svg.setAttribute('aria-hidden', 'true');
  svg.innerHTML = ICONS[name] || '';
  return svg;
}

/** Replaces every <span data-icon="name"> placeholder with its SVG icon. */
export function hydrateIcons(root = document) {
  for (const el of root.querySelectorAll('[data-icon]')) el.replaceWith(icon(el.dataset.icon));
}

// ---------- DOM ----------

export const $ = (selector, root = document) => root.querySelector(selector);

/** Small element factory. Text is always inserted as text, never as HTML. */
export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key === 'text') el.textContent = value;
    else if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2).toLowerCase(), value);
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) {
    if (child !== null && child !== undefined && child !== false) el.append(child instanceof Node ? child : String(child));
  }
  return el;
}

export function show(el, visible = true) {
  el.hidden = !visible;
}

// ---------- formatting ----------

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return '–';
  if (bytes < 1024) return `${formatNumber(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let i = -1;
  do {
    value /= 1024;
    i += 1;
  } while (value >= 1024 && i < units.length - 1);
  const digits = value < 10 ? 1 : 0;
  return `${new Intl.NumberFormat(lang, { maximumFractionDigits: digits, minimumFractionDigits: digits }).format(value)} ${units[i]}`;
}

/** Preset durations: 600 -> "10 minutes", 86400 -> "1 day". */
export function formatDuration(seconds) {
  const units = [
    ['w', 604800],
    ['d', 86400],
    ['h', 3600],
  ];
  for (const [unit, size] of units) {
    if (seconds >= size && seconds % size === 0) return t(`dur.${unit}`, { count: seconds / size });
  }
  return t('dur.m', { count: Math.max(1, Math.round(seconds / 60)) });
}

/** Compact remaining time: "2d 4h", "3h 12m", "4m 10s". */
export function formatRemaining(ms) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(total / 86400);
  const hours = Math.floor((total % 86400) / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const part = (unit, count) => t(`short.${unit}`, { count });
  if (d) return [part('d', d), hours ? part('h', hours) : null].filter(Boolean).join(' ');
  if (hours) return [part('h', hours), m ? part('m', m) : null].filter(Boolean).join(' ');
  if (m) return [part('m', m), m < 10 && s ? part('s', s) : null].filter(Boolean).join(' ');
  return part('s', s);
}

const KINDS = {
  image: 'png jpg jpeg gif webp avif svg heic heif bmp tif tiff ico psd',
  video: 'mp4 mov mkv webm avi m4v wmv flv',
  audio: 'mp3 wav flac ogg m4a aac opus wma',
  archive: 'zip rar 7z tar gz tgz bz2 xz zst iso dmg rbxl rbxm',
  doc: 'pdf doc docx odt rtf txt md pages epub ppt pptx key odp',
  sheet: 'xls xlsx csv ods numbers tsv',
  code: 'js mjs ts jsx tsx json html css py lua luau java c cpp h cs go rs rb php sh ps1 yml yaml xml sql toml ini',
};

export function fileBadge(name) {
  const dot = name.lastIndexOf('.');
  const ext = dot > 0 && name.length - dot <= 6 ? name.slice(dot + 1).toLowerCase() : '';
  let kind = 'other';
  for (const [k, list] of Object.entries(KINDS)) if (ext && list.split(' ').includes(ext)) kind = k;
  return h('span', { class: 'ext', 'data-kind': kind, 'aria-hidden': 'true' }, ext ? ext.slice(0, 4) : icon('file'));
}

// ---------- API ----------

export class ApiError extends Error {
  constructor(status, code, data) {
    super(code);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

export async function api(path, { method = 'GET', json, headers = {} } = {}) {
  const init = { method, headers: { Accept: 'application/json', ...headers }, credentials: 'same-origin' };
  if (json !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(json);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network');
  }
  if (res.status === 204) return null;
  let data = null;
  try {
    data = await res.json();
  } catch {
    // not JSON
  }
  if (!res.ok) throw new ApiError(res.status, data?.error || `http_${res.status}`, data);
  return data;
}

let configPromise = null;
export function loadConfig() {
  configPromise ||= api('/api/config').catch(() => null);
  return configPromise;
}

export function errorMessage(code, config) {
  const key = `err.${code}`;
  const message = t(key, { size: config ? formatBytes(config.maxUploadSize) : '?', count: config?.maxFiles ?? '?', code });
  return message === key ? t('err.generic', { code }) : message;
}

// ---------- UI helpers ----------

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const area = h('textarea', { class: 'sr-only', readonly: true });
    area.value = text;
    document.body.append(area);
    area.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    area.remove();
    return ok;
  }
}

/** Turns a button into a copy button with a short "Copied" confirmation. */
export function copyButton(getText, { label = 'btn.copy', className = 'btn btn-sm' } = {}) {
  const text = h('span', { text: t(label) });
  const btn = h('button', { type: 'button', class: className }, icon('copy'), text);
  let timer;
  btn.addEventListener('click', async () => {
    const ok = await copyText(getText());
    if (!ok) return;
    btn.replaceChildren(icon('check'), text);
    text.textContent = t('btn.copied');
    clearTimeout(timer);
    timer = setTimeout(() => {
      btn.replaceChildren(icon('copy'), text);
      text.textContent = t(label);
    }, 1800);
  });
  return btn;
}

export function toast(message, kind = 'success') {
  const box = $('#toasts');
  if (!box) return;
  const el = h('div', { class: `toast ${kind}`, role: 'status' }, icon(kind === 'error' ? 'alert' : 'check'), message);
  box.append(el);
  setTimeout(() => el.remove(), 3200);
}

export async function renderQr(container, text) {
  const { default: qrcode } = await import('./vendor/qrcode.mjs');
  const qr = qrcode(0, 'M');
  qr.addData(text);
  qr.make();
  const n = qr.getModuleCount();
  let d = '';
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c} ${r}h1v1h-1z`;
  const m = 2; // quiet zone (plus the white padding of .qr)
  container.innerHTML = `<svg viewBox="${-m} ${-m} ${n + 2 * m} ${n + 2 * m}" shape-rendering="crispEdges" role="img" aria-label="QR code"><path fill="#0b0c10" d="${d}"/></svg>`;
}

// ---------- recent drops (local to this browser) ----------

const RECENT_KEY = 'filedrop.recent';

export function getRecent() {
  try {
    const list = JSON.parse(storageGet(RECENT_KEY) || '[]');
    return Array.isArray(list) ? list.filter((d) => d && typeof d.id === 'string') : [];
  } catch {
    return [];
  }
}

export function saveRecent(list) {
  storageSet(RECENT_KEY, list.length ? JSON.stringify(list.slice(0, 12)) : null);
}

export function forgetRecent(id) {
  saveRecent(getRecent().filter((d) => d.id !== id));
}

// ---------- page chrome ----------

export function initChrome(config) {
  if (config?.siteName) for (const el of document.querySelectorAll('[data-site-name]')) el.textContent = config.siteName;
  if (config?.version) for (const el of document.querySelectorAll('[data-version]')) el.textContent = `v${config.version}`;
  hydrateIcons();
  applyI18n();
  const toggle = $('[data-lang-toggle]');
  if (toggle) {
    const label = toggle.querySelector('.label') || toggle;
    const update = () => {
      label.textContent = t('lang.switch');
    };
    update();
    toggle.addEventListener('click', () => setLang(lang === 'de' ? 'en' : 'de'));
    window.addEventListener('langchange', update);
  }
}
