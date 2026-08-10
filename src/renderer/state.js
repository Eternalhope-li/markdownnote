const state = {
  appInfo: null,
  config: null,
  library: null,
  notes: [],
  externalNotes: [],
  currentPath: null,
  currentContent: '',
  dirty: false,
  diskMtime: null,
  tagFilter: null,
  openTabs: [],          // 已打开的笔记路径（多标签）
  dirtyTabs: {},         // 各标签是否有未保存修改 path -> bool
  recent: [],            // 最近打开（config.recent 的镜像）
  lastOwnSaveTs: 0,      // 最近一次本应用保存的时间戳（外部变更提示用）
  sourceMode: false      // 源码视图是否开启
};

function getState() { return state; }
function setState(patch) { Object.assign(state, patch); }

module.exports = { getState, setState };
