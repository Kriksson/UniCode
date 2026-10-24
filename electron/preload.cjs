const { contextBridge, ipcRenderer } = require('electron');
const invoke = name => (...args) => ipcRenderer.invoke(`codex:${name}`, ...args);
contextBridge.exposeInMainWorld('codex', {
  bootstrap: invoke('bootstrap'), save: invoke('save'), list: invoke('list'),
  history: invoke('history'), send: invoke('send'), interrupt: invoke('interrupt'),
  chooseFolder: invoke('choose-folder'), answer: invoke('answer'), login: invoke('login'),
  external: invoke('external'), window: invoke('window'),
  openLink: invoke('open-link'), deleteChat: invoke('delete-chat'), deleteFrom: invoke('delete-from'),
  steer: invoke('steer'),
  rateLimits: invoke('rate-limits'),
  onEvent: callback => {
    const listener = (_event, data) => callback(data);
    ipcRenderer.on('codex:event', listener);
    return () => ipcRenderer.removeListener('codex:event', listener);
  },
});
