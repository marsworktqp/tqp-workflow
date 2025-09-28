// main.js
import { app, BrowserWindow, shell } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  initDB,
  registerIpc,
  insertExportRows,
  selectExportByDelivery,
  updateExportByDelivery,
  // NOWE: helper z sql.js – musi zwrócić tablicę e-maili dla podanego procesu
  selectEmailsForProces
} from './sql.js';

import { startMailListener, bus as mailBus } from './mailListener.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

let mainWindow;

// ======================
// Konfiguracja skrzynki (IMAP + SMTP Gmail)
// ======================
const TECH_MAIL = {
  imap: {
    host: process.env.IMAP_HOST || 'imap.gmail.com',
    port: Number(process.env.IMAP_PORT || 993),
    secure: true,
    user: process.env.MAIL_USER || 'marswork100@gmail.com',
    pass: process.env.MAIL_PASS || 'gzkrubjbetlbaoaz',
  },
  smtp: {
    host: process.env.SMTP_HOST || 'smtp.gmail.com',
    port: Number(process.env.SMTP_PORT || 465),
    secure: true,
    user: process.env.SMTP_USER || process.env.MAIL_USER || 'marswork100@gmail.com',
    pass: process.env.SMTP_PASS || process.env.MAIL_PASS || 'gzkrubjbetlbaoaz',
  },
  // === ZMIANA: włączamy oznaczanie jako przeczytane ===
  markSeen: true,
  // === NOWE: domykanie po identycznym temacie (UNSEEN -> \Seen) ===
  markSeenBySubject: true,
  attachmentsBaseDir: undefined,
  maxAttachmentSizeMB: 50
};

// pojedyncza instancja (opcjonalnie)
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 980,
    minHeight: 600,
    backgroundColor: '#030732',
    show: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      preload: path.join(__dirname, 'preload.cjs')
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html'));

  // zewnętrzne linki
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  if (!app.isPackaged) {
    // mainWindow.webContents.openDevTools({ mode: 'detach' });
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    await initDB();
    registerIpc();

    await startMailIngester();

    createWindow();

  } catch (err) {
    console.error('Startup error:', err);
    app.quit();
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// logi globalne
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception in main:', err);
});
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection in main:', reason);
});

