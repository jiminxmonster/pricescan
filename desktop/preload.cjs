const { contextBridge, ipcRenderer } = require('electron');
// Narrow, named calls only. No shell, filesystem, cookie or generic IPC capability.
contextBridge.exposeInMainWorld('PriceScanDesktop', {
  version: '0.4.0',
  start: payload => ipcRenderer.invoke('desktop:start', payload),
  list: () => ipcRenderer.invoke('desktop:list'),
  authorize: token => ipcRenderer.invoke('desktop:authorize', token),
  logout: () => ipcRenderer.invoke('desktop:logout'),
  action: (jobId, source, action) => ipcRenderer.invoke('desktop:action', { jobId, source, action }),
  showScroll: jobId => ipcRenderer.invoke('desktop:show-scroll', jobId),
  captureAll: jobId => ipcRenderer.invoke('desktop:capture-all', jobId),
  loginNaver: () => ipcRenderer.invoke('desktop:login-naver'),
  subscribe: callback => {
    const listener = (_event, jobs) => callback(jobs);
    ipcRenderer.on('desktop:jobs', listener);
    return () => ipcRenderer.removeListener('desktop:jobs', listener);
  },
});
