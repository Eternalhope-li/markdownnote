const state = {
  appInfo: null,
  config: null,
  library: null,
  notes: [],
  currentPath: null,
  currentContent: '',
  dirty: false,
  diskMtime: null,
  tagFilter: null
};

function getState() { return state; }
function setState(patch) { Object.assign(state, patch); }

module.exports = { getState, setState };