// preload.cjs (CommonJS)
const { contextBridge, ipcRenderer } = require('electron');

/** Normalizacja nazwy widoku/tabeli przekazanej do API */
function normalizeView(input) {
  if (typeof input === 'string') return input;
  if (input && typeof input === 'object') return input.table ?? input.view ?? '';
  return '';
}

/** Invoke z preferencją primary->secondary (primary najpierw) */
async function invokePreferring(primary, secondary, payload) {
  try {
    return await ipcRenderer.invoke(primary, payload);
  } catch (e) {
    if (secondary) {
      try { return await ipcRenderer.invoke(secondary, payload); }
      catch (e2) { throw e2; }
    }
    throw e;
  }
}

const api = {
  /** OGÓLNY PASSTHROUGH: umożliwia wywołania dowolnych kanałów IPC (np. pc:list/insert/update/delete) */
  invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args),

  /** Pobiera wiersze */
  getRows: (viewOrObj) => {
    const view = normalizeView(viewOrObj);
    return invokePreferring('db:getRows', 'api:getRows', view);
  },

  /** Ręczny insert */
  insertRow: (viewOrTable, data) => {
    const view = normalizeView(viewOrTable);
    return invokePreferring('db:insertRow', 'api:insertRow', { view, payload: data });
  },

  /** Reset danych/aplikacji */
  resetPrefs: () => ipcRenderer.invoke('app:resetPrefs'),

  /** Ping */
  ping: () => ipcRenderer.invoke('ping'),

  /**
   * Subskrypcja na zdarzenie "nowy wiersz"
   * Słucha zarówno 'api:row-inserted', jak i 'db:rowInserted'
   */
  onRowInserted: (handler) => {
    const safeHandler = (_evt, payload) => {
      try { handler?.(payload); } catch (e) { console.error(e); }
    };
    ipcRenderer.on('api:row-inserted', safeHandler);
    ipcRenderer.on('db:rowInserted', safeHandler);
    window.addEventListener('beforeunload', () => {
      ipcRenderer.removeListener('api:row-inserted', safeHandler);
      ipcRenderer.removeListener('db:rowInserted', safeHandler);
    });
    return () => {
      ipcRenderer.removeListener('api:row-inserted', safeHandler);
      ipcRenderer.removeListener('db:rowInserted', safeHandler);
    };
  },

  /**
   * Subskrypcja aktualizacji istniejących wierszy
   * 'api:row-updated' i 'db:rowUpdated'
   * payload: { view:'export', delivery:'...', row:{...} }
   */
  onRowUpdated: (handler) => {
    const safeHandler = (_evt, payload) => {
      try { handler?.(payload); } catch (e) { console.error(e); }
    };
    ipcRenderer.on('api:row-updated', safeHandler);
    ipcRenderer.on('db:rowUpdated', safeHandler);
    window.addEventListener('beforeunload', () => {
      ipcRenderer.removeListener('api:row-updated', safeHandler);
      ipcRenderer.removeListener('db:rowUpdated', safeHandler);
    });
    return () => {
      ipcRenderer.removeListener('api:row-updated', safeHandler);
      ipcRenderer.removeListener('db:rowUpdated', safeHandler);
    };
  },

  /** Logi mailowe z main */
  onMailLog: (handler) => {
    const safe = (_e, p) => { try { handler?.(p); } catch (e) { console.error(e); } };
    ipcRenderer.on('mail:log', safe);
    window.addEventListener('beforeunload', () => ipcRenderer.removeListener('mail:log', safe));
    return () => ipcRenderer.removeListener('mail:log', safe);
  }
};

contextBridge.exposeInMainWorld('api', api);