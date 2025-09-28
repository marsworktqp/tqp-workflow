// mailListener.js (ESM) — stabilne oznaczanie \Seen po FETCH (bez deadlocków)
import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter } from 'events';
import os from 'node:os';
import crypto from 'node:crypto';

export const bus = new EventEmitter();

/**
 * @typedef {Object} MailListenerConfig
 * @property {{host:string, port:number, user:string, pass:string, secure?:boolean}} imap
 * @property {'import'|'export'} [labelForView='export']
 * @property {boolean} [markSeen=false]
 * @property {boolean} [markSeenBySubject=true]
 * @property {string} [attachmentsBaseDir]
 * @property {number} [maxAttachmentSizeMB=50]
 */

const FLAGS_TIMEOUT_MS = 10000;

export async function startMailListener(cfg) {
  const { host, port, user, pass, secure = true } = cfg.imap;
  const view = cfg.labelForView || 'export';
  const markSeen = !!cfg.markSeen;
  const markSeenBySubject = cfg.markSeenBySubject !== false;
  const baseDir = cfg.attachmentsBaseDir || path.join(os.homedir(), 'TechMailbox');
  const maxAttachmentSize = Math.max(1, Number(cfg.maxAttachmentSizeMB || 50)) * 1024 * 1024;

  ensureDir(baseDir);

  let client;
  let stopping = false;

  const connect = async () => {
    client = new ImapFlow({ host, port, secure, auth: { user, pass } });

    client.on('error', (err) => bus.emit('log', { level: 'error', msg: `IMAP error: ${err?.message || err}` }));
    client.on('close', async () => {
      if (stopping) return;
      bus.emit('log', { level: 'error', msg: 'IMAP connection closed. Reconnecting in 3s…' });
      await delay(3000);
      try { await connect(); }
      catch (e) { bus.emit('log', { level: 'error', msg: `Reconnect failed: ${e?.message || e}` }); }
    });

    await client.connect();
    await client.mailboxOpen('INBOX', { readOnly: false });
    bus.emit('log', { level: 'info', msg: `IMAP connected as ${user} @ ${host}` });
    bus.emit('log', { level: 'info', msg: `IMAP ready. markSeen=${markSeen} markSeenBySubject=${markSeenBySubject}` });

    // ===== 1) START: przetwarzamy wszystkie UNSEEN, flagi po zakończeniu fetch =====
    const startLock = await client.getMailboxLock('INBOX');
    try {
      /** Zbierz UID+temat do późniejszego oznaczania (po fetch) */
      const toMark = []; // [{ uid:number, subject:string }]
      for await (const msg of client.fetch({ seen: false }, { uid: true, source: true, internalDate: true })) {
        try {
          const processed = await processMessage(msg, { baseDir, maxAttachmentSize, view });
          if (processed) {
            const subject = await extractSubject(msg);
            if (markSeen || (markSeenBySubject && subject)) {
              toMark.push({ uid: msg.uid, subject });
            }
          }
        } catch (e) {
          bus.emit('log', { level: 'error', msg: `Process UNSEEN error: ${e?.message || e}` });
        }
      }
      // FETCH skończony — teraz dopiero stawiamy flagi
      await performMarking(client, toMark, { markSeen, markSeenBySubject });
    } finally {
      startLock.release();
    }

    // ===== 2) NOWE MAILE: fetch ostatniego UID; flagi po zakończeniu fetch =====
    client.on('exists', async () => {
      const lock = await client.getMailboxLock('INBOX');
      try {
        const status = await client.status('INBOX', { messages: true, uidNext: true });
        const lastUid = status?.uidNext ? status.uidNext - 1 : undefined;
        if (!lastUid) return;

        const toMark = [];
        for await (const msg of client.fetch({ uid: lastUid }, { uid: true, source: true, internalDate: true })) {
          try {
            const processed = await processMessage(msg, { baseDir, maxAttachmentSize, view });
            if (processed) {
              const subject = await extractSubject(msg);
              if (markSeen || (markSeenBySubject && subject)) {
                toMark.push({ uid: msg.uid, subject });
              }
            }
          } catch (e) {
            bus.emit('log', { level: 'error', msg: `Process NEW error: ${e?.message || e}` });
          }
        }
        await performMarking(client, toMark, { markSeen, markSeenBySubject });
      } finally {
        lock.release();
      }
    });
  };

  /**
   * Właściwe przetwarzanie wiadomości (zapisy PDF, emit row/update).
   * Zwraca true jeśli coś zrobiliśmy (np. zapis PDF), co kwalifikuje mail do oznaczenia \Seen.
   */
  async function processMessage(msg, { baseDir, maxAttachmentSize, view }) {
    const parsed = await simpleParser(msg.source);
    const when = msg.internalDate || new Date();

    const dateDir = path.join(baseDir, formatDateDir(when));
    ensureDir(dateDir);

    const subject = String(parsed.subject || '');
    const isDeliveryMail = /delivery/i.test(subject);
    const isEadMail = /\bead\b/i.test(subject);

    let wroteAny = false;
    let deliveryEmitted = false;
    let eadEmitted = false;

    for (const att of parsed.attachments || []) {
      const mime = String(att.contentType || '').toLowerCase();
      const name = String(att.filename || '').toLowerCase();
      const isPdf = mime.includes('application/pdf') || name.endsWith('.pdf');
      if (!isPdf) continue;

      try {
        const size = att.size ?? att.content?.length ?? 0;
        if (size > maxAttachmentSize) {
          bus.emit('log', { level: 'error', msg: `PDF skipped (too big: ${(size/1024/1024).toFixed(1)} MB): ${att.filename || 'unnamed'}` });
          continue;
        }

        const safeName = uniqueSafeName(dateDir, sanitizeFilename(att.filename || 'zalacznik.pdf'));
        const full = path.join(dateDir, safeName);

        fs.writeFileSync(full, att.content);
        wroteAny = true;

        const sha256 = hashSha256(att.content);
        bus.emit('log', { level: 'info', msg: `PDF saved: ${full} (${(size/1024).toFixed(1)} KB)` });
        bus.emit('pdf-saved', {
          path: full,
          filename: safeName,
          size,
          sha256,
          internalDate: when.toISOString(),
          from: parsed.from?.text || '',
          subject
        });

        // ====== DELIVERY: INSERT ======
        if (isDeliveryMail && !deliveryEmitted) {
          const delivery = await extractDeliveryFromDeliveryPdf(att.content);
          if (delivery) {
            const row = {
              delivery,
              data_wiadomosci: when.getTime(),
              status: 'Odebrano Delivery',
              korespondencja: subject,
              dane_techniczne: JSON.stringify({
                type: 'Delivery',
                subject,
                attachment: full,
                sha256,
                messageId: parsed.messageId || null,
              })
            };
            bus.emit('row', { view, row });
            bus.emit('log', { level: 'info', msg: `Export row ready (delivery=${delivery})` });
            deliveryEmitted = true;
          } else {
            bus.emit('log', { level: 'info', msg: `No "shipping note no." found in ${safeName}` });
          }
        }

        // ====== EAD: UPDATE/MAIL ======
        if (isEadMail && !eadEmitted) {
          const ead = await extractEadData(att.content);
          bus.emit('log', {
            level: 'info',
            msg: `[EAD] extracted -> delivery=${ead?.delivery || '-'}, MRN=${ead?.mrn || '-'}, date=${ead?.releaseDate || '-'}, proces=${ead?.proces || '-'}`
          });

          if (ead?.delivery) {
            bus.emit('ead-update', {
              delivery: ead.delivery,
              proces: ead.proces ?? null,
              numer_zamkniecia_mrn: ead.mrn ?? null,
              data_zamkniecia_mrn: ead.releaseDate ?? null,
              status: 'Rozesłano EAD',
              eadPath: full,
              eadSha256: sha256,
              eadSubject: subject
            });

            bus.emit('ead:action', {
              delivery: ead.delivery,
              updates: {
                proces: ead.proces ?? null,
                numer_zamkniecia_mrn: ead.mrn ?? null,
                data_zamkniecia_mrn: ead.releaseDate ?? null
              },
              mail: {
                subjectEad: subject,
                attachments: { eadPath: full }
              },
              cleanupPaths: [full]
            });

            bus.emit('log', { level: 'info', msg: `EAD updates emitted for delivery=${ead.delivery}` });
            eadEmitted = true;
          } else {
            bus.emit('log', { level: 'info', msg: `EAD: nie znaleziono [N325] w ${safeName}` });
          }
        }

        if ((isDeliveryMail && deliveryEmitted) || (isEadMail && eadEmitted)) break;

      } catch (e) {
        bus.emit('log', { level: 'error', msg: `PDF save/error: ${e?.message || e}` });
      }
    }

    if (!wroteAny) {
      bus.emit('log', { level: 'info', msg: `No PDF attachments in message: ${subject || '(no subject)'}` });
    }

    return wroteAny;
  }

  await connect();

  return {
    async stop() {
      stopping = true;
      try { await client?.logout?.(); } catch {}
      try { client?.close?.(); } catch {}
    }
  };
}

