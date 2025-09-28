// sql.js — backend DB na sql.js (WASM) z IPC zgodnym z preload.cjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { app, ipcMain, BrowserWindow } from 'electron';
import initSqlJs from 'sql.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);

let SQL;      // moduł sql.js
let db;       // instancja bazy w pamięci
let dbPath;   // ścieżka do pliku na dysku

// ------- helpers -------
const toEpoch = (v) => {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return v;
  if (v instanceof Date) return v.getTime();
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
};

function saveDB() {
  const data = db.export(); // Uint8Array
  fs.writeFileSync(dbPath, Buffer.from(data));
}

function broadcast(channel, payload) {
  for (const w of BrowserWindow.getAllWindows()) {
    try { w.webContents.send(channel, payload); } catch {}
  }
}

// Rozdzielanie listy e-maili zapisanej w jednym polu (przecinki, średniki, spacje, nowe linie)
function splitEmails(str) {
  return String(str || '')
    .split(/[,;\s]+/)
    .map(s => s.trim())
    .filter(Boolean);
}

// ------- public API: init + IPC -------
export async function initDB() {
  // wskaż sql.js gdzie znaleźć WASM
  SQL = await initSqlJs({
    locateFile: (file) => path.join(__dirname, 'node_modules/sql.js/dist', file),
  });

  // plik bazy w katalogu danych aplikacji
  dbPath = path.join(app.getPath('userData'), 'tqp.db');

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new SQL.Database(fileBuffer);
  } else {
    db = new SQL.Database();
  }

  // Struktura (daty jako INTEGER — epoch ms)
  db.run(`
    CREATE TABLE IF NOT EXISTS shipments_import (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_awizacji             INTEGER,
      data_zamkniecia_tranzytu  INTEGER,
      status                    TEXT,
      awb                       TEXT,
      przewoznik                TEXT,
      dokumenty                 TEXT,
      korespondencja            TEXT,
      dsk_mrn                   TEXT,
      data_dsk                  INTEGER,
      data_zamkniecia_dsk       INTEGER,
      odprawa_mrn               TEXT,
      data_odprawy_mrn          INTEGER
    );

    -- Uwaga: w nowej wersji używamy 'proces' zamiast 'dokumenty' w shipments_export
    CREATE TABLE IF NOT EXISTS shipments_export (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      data_wiadomosci           INTEGER,
      delivery                  TEXT,
      numer_zamkniecia_mrn      TEXT,
      data_zamkniecia_mrn       INTEGER,
      proces                    TEXT,   -- NOWE POLE (zastępuje 'dokumenty')
      status                    TEXT,
      korespondencja            TEXT,
      dane_techniczne           TEXT
    );

    -- NOWA TABELA: konfiguracje procesów
    CREATE TABLE IF NOT EXISTS process_configs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      proces TEXT NOT NULL,
      emails TEXT NOT NULL
    );
  `);

  // unikalność po delivery, żeby nie powstawały duplikaty
  try {
    db.run(`
      CREATE UNIQUE INDEX IF NOT EXISTS ux_shipments_export_delivery
      ON shipments_export(delivery)
    `);
  } catch (e) {
    console.warn('[DB] Could not create UNIQUE index on shipments_export(delivery):', e?.message || e);
  }

  // --- MIGRACJE ---

  // migracja — jeśli kiedyś nie było kolumny dane_techniczne
  try {
    db.run(`ALTER TABLE shipments_export ADD COLUMN IF NOT EXISTS dane_techniczne TEXT`);
  } catch (e) {
    try {
      const info = db.exec(`PRAGMA table_info('shipments_export')`);
      const cols = (info?.[0]?.values || []).map(r => (r[1] || '').toString());
      if (!cols.includes('dane_techniczne')) {
        db.run(`ALTER TABLE shipments_export ADD COLUMN dane_techniczne TEXT`);
      }
    } catch {}
  }

  // migracja — przejście z 'dokumenty' -> 'proces'
  try {
    const info = db.exec(`PRAGMA table_info('shipments_export')`);
    const cols = (info?.[0]?.values || []).map(r => (r[1] || '').toString());
    const hasProces = cols.includes('proces');
    const hasDokumenty = cols.includes('dokumenty');

    if (!hasProces) {
      db.run(`ALTER TABLE shipments_export ADD COLUMN proces TEXT`);
    }
    // jeżeli mamy starą kolumnę 'dokumenty', skopiuj dane do 'proces' tam gdzie puste
    if (hasDokumenty) {
      db.run(`
        UPDATE shipments_export
        SET proces = COALESCE(NULLIF(proces, ''), dokumenty)
        WHERE (proces IS NULL OR proces = '') AND dokumenty IS NOT NULL
      `);
      // Nie usuwamy 'dokumenty' (SQLite DROP COLUMN jest kłopotliwy); od teraz nie używamy jej w kodzie.
    }
  } catch (e) {
    console.warn('[DB] Migration dokumenty->proces warning:', e?.message || e);
  }

  saveDB();
}

