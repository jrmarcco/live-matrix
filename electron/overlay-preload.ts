import { contextBridge, ipcRenderer } from 'electron';

const api = {
  move: (x: number, y: number) => ipcRenderer.send('ov:event', { type: 'move', x, y }),
  up: (x: number, y: number) => ipcRenderer.send('ov:event', { type: 'up', x, y }),
  cancel: () => ipcRenderer.send('ov:event', { type: 'cancel' }),
};

export type OvApi = typeof api;
contextBridge.exposeInMainWorld('ov', api);