/* ===================== MARKING (po FETCH) ===================== */

async function performMarking(client, items, { markSeen, markSeenBySubject }) {
  if (!Array.isArray(items) || !items.length) return;

  // 1) Najpierw oznaczamy bieżące maile (UIDy)
  if (markSeen) {
    const uids = items.map(i => i.uid).filter(Boolean);
    if (uids.length) {
      try {
        bus.emit('log', { level: 'info', msg: `Trying to mark \\Seen uid(s)=${uids.join(',')}` });
        await withTimeout(client.messageFlagsAdd(uids, ['\\Seen'], { uid: true }), FLAGS_TIMEOUT_MS, 'messageFlagsAdd');
        bus.emit('log', { level: 'info', msg: `Marked \\Seen uid(s)=${uids.join(',')}` });
      } catch (e) {
        bus.emit('log', { level: 'error', msg: `Mark \\Seen failed for uid(s)=${uids.join(',')}: ${e?.message || e}` });
      }
    }
  }

  // 2) Potem „domykanie” po temacie (pomijamy już oznaczony UID)
  if (markSeenBySubject) {
    // grupuj po temacie, aby nie robić X razy tego samego searcha
    const bySubject = new Map();
    for (const it of items) {
      const subj = (it.subject || '').trim();
      if (!subj) continue;
      if (!bySubject.has(subj)) bySubject.set(subj, []);
      bySubject.get(subj).push(it.uid);
    }

    for (const [subject, skipUids] of bySubject.entries()) {
      try {
        // UID-mode search
        const allUnseen = await client.search({ seen: false, header: { subject } }, { uid: true });
        const targets = (allUnseen || []).filter(u => u && !skipUids.includes(u));
        if (!targets.length) {
          bus.emit('log', { level: 'info', msg: `[SeenBySubject] no other UNSEEN with subject "${truncate(subject, 120)}"` });
          continue;
        }
        await withTimeout(client.messageFlagsAdd(targets, ['\\Seen'], { uid: true }), FLAGS_TIMEOUT_MS, 'bulk messageFlagsAdd');
        bus.emit('log', { level: 'info', msg: `[SeenBySubject] marked ${targets.length} msg(s) as \\Seen for subject "${truncate(subject, 120)}"` });
      } catch (e) {
        bus.emit('log', { level: 'error', msg: `[SeenBySubject] failed: ${e?.message || e}` });
      }
    }
  }
}

