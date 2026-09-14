const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('controls', {
  action: action => ipcRenderer.invoke('desktop:window-action', action),
  subscribe: callback => { ipcRenderer.on('desktop:controls', (_event, state) => callback(state)); },
});
