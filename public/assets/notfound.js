import { initChrome, loadConfig, t } from './common.js';

const config = await loadConfig();
initChrome(config);
const setTitle = () => {
  document.title = `${t('nf.title')} · ${config?.siteName || 'XyoLua FileDrop'}`;
};
setTitle();
window.addEventListener('langchange', setTitle);
