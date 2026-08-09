const { getState, setState } = require('./state');

const ICON_MOON = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>';
const ICON_SUN = '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/></svg>';

function apply(theme) {
  document.body.dataset.theme = theme;
  const lightLink = document.getElementById('hljsLight');
  const darkLink = document.getElementById('hljsDark');
  if (lightLink) lightLink.disabled = theme === 'dark';
  if (darkLink) darkLink.disabled = theme !== 'dark';
  const btn = document.getElementById('btnTheme');
  if (btn) btn.innerHTML = theme === 'dark' ? ICON_SUN : ICON_MOON;
  setState({ config: { ...(getState().config || {}), theme } });
}

function init() {
  const theme = (getState().config && getState().config.theme) || 'light';
  apply(theme);
}

function toggle() {
  const next = document.body.dataset.theme === 'dark' ? 'light' : 'dark';
  apply(next);
  window.api.saveConfig(getState().config);
}

module.exports = { init, toggle, apply };
