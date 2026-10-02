import { contextBridge, ipcRenderer } from 'electron';
import type { PricesQuery, RendererApi, SchedulerDone, ShelfScope, SplitPair } from '../src/shared/api.js';

const api: RendererApi = {
  ping: () => ipcRenderer.invoke('ping'),
  getVersion: () => ipcRenderer.invoke('app:version'),
  getPrices: (args: PricesQuery) => ipcRenderer.invoke('prices:get', args),
  openExternal: (url: string) => ipcRenderer.invoke('external:open', url),
  getCatalog: (args: { city?: string }) => ipcRenderer.invoke('catalog:get', args),
  getCategory: (args: { city?: string; url?: string }) => ipcRenderer.invoke('category:get', args),
  getOurCategories: (args: { city?: string }) => ipcRenderer.invoke('ourcategories:get', args),
  getOurCategory: (args: { city?: string; id?: string }) => ipcRenderer.invoke('ourcategory:get', args),
  getShelves: (args: ShelfScope) => ipcRenderer.invoke('shelves:get', args),
  setShelves: (args: ShelfScope & { categoryIds: string[] }) => ipcRenderer.invoke('shelves:set', args),
  releaseShelves: (args: ShelfScope) => ipcRenderer.invoke('shelves:release', args),
  getFavorites: (args: { city: string }) => ipcRenderer.invoke('favorites:get', args),
  setFavorite: (args: ShelfScope & { targetPrice: number | null }) => ipcRenderer.invoke('favorites:set', args),
  removeFavorite: (args: ShelfScope) => ipcRenderer.invoke('favorites:remove', args),
  splitProducts: (args: SplitPair) => ipcRenderer.invoke('splits:set', args),
  removeSplit: (args: SplitPair) => ipcRenderer.invoke('splits:remove', args),
  getSplitPairs: (args: { city: string }) => ipcRenderer.invoke('splits:pairs', args),
  getHistory: (args: { canonicalId: string; storeId: string; city: string }) =>
    ipcRenderer.invoke('history:get', args),
  getSchedulerStatus: () => ipcRenderer.invoke('scheduler:status'),
  runScheduler: (args?: { city?: string }) => ipcRenderer.invoke('scheduler:run', args),
  setCurrentCity: (city: string) => ipcRenderer.invoke('city:set', { city }),
  onSchedulerProgress: (cb: (done: number, total: number) => void) => {
    const h = (_e: unknown, v: unknown) => {
      const o = v as { done: unknown; total: unknown };
      if (typeof o.done !== 'number' || typeof o.total !== 'number') return;
      cb(o.done, o.total);
    };
    ipcRenderer.on('scheduler:progress', h);
    return () => {
      ipcRenderer.removeListener('scheduler:progress', h);
    };
  },
  onSchedulerDone: (cb: (done: SchedulerDone) => void) => {
    const h = (_e: unknown, v: unknown) => {
      const o = v as { status?: unknown; summary?: unknown };
      if (typeof o !== 'object' || o === null) return;
      if (typeof o.status !== 'object' || o.status === null) return;
      if (typeof o.summary !== 'string') return;
      cb(v as SchedulerDone);
    };
    ipcRenderer.on('scheduler:done', h);
    return () => {
      ipcRenderer.removeListener('scheduler:done', h);
    };
  },
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