/* ===================== PARSERY PDF ===================== */

async function extractDeliveryFromDeliveryPdf(buf) {
  const text = await pdfToText(buf);
  if (!text) return null;
  const m = /shipping\s*note\s*no\.?\s*[:\-]?\s*([A-Za-z0-9\s]{8,})/i.exec(text);
  if (!m) return null;
  return (m[1] || '').replace(/\s+/g, '').slice(0, 8) || null;
}

async function extractEadData(buf) {
  const raw = await pdfToText(buf);
  if (!raw) return null;
  const text = raw.replace(/\u00A0/g, ' ');

  let delivery = null;
  const n325 = /(?:\[\s*N325\s*\]|(?:^|\b)N325\b)[:\s,-]*([A-Za-z0-9\s]{8,})/i.exec(text);
  if (n325) delivery = (n325[1] || '').replace(/\s+/g, '').slice(0, 8) || null;

  let proces = null;
  const pow = /(?:\[\s*POW01\s*\]|(?:^|\b)POW01\b)[:\s-]*([^\r\n]+)/i.exec(text);
  if (pow) {
    proces = (pow[1] || '').trim() || null;
  } else {
    const d9 = /(?:\[\s*9DK8\s*\]|(?:^|\b)9DK8\b)[:\s-]*([^\r\n]+)/i.exec(text);
    if (d9) proces = (d9[1] || '').trim() || null;
  }

  let mrn = null;
  const lbl = /(?:\bnr\s*)?mrn\b/i.exec(text);
  if (lbl) {
    const around = text.slice(lbl.index, Math.min(text.length, lbl.index + 250));
    const strictNear = around.match(/\b\d{2}PL[A-Z0-9]{14}\b/);
    if (strictNear) mrn = strictNear[0];
    if (!mrn) {
      const loose = around.match(/(\d{2})\s*P\s*L\s*([A-Z0-9\s\-]{14,})/);
      if (loose) {
        const cleaned = (loose[1] + 'PL' + loose[2]).replace(/[^0-9A-Z]/gi, '').toUpperCase();
        if (/^\d{2}PL[A-Z0-9]{14}/.test(cleaned)) mrn = cleaned.slice(0, 18);
      }
    }
  }
  if (!mrn) {
    const strictAll = text.match(/\b\d{2}PL[A-Z0-9]{14}\b/g);
    if (strictAll && strictAll.length) mrn = strictAll[0];
  }

  let releaseDate = null;
  const label = /Data\s*zwolnienia\s*do\s*wywozu\s*[:\-\u2013\u2014]?\s*/i.exec(text);
  if (label) {
    const tail = text.slice(label.index + label[0].length, label.index + label[0].length + 50);
    const dm = /([0-9]{4}\s*[-./\u2013\u2014]\s*[0-9]{1,2}\s*[-./\u2013\u2014]\s*[0-9]{1,2}|[0-9]{1,2}\s*[-./\u2013\u2014]\s*[-./\u2013\u2014]\s*[0-9]{4})/.exec(tail);
    if (dm) {
      let s = dm[1].replace(/[\u2013\u2014]/g, '-').replace(/\s+/g, '').replace(/\./g, '-').replace(/\//g, '-');
      const parts = s.split('-').filter(Boolean);
      if (parts.length === 3) {
        const pad2 = (x) => x.toString().padStart(2, '0');
        if (parts[0].length === 4) releaseDate = `${parts[0]}-${pad2(parts[1])}-${pad2(parts[2])}`;
        else if (parts[2].length === 4) releaseDate = `${parts[2]}-${pad2(parts[1])}-${pad2(parts[0])}`;
      }
    }
  }

  return { delivery, proces, mrn, releaseDate };
}

// PDF -> tekst
async function pdfToText(buf) {
  let pdfParse;
  try {
    ({ default: pdfParse } = await import('pdf-parse/lib/pdf-parse.js'));
  } catch (e) {
    bus.emit('log', { level: 'error', msg: `pdf-parse not available: ${e?.message || e}` });
    return null;
  }
  try {
    const { text } = await pdfParse(buf);
    return text || null;
  } catch (e) {
    bus.emit('log', { level: 'error', msg: `pdf-parse failed: ${e?.message || e}` });
    return null;
  }
}

/* ===================== helpers ===================== */
function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }
function delay(ms) { return new Promise(res => setTimeout(res, ms)); }
function formatDateDir(d) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function sanitizeFilename(name) {
  let s = String(name).replace(/[<>:"/\\|?*\x00-\x1F]/g, '_').replace(/\s+/g, ' ').trim();
  if (s.length > 180) {
    const extIdx = s.lastIndexOf('.');
    if (extIdx > 0 && extIdx >= s.length - 10) {
      const base = s.slice(0, 175);
      const ext = s.slice(extIdx);
      s = base + ext;
    } else {
      s = s.slice(0, 180);
    }
  }
  return s || 'plik.pdf';
}
function uniqueSafeName(dir, baseName) {
  let name = baseName, ext = '';
  const dot = baseName.lastIndexOf('.');
  if (dot > 0) { ext = baseName.slice(dot); name = baseName.slice(0, dot); }
  let candidate = `${name}${ext}`, i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${name}(${i})${ext}`; i++;
  }
  return candidate;
}
function hashSha256(buf) {
  try { return crypto.createHash('sha256').update(buf).digest('hex'); }
  catch { return undefined; }
}

async function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function extractSubject(msg) {
  try {
    const parsed = await simpleParser(msg.source);
    return (parsed.subject || '').toString().trim();
  } catch {
    return '';
  }
}

function truncate(s, n) {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}