/**
 * Batch INSERT/UPSERT do tabeli EXPORT (etap "Delivery"):
 * - jeśli delivery nie istnieje -> INSERT
 * - jeśli delivery istnieje -> UPSERT (aktualizuje tylko niepuste pola z "excluded")
 *
 * @param {Array<Object>} rows
 * @returns {number} liczba przetworzonych rekordów
 */
export function insertExportRows(rows) {
  if (!rows?.length) return 0;

  const stmt = db.prepare(`
    INSERT INTO shipments_export
      (data_wiadomosci, delivery, numer_zamkniecia_mrn, data_zamkniecia_mrn, proces, status, korespondencja, dane_techniczne)
    VALUES
      ($data_wiadomosci, $delivery, $numer_zamkniecia_mrn, $data_zamkniecia_mrn, $proces, $status, $korespondencja, $dane_techniczne)
    ON CONFLICT(delivery) DO UPDATE SET
      data_wiadomosci      = COALESCE(excluded.data_wiadomosci, shipments_export.data_wiadomosci),
      numer_zamkniecia_mrn = COALESCE(excluded.numer_zamkniecia_mrn, shipments_export.numer_zamkniecia_mrn),
      data_zamkniecia_mrn  = COALESCE(excluded.data_zamkniecia_mrn, shipments_export.data_zamkniecia_mrn),
      proces               = COALESCE(excluded.proces, shipments_export.proces),
      status               = COALESCE(excluded.status, shipments_export.status),
      korespondencja       = COALESCE(excluded.korespondencja, shipments_export.korespondencja),
      dane_techniczne      = COALESCE(excluded.dane_techniczne, shipments_export.dane_techniczne)
  `);

  db.run('BEGIN');
  try {
    for (const r of rows) {
      const p = sanitizeExport(r);
      stmt.run({
        $data_wiadomosci:       p.data_wiadomosci,
        $delivery:              p.delivery,
        $numer_zamkniecia_mrn:  p.numer_zamkniecia_mrn,
        $data_zamkniecia_mrn:   p.data_zamkniecia_mrn,
        $proces:                p.proces,
        $status:                p.status,
        $korespondencja:        p.korespondencja,
        $dane_techniczne:       p.dane_techniczne,
      });
    }
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  } finally {
    stmt.free?.();
  }

  saveDB();
  return rows.length;
}

/**
 * Zwraca najświeższy wiersz z shipments_export po polu `delivery`.
 * @param {string} delivery
 * @returns {Promise<object|null>}
 */
export async function selectExportByDelivery(delivery) {
  if (!delivery) return null;
  const stmt = db.prepare(`
    SELECT *
    FROM shipments_export
    WHERE delivery = $delivery
    ORDER BY id DESC
    LIMIT 1
  `);
  try {
    stmt.bind({ $delivery: delivery });
    if (stmt.step()) {
      const row = stmt.getAsObject();
      return row;
    }
    return null;
  } finally {
    stmt.free?.();
  }
}

