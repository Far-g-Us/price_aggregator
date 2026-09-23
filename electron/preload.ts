import { contextBridge, ipcRenderer } from 'electron';
import type { PricesQuery, RendererApi } from '../src/shared/api.js';

const api: RendererApi = {
  ping: () => ipcRenderer.invoke('ping'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  getPrices: (args: PricesQuery) => ipcRenderer.invoke('prices:get', args),
  getHistory: (args: { canonicalId: string; storeId: string; city: string }) =>
    ipcRenderer.invoke('history:get', args),
  getSchedulerStatus: () => ipcRenderer.invoke('scheduler:status'),
  runScheduler: () => ipcRenderer.invoke('scheduler:run'),
  checkUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateEvent: (cb: (kind: string, payload: unknown) => void) => {
    const wrap = (kind: string) => (_e: unknown, payload: unknown) => cb(kind, payload);
    const av = wrap('available');
    const dl = wrap('downloaded');
    const er = wrap('error');
    ipcRenderer.on('updates:available', av);
    ipcRenderer.on('updates:downloaded', dl);
    ipcRenderer.on('updates:error', er);
    return () => {
      ipcRenderer.removeListener('updates:available', av);
      ipcRenderer.removeListener('updates:downloaded', dl);
      ipcRenderer.removeListener('updates:error', er);
    };
  },
};

contextBridge.exposeInMainWorld('api', api);
