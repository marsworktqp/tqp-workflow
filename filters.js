/* ====== Filters logic ====== */

const LS = {
    filterHidden: (filtersId) => `ui.${filtersId}.filterHidden`
  };
  
  document.addEventListener('DOMContentLoaded', () => {
    attachFilters();
    wireFilterMenuUI();
  });
  
  /* === Attach filters to inputs === */
  function attachFilters(){
    document.querySelectorAll('.filter-input').forEach(inp=>{
      inp.addEventListener('input', applyFiltersThrottled);
      inp.addEventListener('change', applyFiltersThrottled);
    });
  
    // restore hidden filters visibility from localStorage
    restoreFilterVisibility('filters-import');
    restoreFilterVisibility('filters-export');
  
    // initial apply
    applyFilters();
  }
  
  const applyFiltersThrottled = throttle(applyFilters, 120);
  
  /* === Core filtering function === */
  function applyFilters(){
    document.querySelectorAll('.filter-section').forEach(section=>{
      const tableId = section.dataset.tableId;
      const table = document.getElementById(tableId);
      if(!table) return;
  
      const criteria = {};
      section.querySelectorAll('.filter-input').forEach(inp=>{
        const col = inp.dataset.col;
        const op  = inp.dataset.op;
        const val = inp.value?.trim();
        if(!val) return;
        if(op){
          criteria[col] = criteria[col] || {};
          criteria[col][op] = val;
        } else {
          criteria[col] = val;
        }
      });
  
      table.querySelectorAll('tbody tr').forEach(tr=>{
        let ok = true;
        for(const [col, val] of Object.entries(criteria)){
          const cell = tr.querySelector(`td[data-column="${cssEscape(col)}"]`);
          const text = (cell?.textContent || '').trim();
  
          if(typeof val === 'object'){ // date range
            const from = val.from ? new Date(val.from) : null;
            const to   = val.to   ? new Date(val.to)   : null;
            const cur  = text ? new Date(text) : null;
            if(from && (!cur || cur < from)) { ok=false; break; }
            if(to && (!cur || cur > to))     { ok=false; break; }
          } else {
            if(!text.toLowerCase().includes(String(val).toLowerCase())) { ok=false; break; }
          }
        }
        tr.style.display = ok ? '' : 'none';
      });
    });
  }
  
  /* === Filter menu (build + show/hide) === */
  
  function wireFilterMenuUI(){
    const btnOpen = document.getElementById('btn-open-filter-menu');
    const menu = document.getElementById('filter-menu');
    const btnClose = menu.querySelector('.close');
    const btnAll = document.getElementById('filters-select-all');
    const btnNone = document.getElementById('filters-deselect-all');
  
    // Lewy klik w przycisk „Menu filtrów”
    btnOpen?.addEventListener('click', (e)=>{
      e.stopPropagation();
      populateFilterMenu();
      openFilterMenuNearButton(menu, btnOpen);
    });
  
    // Prawy klik na aktywnej sekcji filtrów – pokaż w miejscu kursora
    document.addEventListener('contextmenu', (ev)=>{
      const activeFiltersSection = document.querySelector('.filter-section.active');
      if(activeFiltersSection && activeFiltersSection.contains(ev.target)){
        ev.preventDefault();
        populateFilterMenu();
        openFilterMenuAt(ev.pageX, ev.pageY);
      }
    });
  
    // Lewy klik w TŁO aktywnej sekcji filtrów (nie w input/label/przyciski) – otwórz obok przycisku
    document.addEventListener('click', (ev)=>{
      const activeFiltersSection = document.querySelector('.filter-section.active');
      if(!activeFiltersSection) return;
  
      const clickedInsideFilters = activeFiltersSection.contains(ev.target);
      const isInteractive = ev.target.closest('input, select, textarea, label, button, .popup');
      const clickedMenuButton = ev.target.closest('#btn-open-filter-menu');
  
      if(clickedMenuButton) return; // to ogarnia handler powyżej
      if(clickedInsideFilters && !isInteractive){
        populateFilterMenu();
        openFilterMenuNearButton(menu, btnOpen || activeFiltersSection); // jak nie ma przycisku, bazuj na sekcji
      }
    });
  
    btnClose?.addEventListener('click', hideFilterMenu);
  
    btnAll?.addEventListener('click', ()=>{
      const active = document.querySelector('.filter-section.active');
      if(!active) return;
      const id = active.id;
      const hidden = new Set(); // widoczne wszystkie
      localStorage.setItem(LS.filterHidden(id), JSON.stringify([...hidden]));
      applyFilterVisibility(id, hidden);
      populateFilterMenu(); // odśwież checkboxy
    });
  
    btnNone?.addEventListener('click', ()=>{
      const active = document.querySelector('.filter-section.active');
      if(!active) return;
      const id = active.id;
      const allKeys = [...active.querySelectorAll('.filter')].map(getFilterKey);
      const hidden = new Set(allKeys); // ukryj wszystkie
      localStorage.setItem(LS.filterHidden(id), JSON.stringify([...hidden]));
      applyFilterVisibility(id, hidden);
      populateFilterMenu();
    });
  
    // zamykanie po kliknięciu poza
    document.addEventListener('click', (ev)=>{
      if(!menuIsOpen()) return;
      const within = menu.contains(ev.target) || ev.target.closest('#btn-open-filter-menu');
      if(!within) hideFilterMenu();
    }, true);
  
    // zamykanie klawiszem Esc
    document.addEventListener('keydown', (ev)=>{
      if(ev.key === 'Escape' && menuIsOpen()) hideFilterMenu();
    });
  }
  
  function populateFilterMenu(){
    const activeFiltersSection = document.querySelector('.filter-section.active');
    if(!activeFiltersSection) return;
  
    const id = activeFiltersSection.id;
    const body = document.getElementById('filter-menu-body');
    body.innerHTML = '';
  
    const hidden = new Set(JSON.parse(localStorage.getItem(LS.filterHidden(id)) || '[]'));
  
    activeFiltersSection.querySelectorAll('.filter').forEach(f=>{
      const labelText = f.querySelector('label')?.textContent?.trim() || '(bez nazwy)';
      const key = getFilterKey(f);
  
      const row = document.createElement('label');
      row.style.display = 'flex';
      row.style.alignItems = 'center';
      row.style.gap = '8px';
  
      const cb = document.createElement('input');
      cb.type='checkbox';
      cb.checked = !hidden.has(key);
      cb.addEventListener('change', ()=>{
        if(cb.checked) hidden.delete(key); else hidden.add(key);
        localStorage.setItem(LS.filterHidden(id), JSON.stringify([...hidden]));
        applyFilterVisibility(id, hidden);
      });
  
      row.appendChild(cb);
      row.appendChild(document.createTextNode(labelText));
      body.appendChild(row);
    });
  
    applyFilterVisibility(id, hidden);
  }
  
  /* === Show/Hide helpers === */
  function openFilterMenuNearButton(menu, anchor){
    menu.style.display = 'flex';
  
    // jeśli anchor to sekcja (brak przycisku), ustaw w jej lewym górnym rogu
    const rect = anchor.getBoundingClientRect();
    const scrollX = window.scrollX || document.documentElement.scrollLeft;
    const scrollY = window.scrollY || document.documentElement.scrollTop;
  
    const left = rect.left + scrollX;
    const top  = rect.bottom + 8 + scrollY;
  
    menu.style.position = 'absolute';
    menu.style.left = `${left}px`;
    menu.style.top  = `${top}px`;
  }
  
  function openFilterMenuAt(x,y){
    const menu = document.getElementById('filter-menu');
    menu.style.display = 'flex';
    menu.style.position = 'absolute';
    menu.style.left = `${x}px`;
    menu.style.top  = `${y}px`;
  }
  
  function hideFilterMenu(){
    const menu = document.getElementById('filter-menu');
    menu.style.display = 'none';
  }
  function menuIsOpen(){
    const menu = document.getElementById('filter-menu');
    return menu && menu.style.display !== 'none' && menu.offsetParent !== null;
  }
  
  /* === Apply/restore visibility === */
  function applyFilterVisibility(filtersId, hiddenSet){
    const section = document.getElementById(filtersId);
    section.querySelectorAll('.filter').forEach(f=>{
      const key = getFilterKey(f);
      f.style.display = hiddenSet.has(key) ? 'none' : '';
    });
  }
  
  function restoreFilterVisibility(filtersId){
    const hidden = new Set(JSON.parse(localStorage.getItem(LS.filterHidden(filtersId)) || '[]'));
    applyFilterVisibility(filtersId, hidden);
  }
  
  function getFilterKey(filterDiv){
    const inputs = [...filterDiv.querySelectorAll('input.filter-input')]
      .map(i=>`${i.dataset.col}:${i.dataset.op||''}`);
    return inputs.join('|');
  }
  
  /* === Utils === */
  function throttle(fn, ms){
    let t=0, lastArgs=null, to=null;
    return function(...args){
      const now = Date.now();
      if(now - t >= ms){ t=now; fn.apply(this,args); }
      else{
        lastArgs=args; clearTimeout(to);
        to=setTimeout(()=>{ t=Date.now(); fn.apply(this,lastArgs); }, ms-(now-t));
      }
    }
  }
  
  function cssEscape(str){
    if(window.CSS && CSS.escape) return CSS.escape(str);
    return String(str).replace(/["\\]/g,'\\$&');
  }
  
  /* expose for index.html buttons (opcjonalnie) */
  window.filtersAPI = { populateFilterMenu };

  // Reset ustawień
  
  document.getElementById('btn-reset-prefs')?.addEventListener('click', ()=>{
    localStorage.removeItem(LS.filterHidden('filters-import'));
    localStorage.removeItem(LS.filterHidden('filters-export'));
    restoreFilterVisibility('filters-import');
    restoreFilterVisibility('filters-export');
    applyFilters();
  });
  