/**
 * Częściowa aktualizacja wiersza po `delivery` (etap "EAD" i inne aktualizacje).
 * Dozwolone pola w `updates`:
 *  - proces, numer_zamkniecia_mrn, data_zamkniecia_mrn, status,
 *    korespondencja, dane_techniczne, data_wiadomosci
 *
 * Zwraca: { updated: number } — ile wierszy zaktualizowano.
 *
 * @param {string} delivery
 * @param {object} updates
 */
export async function updateExportByDelivery(delivery, updates = {}) {
  if (!delivery) return { updated: 0 };

  // Back-compat: jeśli ktoś poda 'dokumenty', potraktuj to jak 'proces'
  if (Object.prototype.hasOwnProperty.call(updates, 'dokumenty') && !updates.proces) {
    updates.proces = updates.dokumenty;
    delete updates.dokumenty;
  }

  const allowed = new Set([
    'proces',
    'numer_zamkniecia_mrn',
    'data_zamkniecia_mrn',
    'status',
    'korespondencja',
    'dane_techniczne',
    'data_wiadomosci'
  ]);

  const fields = [];
  const params = { $delivery: delivery };

  for (const [k, v] of Object.entries(updates)) {
    if (!allowed.has(k)) continue;
    const col = k;
    const paramName = `$${col}`;
    if (col === 'data_zamkniecia_mrn' || col === 'data_wiadomosci') {
      params[paramName] = toEpoch(v);
    } else {
      params[paramName] = v ?? null;
    }
    fields.push(`${col} = ${paramName}`);
  }

  if (!fields.length) return { updated: 0 };

  const sql = `
    UPDATE shipments_export
    SET ${fields.join(', ')}
    WHERE delivery = $delivery
  `;

  db.run(sql, params);

  // ile wierszy zmieniono
  let updated = 0;
  try {
    const res = db.exec(`SELECT changes() AS n`);
    updated = Number(res?.[0]?.values?.[0]?.[0] ?? 0);
  } catch {}
  if (updated > 0) saveDB();

  return { updated };
}

/**
 * Zwróć listę adresów e-mail dla dokładnie dopasowanego procesu (case-insensitive).
 * @param {string} proces
 * @returns {string[]} tablica adresów e-mail
 */
export function selectEmailsForProces(proces) {
  const p = String(proces || '').trim().toLowerCase();
  if (!p) return [];
  const stmt = db.prepare(`
    SELECT emails
    FROM process_configs
    WHERE lower(proces) = $p
    LIMIT 1
  `);
  try {
    stmt.bind({ $p: p });
    if (stmt.step()) {
      const row = stmt.getAsObject();
      return splitEmails(row.emails);
    }
    return [];
  } finally {
    stmt.free?.();
  }
}

