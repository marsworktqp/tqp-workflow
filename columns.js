/* ====== Columns logic (visibility + drag + popups) ====== */

const LS_COL = {
    order: (tableId) => `ui.${tableId}.columnOrder`,
    hidden: (tableId) => `ui.${tableId}.columnHidden`,
  };
  
  document.addEventListener('DOMContentLoaded', () => {
    // Przywrócenie preferencji i drag&drop dla obu tabel
    ['table-import', 'table-export'].forEach((id) => {
      restoreColumnPrefs(id);
      enableDragColumns(id);
    });
  
    // Handlery otwierania/zamykania menu
    wireColumnMenuTriggers();
  });
  
  /* ========== PUBLIC UI HOOKS ========== */
  function wireColumnMenuTriggers() {
    const btn = document.getElementById('btn-open-column-menu');
    const popup = document.getElementById('column-menu');
    const closeBtn = popup.querySelector('.close');
    const selectAllBtn = document.getElementById('cols-select-all');
    const deselectAllBtn = document.getElementById('cols-deselect-all');
  
    // Lewy klik w „Wybór kolumn”
    if (btn) {
      btn.addEventListener('click', (e) => {
        e.preventDefault();
        populateColumnMenu(); // przygotuj listę checkboksów
        openColumnMenuNearButton(btn);
      });
    }
  
    // Prawy klik na thead aktywnej tabeli
    // Podpinamy delegację: każde przełączenie taba będzie działać,
    // bo słuchamy na całym dokumencie i filtrujemy target.
    document.addEventListener('contextmenu', (e) => {
      const activeTable = getActiveTableElement();
      if (!activeTable) return;
  
      const head = activeTable.tHead;
      if (!head) return;
  
      // Czy klik był w obrębie thead aktywnej tabeli?
      if (head.contains(e.target)) {
        e.preventDefault();
        populateColumnMenu();
        openColumnMenuAt(e.clientX, e.clientY);
      }
    });
  
    // Zamykanie
    closeBtn?.addEventListener('click', () => closeColumnMenu());
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeColumnMenu();
    });
    // Klik poza popupem zamyka
    document.addEventListener('mousedown', (e) => {
      if (!popupIsOpen()) return;
      const popupEl = document.getElementById('column-menu');
      const btn = document.getElementById('btn-open-column-menu');
      if (!popupEl.contains(e.target) && !btn.contains(e.target)) {
        closeColumnMenu();
      }
    });
  
    // Zaznacz/Odznacz wszystkie
    selectAllBtn?.addEventListener('click', () => setAllColumnsVisibility(true));
    deselectAllBtn?.addEventListener('click', () => setAllColumnsVisibility(false));
  }
  
  /* ========== MENU ========== */
  function populateColumnMenu() {
    const table = getActiveTableElement();
    if (!table) return;
  
    const body = document.getElementById('column-menu-body');
    body.innerHTML = '';
  
    const tableId = table.id;
    const hidden = new Set(JSON.parse(localStorage.getItem(LS_COL.hidden(tableId)) || '[]'));
  
    table.querySelectorAll('thead th').forEach((th) => {
      const name = th.dataset.column;
      const row = document.createElement('label');
      const cb = document.createElement('input');
      cb.type = 'checkbox';
      cb.checked = !hidden.has(name);
  
      cb.addEventListener('change', () => {
        if (cb.checked) hidden.delete(name);
        else hidden.add(name);
        localStorage.setItem(LS_COL.hidden(tableId), JSON.stringify([...hidden]));
        applyColumnVisibility(tableId, hidden);
      });
  
      row.prepend(cb);
      row.appendChild(document.createTextNode(name));
      body.appendChild(row);
    });
  
    applyColumnVisibility(tableId, hidden);
  }
  
  function openColumnMenuNearButton(btn) {
    const popup = document.getElementById('column-menu');
    const rect = btn.getBoundingClientRect();
    // pozycja z prawej strony przycisku
    const left = Math.min(window.innerWidth - 340, rect.left);
    const top = rect.bottom + 8;
  
    popup.style.position = 'fixed';
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.display = 'flex';
  }
  
  function openColumnMenuAt(clientX, clientY) {
    const popup = document.getElementById('column-menu');
    // odsuniecie od krawędzi/przeciwdziałanie wyjściu poza ekran
    const maxLeft = window.innerWidth - 340;
    const maxTop = window.innerHeight - 40;
    const left = Math.min(maxLeft, Math.max(8, clientX));
    const top = Math.min(maxTop, Math.max(8, clientY));
  
    popup.style.position = 'fixed';
    popup.style.left = `${left}px`;
    popup.style.top = `${top}px`;
    popup.style.display = 'flex';
  }
  
  function closeColumnMenu() {
    const popup = document.getElementById('column-menu');
    if (popup) popup.style.display = 'none';
  }
  function popupIsOpen() {
    const popup = document.getElementById('column-menu');
    return popup && popup.style.display !== 'none' && popup.style.display !== '';
  }
  
  /* ========== WIDOCZNOŚĆ KOLUMN ========== */
  function setAllColumnsVisibility(show) {
    const table = getActiveTableElement();
    if (!table) return;
  
    const tableId = table.id;
    const allNames = [...table.querySelectorAll('thead th')].map((th) => th.dataset.column);
    const hidden = new Set(JSON.parse(localStorage.getItem(LS_COL.hidden(tableId)) || '[]'));
  
    if (show) {
      // pokaż wszystko
      allNames.forEach((n) => hidden.delete(n));
    } else {
      // ukryj wszystko
      allNames.forEach((n) => hidden.add(n));
    }
  
    localStorage.setItem(LS_COL.hidden(tableId), JSON.stringify([...hidden]));
    applyColumnVisibility(tableId, hidden);
  
    // Uaktualnij checkboxy w menu
    const body = document.getElementById('column-menu-body');
    [...body.querySelectorAll('label')].forEach((row) => {
      const text = row.textContent.trim();
      const cb = row.querySelector('input[type="checkbox"]');
      cb.checked = !hidden.has(text);
    });
  }
  
  function applyColumnVisibility(tableId, hiddenSet) {
    const table = document.getElementById(tableId);
    if (!table) return;
  
    const ths = [...table.querySelectorAll('thead th')];
    ths.forEach((th, idx) => {
      const col = th.dataset.column;
      toggleColCells(table, idx, hiddenSet.has(col));
    });
  }
  
  function toggleColCells(table, thIndex, hidden) {
    const th = table.tHead?.rows[0]?.children[thIndex];
    if (th) th.classList.toggle('hidden-col', hidden);
  
    table.tBodies[0]?.querySelectorAll('tr').forEach((tr) => {
      const td = tr.children[thIndex];
      if (td) td.classList.toggle('hidden-col', hidden);
    });
  }
  
  /* ========== DRAG & DROP KOLEJNOŚCI ========== */
  function enableDragColumns(tableId) {
    const table = document.getElementById(tableId);
    if (!table) return;
  
    const thead = table.querySelector('thead');
    if (!thead) return;
  
    let dragSrc = null;
  
    restoreColumnOrder(tableId);
  
    thead.addEventListener('dragstart', (e) => {
      const th = e.target.closest('th');
      if (!th) return;
      dragSrc = th;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', th.dataset.column);
    });
  
    thead.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    });
  
    thead.addEventListener('drop', (e) => {
      e.preventDefault();
      const thTarget = e.target.closest('th');
      if (!thTarget || !dragSrc || thTarget === dragSrc) return;
      moveColumn(table, indexOfTh(dragSrc), indexOfTh(thTarget));
      saveColumnOrder(tableId);
    });
  }
  
  function indexOfTh(th) {
    return [...th.parentElement.children].indexOf(th);
  }
  
  function moveColumn(table, from, to) {
    const headerRow = table.tHead.rows[0];
    const th = headerRow.children[from];
    if (!th) return;
  
    if (from < to) headerRow.insertBefore(th, headerRow.children[to + 1] || null);
    else headerRow.insertBefore(th, headerRow.children[to]);
  
    table.tBodies[0]?.querySelectorAll('tr').forEach((tr) => {
      const td = tr.children[from];
      if (!td) return;
      if (from < to) tr.insertBefore(td, tr.children[to + 1] || null);
      else tr.insertBefore(td, tr.children[to]);
    });
  }
  
  function saveColumnOrder(tableId) {
    const table = document.getElementById(tableId);
    if (!table) return;
    const order = [...table.querySelectorAll('thead th')].map((th) => th.dataset.column);
    localStorage.setItem(LS_COL.order(tableId), JSON.stringify(order));
  }
  
  function restoreColumnOrder(tableId) {
    const table = document.getElementById(tableId);
    if (!table) return;
  
    const savedOrder = JSON.parse(localStorage.getItem(LS_COL.order(tableId)) || 'null');
    if (!savedOrder) return;
  
    const current = [...table.querySelectorAll('thead th')].map((th) => th.dataset.column);
  
    savedOrder.forEach((colName, targetIdx) => {
      const curIdx = current.indexOf(colName);
      if (curIdx === -1) return;
      if (curIdx !== targetIdx) {
        moveColumn(table, curIdx, targetIdx);
        const el = current.splice(curIdx, 1)[0];
        current.splice(targetIdx, 0, el);
      }
    });
  }
  
  /* ========== RESTORE PREFS ========== */
  function restoreColumnPrefs(tableId) {
    restoreColumnOrder(tableId);
    const hidden = new Set(JSON.parse(localStorage.getItem(LS_COL.hidden(tableId)) || '[]'));
    applyColumnVisibility(tableId, hidden);
  }
  
  /* ========== HELPERS ========== */
  function getActiveTableElement() {
    const activeSection = document.querySelector('.tab-content.active');
    if (!activeSection) return null;
    const tableId = activeSection.dataset.table;
    return document.getElementById(tableId);
  }
  
  // Opcjonalnie wystaw API (gdybyś chciał wywołać ręcznie z konsoli)
  window.columnsAPI = {
    populateColumnMenu,
    openColumnMenuNearButton,
    openColumnMenuAt,
    closeColumnMenu,
  };
  
  // Reset ustawień

  document.getElementById('btn-reset-prefs')?.addEventListener('click', ()=>{
    ['table-import','table-export'].forEach(id=>{
      localStorage.removeItem(LS_COL.order(id));
      localStorage.removeItem(LS_COL.hidden(id));
      restoreColumnPrefs(id);
    });
  });
  