// ======================
// Mail ingester (IMAP) — Delivery INSERT + EAD UPDATE/MAIL/CLEANUP
// ======================
async function startMailIngester() {
  // Logi z mailListener do konsoli i UI
  mailBus.on('log', ({ level, msg }) => {
    const fn = level === 'error' ? console.error : console.log;
    fn('[MAIL]', msg);
    mainWindow?.webContents?.send('mail:log', { level, msg });
  });

  // Info o zapisanym PDF — forward do UI (podgląd)
  mailBus.on('pdf-saved', (info) => {
    console.log('[MAIL] PDF saved:', info);
    mainWindow?.webContents?.send('mail:pdf-saved', info);
  });

  // INSERT: Delivery (z mailListenera przychodzi { view:'export', row })
  mailBus.on('row', async ({ view, row }) => {
    try {
      if (view !== 'export') return;
      await insertExportRows([row]);

      // notyfikacje do renderera
      mainWindow?.webContents?.send('api:row-inserted', { view: 'export', row });
      mainWindow?.webContents?.send('db:rowInserted',   { view: 'export', row });

      console.log('[MAIL] Export INSERT & UI notify:', row?.delivery, row?.data_wiadomosci);
    } catch (e) {
      console.error('[MAIL] Export insert/push error:', e);
    }
  });

  // --- normalizator dla EAD (obsługuje zarówno 'ead-update' jak i 'ead:action') ---
  const handleEadUpdate = async (payload, isActionFormat = false) => {
    try {
      const delivery = payload?.delivery;
      if (!delivery) {
        console.error('[MAIL][EAD] Missing delivery in payload');
        return;
      }

      // formaty payloadu:
      // 1) 'ead-update': { delivery, proces? | dokumenty?, numer_zamkniecia_mrn?, data_zamkniecia_mrn?, status?, eadPath?, eadSubject? }
      // 2) 'ead:action': { delivery, updates:{ proces? | dokumenty?, numer_zamkniecia_mrn?, data_zamkniecia_mrn? }, mail:{ subjectEad?, attachments:{ eadPath? } }, cleanupPaths:[...] }
      const updatesSrc = isActionFormat ? (payload.updates || {}) : (payload || {});
      const eadPath = (isActionFormat ? payload.mail?.attachments?.eadPath : payload.eadPath) || null;
      const eadSubject = (isActionFormat ? payload.mail?.subjectEad : payload.eadSubject) || 'EAD';

      const existing = await selectExportByDelivery(delivery);
      if (!existing) {
        console.warn('[MAIL][EAD] No existing row for delivery:', delivery);
        return;
      }

      const prevSubject = existing.korespondencja || '';
      const tech = parseTechData(existing.dane_techniczne);
      const deliveryPath = tech?.attachment || null;

      // Zbuduj 'updates' tylko z wartości niepustych — 'proces' z fallbackiem z 'dokumenty'
      const updates = { status: 'Rozesłano EAD' };

      const maybeProces = updatesSrc.proces ?? updatesSrc.dokumenty;
      if (hasVal(maybeProces)) updates.proces = maybeProces;

      if (hasVal(updatesSrc.numer_zamkniecia_mrn)) updates.numer_zamkniecia_mrn = updatesSrc.numer_zamkniecia_mrn;
      if (hasVal(updatesSrc.data_zamkniecia_mrn))  updates.data_zamkniecia_mrn  = updatesSrc.data_zamkniecia_mrn;

      console.log('[MAIL][EAD] Applying updates for delivery=', delivery, updates);
      const res = await updateExportByDelivery(delivery, updates);
      console.log('[MAIL][EAD] DB updated rows:', res?.updated ?? 0);

      // po UPDATE – pobierz świeży rekord i wyślij do UI
      const fresh = await selectExportByDelivery(delivery);
      mainWindow?.webContents?.send('api:row-updated', { view: 'export', row: fresh });
      mainWindow?.webContents?.send('db:rowUpdated',   { view: 'export', row: fresh });

      // ===== WYBÓR ADRESATÓW Z KONFIGURACJI PROCESÓW =====
      let recipients = [];
      if (hasVal(maybeProces)) {
        try {
          recipients = await selectEmailsForProces(String(maybeProces));
        } catch (e) {
          console.error('[MAIL][EAD] selectEmailsForProces error:', e?.message || e);
        }
      }

      if (!Array.isArray(recipients)) recipients = [];
      recipients = recipients.map(String).map(s => s.trim()).filter(Boolean);

      if (!recipients.length) {
        console.warn(`[MAIL][EAD] Brak dopasowania adresów dla procesu: "${maybeProces ?? ''}". Mail nie zostanie wysłany.`);
      } else {
        // MAIL: temat = EAD + | + poprzedni, załączniki: EAD + Delivery (jeśli istnieje)
        const joinedSubject = buildJoinedSubject(eadSubject || 'EAD', prevSubject);
        const attachments = Array.from(new Set([eadPath, deliveryPath].filter(Boolean)));

        const sentInfo = await sendEadMail({
          smtp: TECH_MAIL.smtp,
          from: TECH_MAIL.smtp.user,
          to: recipients,
          subject: joinedSubject,
          attachments
        });
        console.log('[MAIL][EAD] Mail sent:', sentInfo?.messageId || '(no id)');
      }

      // SPRZĄTANIE: usuń załączniki po wysyłce/aktualizacji
      const toClean = [eadPath, deliveryPath].filter(Boolean);
      await cleanupFiles(toClean);

    } catch (e) {
      console.error('[MAIL][EAD] handler error:', e);
    }
  };

  // UPDATE + MAIL + CLEANUP: EAD (nowy format)
  mailBus.on('ead-update', (payload) => handleEadUpdate(payload, false));
  // Wsteczna kompatybilność (starszy format z 'updates')
  mailBus.on('ead:action', (payload) => handleEadUpdate(payload, true));

  // Start IMAP
  await startMailListener({
    imap: {
      host: TECH_MAIL.imap.host,
      port: TECH_MAIL.imap.port,
      secure: TECH_MAIL.imap.secure,
      user: TECH_MAIL.imap.user,
      pass: TECH_MAIL.imap.pass
    },
    // przekazujemy ustawienia widoczności/flag
    markSeen: TECH_MAIL.markSeen,
    markSeenBySubject: TECH_MAIL.markSeenBySubject,   // ← NOWE
    attachmentsBaseDir: TECH_MAIL.attachmentsBaseDir,
    maxAttachmentSizeMB: TECH_MAIL.maxAttachmentSizeMB
  });
}

// ======================
/** Helpers */
// ======================
function hasVal(v) {
  return typeof v !== 'undefined' && v !== null && String(v).trim() !== '';
}

function parseTechData(v) {
  if (!v) return null;
  try {
    if (typeof v === 'string') return JSON.parse(v);
    if (typeof v === 'object') return v;
  } catch {}
  return null;
}

function buildJoinedSubject(subjectEad, prevSubject) {
  const a = String(subjectEad || '').trim();
  const b = String(prevSubject || '').trim();
  if (!a && !b) return 'EAD';
  if (a && b) return `${a} | ${b}`;
  return a || b;
}

async function cleanupFiles(paths = []) {
  for (const p of paths) {
    if (!p) continue;
    try {
      await fs.promises.unlink(p);
      console.log('[CLEANUP] Removed:', p);
    } catch (e) {
      if (e?.code !== 'ENOENT') console.warn('[CLEANUP] Could not remove:', p, e?.message || e);
    }
  }
}

async function sendEadMail({ smtp, from, to, subject, attachments = [] }) {
  let nodemailer;
  try {
    ({ default: nodemailer } = await import('nodemailer'));
  } catch (e) {
    console.error('[SMTP] nodemailer not installed:', e?.message || e);
    return null;
  }

  const transporter = nodemailer.createTransport({
    host: smtp.host,
    port: smtp.port,
    secure: smtp.secure,
    auth: { user: smtp.user, pass: smtp.pass }
  });

  const mailOptions = {
    from,
    to: Array.isArray(to) ? to.join(',') : String(to || ''),
    subject: subject || 'EAD',
    text: 'W załączeniu dokumenty: EAD + Delivery.',
    attachments: (attachments || [])
      .filter(Boolean)
      .map((p) => ({ filename: path.basename(p), path: p }))
  };

  try {
    const info = await transporter.sendMail(mailOptions);
    return info;
  } catch (e) {
    console.error('[SMTP] send error:', e?.message || e);
    return null;
  }
}
