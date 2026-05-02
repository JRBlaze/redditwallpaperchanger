const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('wallpaperApp', {
  getState: () => ipcRenderer.invoke('state:get'),
  refresh: () => ipcRenderer.invoke('wallpapers:refresh'),
  setNewest: () => ipcRenderer.invoke('wallpapers:setNewest'),
  setWallpaper: (id) => ipcRenderer.invoke('wallpapers:set', id),
  favoriteWallpaper: (id) => ipcRenderer.invoke('wallpapers:favorite', id),
  updateSettings: (settings) => ipcRenderer.invoke('settings:update', settings),
  chooseFavoriteFolder: () => ipcRenderer.invoke('favorites:chooseFolder'),
  openFavoriteFolder: () => ipcRenderer.invoke('favorites:openFolder'),
  openLink: (url) => ipcRenderer.invoke('links:open', url),
  onStateUpdate: (callback) => {
    const listener = (_event, state) => callback(state);
    ipcRenderer.on('state:update', listener);
    return () => ipcRenderer.removeListener('state:update', listener);
  }
});