export function registerIpc() {
  // ping do szybkiego testu preloadu
  ipcMain.handle('ping', () => 'pong');

  // Pobieranie wierszy (view: 'import' | 'export')
  ipcMain.handle('db:getRows', (_e, view) => {
    if (view === 'import') {
      const stmt = db.prepare(`
        SELECT * FROM shipments_import
        ORDER BY COALESCE(data_awizacji,0) DESC, id DESC
      `);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    }
    if (view === 'export') {
      const stmt = db.prepare(`
        SELECT * FROM shipments_export
        ORDER BY COALESCE(data_wiadomosci,0) DESC, id DESC
      `);
      const rows = [];
      while (stmt.step()) rows.push(stmt.getAsObject());
      stmt.free();
      return rows;
    }
    throw new Error(`db:getRows: nieznany view "${view}" (użyj 'import' lub 'export')`);
  });

  // Ręczne wstawianie wiersza (kompatybilność z istniejącym preloadem) — też UPSERT
  ipcMain.handle('db:insertRow', (_e, { view, payload }) => {
    if (view === 'import') {
      const p = sanitizeImport(payload);
      db.run(
        `INSERT INTO shipments_import
         (data_awizacji, data_zamkniecia_tranzytu, status, awb, przewoznik,
          dokumenty, korespondencja, dsk_mrn, data_dsk, data_zamkniecia_dsk,
          odprawa_mrn, data_odprawy_mrn)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          p.data_awizacji,
          p.data_zamkniecia_tranzytu,
          p.status,
          p.awb,
          p.przewoznik,
          p.dokumenty,
          p.korespondencja,
          p.dsk_mrn,
          p.data_dsk,
          p.data_zamkniecia_dsk,
          p.odprawa_mrn,
          p.data_odprawy_mrn,
        ]
      );
      const id = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
      saveDB();
      const row = { id, ...p };
      broadcast('db:rowInserted', { view, row });
      return { ok: true, id };
    }

    if (view === 'export') {
      const p = sanitizeExport(payload);
      db.run(
        `INSERT INTO shipments_export
         (data_wiadomosci, delivery, numer_zamkniecia_mrn, data_zamkniecia_mrn,
          proces, status, korespondencja, dane_techniczne)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(delivery) DO UPDATE SET
           data_wiadomosci      = COALESCE(excluded.data_wiadomosci, shipments_export.data_wiadomosci),
           numer_zamkniecia_mrn = COALESCE(excluded.numer_zamkniecia_mrn, shipments_export.numer_zamkniecia_mrn),
           data_zamkniecia_mrn  = COALESCE(excluded.data_zamkniecia_mrn, shipments_export.data_zamkniecia_mrn),
           proces               = COALESCE(excluded.proces, shipments_export.proces),
           status               = COALESCE(excluded.status, shipments_export.status),
           korespondencja       = COALESCE(excluded.korespondencja, shipments_export.korespondencja),
           dane_techniczne      = COALESCE(excluded.dane_techniczne, shipments_export.dane_techniczne)
        `,
        [
          p.data_wiadomosci,
          p.delivery,
          p.numer_zamkniecia_mrn,
          p.data_zamkniecia_mrn,
          p.proces,
          p.status,
          p.korespondencja,
          p.dane_techniczne,
        ]
      );

      saveDB();
      return { ok: true };
    }

    throw new Error(`db:insertRow: nieznany view "${view}" (użyj 'import' lub 'export')`);
  });

  // Reset danych w bazie (pasuje do window.api.resetPrefs())
  ipcMain.handle('app:resetPrefs', () => {
    db.run(`DELETE FROM shipments_import; DELETE FROM shipments_export; VACUUM;`);
    saveDB();
    return { ok: true };
  });

  // (opcjonalne) Ziarno demo – szybkie dane testowe
  ipcMain.handle('db:seed-demo', () => {
    const now = Date.now(), d1 = now - 86400000, d3 = now - 3 * 86400000;

    db.run(
      `INSERT INTO shipments_import
       (data_awizacji, data_zamkniecia_tranzytu, status, awb, przewoznik,
        dokumenty, korespondencja, dsk_mrn, data_dsk, data_zamkniecia_dsk,
        odprawa_mrn, data_odprawy_mrn)
       VALUES
       (?, NULL, 'W tranzycie', '176-12345678', 'LOT', 'CMR;INV', 'wątek-123', 'PL123456', ?, NULL, NULL, NULL),
       (?, ?, 'Zamknięty',   '176-87654321', 'DHL', 'CMR',     'wątek-777', 'PL888999', ?, ?, 'MRN-PL-42', ?)`,
      [d1, d1, now, d3, now, now, now]
    );

    db.run(
      `INSERT INTO shipments_export
       (data_wiadomosci, delivery, numer_zamkniecia_mrn, data_zamkniecia_mrn,
        proces, status, korespondencja, dane_techniczne)
       VALUES
       (?, 'DLV-1001', 'MRN-EXP-9001', ?, 'BL;PACK', 'W toku', 'mail-abc', NULL)
       ON CONFLICT(delivery) DO NOTHING
      `,
      [now, now, d3]
    );

    db.run(
      `INSERT INTO shipments_export
       (data_wiadomosci, delivery, numer_zamkniecia_mrn, data_zamkniecia_mrn,
        proces, status, korespondencja, dane_techniczne)
       VALUES
       (?, 'DLV-1002', 'MRN-EXP-9002', ?, 'PACK', 'Zamknięty', 'mail-xyz', NULL)
       ON CONFLICT(delivery) DO NOTHING
      `,
      [now, d3]
    );

    saveDB();
    broadcast('db:rowInserted', { view: 'import', row: null });
    broadcast('db:rowInserted', { view: 'export', row: null });
    return { ok: true };
  });

  // === IPC dla konfiguracji procesów ===
  ipcMain.handle('pc:list', () => {
    const stmt = db.prepare(`SELECT id, proces, emails FROM process_configs ORDER BY id ASC`);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  });

  ipcMain.handle('pc:insert', (_e, { proces, emails }) => {
    const p = (proces ?? '').toString().trim();
    const m = (emails ?? '').toString().trim();
    if (!p && !m) return { ok: false, reason: 'empty' };

    db.run(`INSERT INTO process_configs (proces, emails) VALUES (?, ?)`, [p, m]);
    const id = db.exec('SELECT last_insert_rowid() as id')[0].values[0][0];
    saveDB();
    return { ok: true, id };
  });

  ipcMain.handle('pc:update', (_e, { id, proces, emails }) => {
    if (id == null) return { ok: false, reason: 'no id' };
    const p = (proces ?? '').toString().trim();
    const m = (emails ?? '').toString().trim();
    db.run(`UPDATE process_configs SET proces = ?, emails = ? WHERE id = ?`, [p, m, id]);
    saveDB();
    return { ok: true };
  });

  ipcMain.handle('pc:delete', (_e, { id }) => {
    if (id == null) return { ok: false, reason: 'no id' };
    db.run(`DELETE FROM process_configs WHERE id = ?`, [id]);
    saveDB();
    return { ok: true };
  });
}

// ------- sanitizery -------
function sanitizeImport(x = {}) {
  return {
    data_awizacji:            toEpoch(x.data_awizacji),
    data_zamkniecia_tranzytu: toEpoch(x.data_zamkniecia_tranzytu),
    status:                   x.status ?? null,
    awb:                      x.awb ?? null,
    przewoznik:               x.przewoznik ?? null,
    dokumenty:                x.dokumenty ?? null,
    korespondencja:           x.korespondencja ?? null,
    dsk_mrn:                  x.dsk_mrn ?? null,
    data_dsk:                 toEpoch(x.data_dsk),
    data_zamkniecia_dsk:      toEpoch(x.data_zamkniecia_dsk),
    odprawa_mrn:              x.odprawa_mrn ?? null,
    data_odprawy_mrn:         toEpoch(x.data_odprawy_mrn),
  };
}

function sanitizeExport(x = {}) {
  // Back-compat: jeśli przyjdzie 'dokumenty', zamień na 'proces'
  const proces =
    x.proces != null ? x.proces :
    (x.dokumenty != null ? x.dokumenty : null);

  return {
    data_wiadomosci:      toEpoch(x.data_wiadomosci),
    delivery:             x.delivery ?? null,
    numer_zamkniecia_mrn: x.numer_zamkniecia_mrn ?? null,
    data_zamkniecia_mrn:  toEpoch(x.data_zamkniecia_mrn),
    proces:               proces,
    status:               x.status ?? null,
    korespondencja:       x.korespondencja ?? null,
    dane_techniczne:      x.dane_techniczne ?? null,
  };
}
