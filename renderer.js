// renderer.js
(() => {
  // ===== helpers =====
  const $ = (sel, root = document) => root.querySelector(sel);

  // mapowanie nagłówków -> klucze w bazie (transliteracja PL + spacje->_)
  function toDbKey(colName) {
    return String(colName)
      .toLowerCase()
      .replace(/\s+/g, '_')
      .replace(/ą/g,'a').replace(/ć/g,'c').replace(/ę/g,'e')
      .replace(/ł/g,'l').replace(/ń/g,'n').replace(/ó/g,'o')
      .replace(/ś/g,'s').replace(/ż/g,'z').replace(/ź/g,'z');
  }

  // które kolumny są datami? (prosto: wszystko zaczynające się od data_)
  const isDateKey = (key) => key.startsWith('data_');

  // format daty (epoch ms -> YYYY-MM-DD)
  function fmtDate(v) {
    if (v == null || v === '') return '';
    const ms = typeof v === 'number' ? v : Date.parse(v);
    if (Number.isNaN(ms)) return String(v);
    const d = new Date(ms);
    const y = d.getFullYear();
    const m = String(d.getMonth()+1).padStart(2,'0');
    const dd = String(d.getDate()).padStart(2,'0');
    return `${y}-${m}-${dd}`;
  }

  function escapeHtml(s) {
    return String(s)
      .replaceAll('&','&amp;')
      .replaceAll('<','&lt;')
      .replaceAll('>','&gt;')
      .replaceAll('"','&quot;')
      .replaceAll("'",'&#39;');
  }

  // po renderze — jeśli masz filtry, „dociśnij” ich działanie
  function reapplyFiltersIfAny() {
    try {
      if (typeof window.applyFilters === 'function') {
        window.applyFilters();
      } else if (window.filtersAPI?.applyNow) {
        window.filtersAPI.applyNow();
      }
    } catch (e) {
      // cicho ignoruj
    }
  }

  // ===== rendering (pełny) =====
  async function renderTable(view) {
    // view: 'import' | 'export'
    const tableId = view === 'import' ? 'table-import' : 'table-export';
    const table = document.getElementById(tableId);
    const tbody = table?.querySelector('tbody');
    if (!table || !tbody) return;

    const rows = await window.api.getRows(view);

    // trzymaj kolejność wg aktualnych TH (działa z drag&drop + ukrywaniem kolumn)
    const ths = table.querySelectorAll('thead th');

    const html = rows.map(row => {
      const tds = [...ths].map(th => {
        const colName = th.dataset.column;           // np. "Numer Zamknięcia MRN"
        const key = toDbKey(colName);                // -> "numer_zamkniecia_mrn"
        const raw = row[key];
        const txt = isDateKey(key) ? fmtDate(raw) : (raw ?? '');
        return `<td data-column="${escapeHtml(colName)}">${escapeHtml(txt)}</td>`;
      }).join('');
      return `<tr>${tds}</tr>`;
    }).join('');

    tbody.innerHTML = html;

    reapplyFiltersIfAny();
  }

  // ===== partial update (bez pełnego rerenderu) =====
  function updateRowInPlace(view, newRow) {
    if (!newRow) return false;

    const tableId = view === 'import' ? 'table-import' : 'table-export';
    const table = document.getElementById(tableId);
    const tbody = table?.querySelector('tbody');
    if (!table || !tbody) return false;

    const ths = [...table.querySelectorAll('thead th')];
    if (!ths.length) return false;

    // znajdź indeks kolumny "Delivery"
    const idxDelivery = ths.findIndex(th => toDbKey(th.dataset.column) === 'delivery');
    if (idxDelivery === -1) return false;

    // znajdź TR po wartości w kolumnie Delivery
    const trs = [...tbody.querySelectorAll('tr')];
    const target = trs.find(tr => {
      const cell = tr.children[idxDelivery];
      return cell && cell.textContent.trim() === String(newRow.delivery || '').trim();
    });

    if (!target) return false;

    // uaktualnij tylko widoczne kolumny obecne w nagłówku
    ths.forEach((th, i) => {
      const colName = th.dataset.column;
      const key = toDbKey(colName);
      if (!(key in newRow)) return; // nie nadpisuj, jeśli back nie podał tej kolumny
      const cell = target.children[i];
      if (!cell) return;

      const raw = newRow[key];
      const txt = isDateKey(key) ? fmtDate(raw) : (raw ?? '');
      cell.textContent = txt;
    });

    reapplyFiltersIfAny();
    return true;
  }

  // ===== start / events =====
  document.addEventListener('DOMContentLoaded', async () => {
    // pierwszy załadunek danych
    await Promise.all([renderTable('import'), renderTable('export')]);

    // odśwież, gdy main wyśle info o nowym rekordzie
    window.api.onRowInserted(async ({ view }) => {
      if (view === 'import' || view === 'export') {
        await renderTable(view);
      }
    });

    // NOWE: odśwież, gdy main wyśle info o AKTUALIZACJI (EAD)
    window.api.onRowUpdated(async ({ view, row }) => {
      if (view !== 'import' && view !== 'export') return;
      // spróbuj bez migotania – update in-place; jeśli się nie uda, zrób pełny render
      const ok = updateRowInPlace(view, row);
      if (!ok) await renderTable(view);
    });

    // przełączanie zakładek — dociągnij dane dla aktywnej
    document.querySelectorAll('.tab-button').forEach(btn => {
      btn.addEventListener('click', () => {
        const tab = btn.dataset.tab; // 'import' | 'export'
        renderTable(tab);
      });
    });

    // ==== KONFIGURACJE PROCESÓW: modal + zapis do SQLite (IPC) ====
    (function setupProcessConfigsModal(){
      const openBtn  = $('#btn-open-process-config');
      const overlay  = $('#pc-overlay');
      const closeBtn = $('#pc-close');
      const addBtn   = $('#pc-add');
      const tbody    = $('#pc-tbody');

      if (!openBtn || !overlay || !closeBtn || !addBtn || !tbody) return; // brak modala w DOM

      const ipcInvoke = (channel, ...args) => {
        if (window.api?.invoke) return window.api.invoke(channel, ...args);
        return Promise.reject(new Error('IPC unavailable: window.api.invoke missing'));
      };

      function openModal(){
        overlay.classList.add('is-open');
        overlay.setAttribute('aria-hidden','false');
        document.body.classList.add('pc-no-scroll');
        loadRows();
      }
      function closeModal(){
        overlay.classList.remove('is-open');
        overlay.setAttribute('aria-hidden','true');
        document.body.classList.remove('pc-no-scroll');
      }

      function createCellInput(placeholder, name){
        const input = document.createElement('input');
        input.type = 'text';
        input.className = 'pc-input';
        input.placeholder = placeholder || '';
        input.name = name;

        // Enter = tylko potwierdza (blur), bez dodawania wiersza
        input.addEventListener('keydown', (e)=>{
          if (e.key === 'Enter') {
            e.preventDefault();
            e.currentTarget.blur();
          }
        });

        // Po zmianie focusu zapis do DB
        input.addEventListener('blur', handleCommitEdit);
        return input;
      }

      function createRow({ id=null, proces='', emails='' } = {}){
        const tr = document.createElement('tr');
        if (id != null) tr.dataset.id = String(id);

        const td1 = document.createElement('td');
        const inpProces = createCellInput('np. DSK, IE043, Zawiadomienia', 'Proces');
        inpProces.value = proces;
        td1.appendChild(inpProces);

        const td2 = document.createElement('td');
        const inpEmails = createCellInput('np. anna@firma.pl; jan@firma.pl', 'Adresy mailowe');
        inpEmails.value = emails;
        td2.appendChild(inpEmails);

        const td3 = document.createElement('td');
        td3.style.textAlign = 'right';
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'pc-icon-btn pc-icon-btn--danger pc-row-del';
        delBtn.title = 'Usuń wiersz';
        delBtn.setAttribute('aria-label','Usuń wiersz');
        delBtn.textContent = '🗑 Usuń';
        td3.appendChild(delBtn);

        tr.appendChild(td1);
        tr.appendChild(td2);
        tr.appendChild(td3);
        return tr;
      }

      function addEmptyRowToUI(){
        const tr = createRow();
        tbody.appendChild(tr);
        tr.querySelector('input[name="Proces"]')?.focus();
      }

      async function loadRows(){
        tbody.innerHTML = '';
        try {
          const rows = await ipcInvoke('pc:list');
          if (rows && rows.length) {
            for (const r of rows) {
              tbody.appendChild(createRow({ id: r.id, proces: r.proces || '', emails: r.emails || '' }));
            }
          } else {
            addEmptyRowToUI();
          }
        } catch (e) {
          console.error('pc:list error', e);
          addEmptyRowToUI();
        }
      }

      async function handleCommitEdit(e){
        const input = e.currentTarget;
        const tr = input.closest('tr');
        if (!tr) return;

        const id = tr.dataset.id ? Number(tr.dataset.id) : null;
        const proces = tr.querySelector('input[name="Proces"]')?.value?.trim() || '';
        const emails = tr.querySelector('input[name="Adresy mailowe"]')?.value?.trim() || '';

        // nic do zapisania
        if (!proces && !emails) return;

        try {
          if (id == null) {
            // INSERT – jeśli mamy cokolwiek wpisane
            const res = await ipcInvoke('pc:insert', { proces, emails });
            if (res?.ok && res?.id != null) {
              tr.dataset.id = String(res.id);
            }
          } else {
            // UPDATE – pełny upsert pól
            await ipcInvoke('pc:update', { id, proces, emails });
          }
        } catch (err) {
          console.error('pc:commit error', err);
        }
      }

      // Delegacja: usuwanie wierszy
      tbody.addEventListener('click', async (e)=>{
        const btn = e.target.closest('.pc-row-del');
        if (!btn) return;
        const tr = btn.closest('tr');
        if (!tr) return;

        const id = tr.dataset.id ? Number(tr.dataset.id) : null;

        try {
          if (id != null) {
            await ipcInvoke('pc:delete', { id });
          }
        } catch (err) {
          console.error('pc:delete error', err);
        } finally {
          tr.remove();
          if (!tbody.children.length) addEmptyRowToUI();
        }
      });

      // Handlery otwierania/zamykania
      openBtn.addEventListener('click', openModal);
      closeBtn.addEventListener('click', closeModal);
      overlay.addEventListener('click', (e)=>{ if (e.target === overlay) closeModal(); });
      document.addEventListener('keydown', (e)=>{ if (e.key === 'Escape' && overlay.classList.contains('is-open')) closeModal(); });

      // Dodaj wiersz
      addBtn.addEventListener('click', addEmptyRowToUI);
    })();
    // ==== /KONFIGURACJE PROCESÓW ====

  });
  // opcjonalnie wystaw do konsoli
  window.__renderTable = renderTable;
})();
