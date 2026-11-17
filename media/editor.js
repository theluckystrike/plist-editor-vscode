// Plist editor webview: a Key / Type / Value tree like Xcode's, drawn as a virtual list (only visible rows exist in the
// DOM, so plists with 100,000 entries scroll smoothly). The extension host owns the document; every change goes there
// as an edit and comes back as the new tree, so undo, redo, save and hot exit stay with VS Code.
(function () {
  'use strict';
  const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : acquireVsCodeApi();
  const ROW = 22;
  const TYPES = [['dict', 'Dictionary'], ['array', 'Array'], ['bool', 'Boolean'], ['data', 'Data'], ['date', 'Date'], ['integer', 'Number'], ['real', 'Number (decimal)'], ['string', 'String']];
  const TYPE_LABEL = { dict: 'Dictionary', array: 'Array', string: 'String', integer: 'Number', real: 'Number', bool: 'Boolean', date: 'Date', data: 'Data', uid: 'UID', null: 'Null' };

  const $ = (s) => document.querySelector(s);
  const app = $('#app');
  let state = { tree: null, readOnly: false, keys: {}, showNames: true, format: '', issues: new Map() };
  const expanded = new Set(['']); // key-path ids; the root is open
  let rows = [];
  let sel = 0;
  let editing = null; // { rowIndex, field }
  let filter = '';
  let matches = [];
  let matchAt = -1;
  let pendingFocus = null;
  let firstRender = true;

  // ---------- helpers ----------
  const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const isBox = (n) => n && (n.t === 'dict' || n.t === 'array');
  function b64hex(b64, max) {
    let bin = '';
    try { bin = atob(b64); } catch (e) { return ''; }
    const n = Math.min(bin.length, max);
    let out = '';
    for (let i = 0; i < n; i++) { out += bin.charCodeAt(i).toString(16).padStart(2, '0'); if (i % 4 === 3 && i < n - 1) out += ' '; }
    return { hex: out, len: bin.length };
  }
  function display(n) {
    switch (n.t) {
      case 'dict': case 'array': return `(${n.v.length} item${n.v.length === 1 ? '' : 's'})`;
      case 'bool': return n.v ? 'YES' : 'NO';
      case 'real': return Number.isInteger(n.v) ? n.v.toFixed(1) : String(n.v);
      case 'data': { const h = b64hex(n.v, 48); return `<${h.hex}${h.len > 48 ? ' ...' : ''}>  ${h.len.toLocaleString()} bytes`; }
      case 'date': return n.v.replace('T', ' ').replace('Z', ' UTC');
      case 'uid': return `UID ${n.v}`;
      case 'null': return 'null';
      default: return String(n.v);
    }
  }
  function editText(n) {
    if (n.t === 'data') { const h = b64hex(n.v, 1 << 20); return h.hex; }
    if (n.t === 'bool') return n.v ? 'YES' : 'NO';
    if (n.t === 'real') return String(n.v);
    return String(n.v);
  }
  const childId = (id, k) => id + '\u0001' + k;

  // ---------- rows ----------
  function matchesFilter(key, n) {
    if (!filter) return false;
    const f = filter.toLowerCase();
    if (String(key).toLowerCase().includes(f)) return true;
    if (!isBox(n) && n.t !== 'data' && String(n.v).toLowerCase().includes(f)) return true;
    const ki = state.keys[key];
    return !!(ki && ki.name.toLowerCase().includes(f));
  }
  function subtreeHas(n, key) {
    if (matchesFilter(key, n)) return true;
    if (n.t === 'dict') return n.v.some(([k, c]) => subtreeHas(c, k));
    if (n.t === 'array') return n.v.some((c, i) => subtreeHas(c, `Item ${i}`));
    return false;
  }
  function build() {
    rows = [];
    matches = [];
    if (!state.tree) return;
    const walk = (n, key, depth, path, id, parentType) => {
      if (filter && !subtreeHas(n, key) && depth > 0) return;
      const open = filter ? isBox(n) : expanded.has(id);
      const r = { n, key, depth, path, id, parentType, open };
      if (filter && matchesFilter(key, n) && depth > 0) { r.match = true; matches.push(rows.length); }
      rows.push(r);
      if (isBox(n) && open) {
        if (n.t === 'dict') n.v.forEach(([k, c], i) => walk(c, k, depth + 1, path.concat(i), childId(id, 'k' + k), 'dict'));
        else n.v.forEach((c, i) => walk(c, `Item ${i}`, depth + 1, path.concat(i), childId(id, 'i' + i), 'array'));
      }
    };
    walk(state.tree, 'Root', 0, [], '', null);
    if (sel >= rows.length) sel = Math.max(0, rows.length - 1);
  }
  const pathKey = (p) => p.join('/');

  // ---------- render ----------
  const grid = $('#grid');
  const spacer = $('#spacer');
  const body = $('#rows');
  function render() {
    spacer.style.height = rows.length * ROW + 'px';
    const top = grid.scrollTop;
    const h = grid.clientHeight || 600;
    const from = Math.max(0, Math.floor(top / ROW) - 10);
    const to = Math.min(rows.length, Math.ceil((top + h) / ROW) + 10);
    body.style.transform = `translateY(${from * ROW}px)`;
    let html = '';
    for (let i = from; i < to; i++) html += rowHtml(rows[i], i);
    body.innerHTML = html;
    // The CSP blocks inline style attributes in markup, so the indent is set through the CSSOM (allowed).
    for (const el of body.querySelectorAll('.c.key[data-d]')) el.style.paddingLeft = (6 + Number(el.dataset.d) * 16) + 'px';
    $('#count').textContent = filter ? `${matches.length} match${matches.length === 1 ? '' : 'es'}` : '';
  }
  function rowHtml(r, i) {
    const n = r.n;
    const issue = state.issues.get(pathKey(r.path));
    const ki = r.parentType === 'dict' ? state.keys[r.key] : null;
    const keyLabel = r.depth === 0 ? 'Root' : esc(r.key);
    const name = ki && state.showNames ? `<span class="kname">${esc(ki.name)}</span>` : '';
    const tip = ki ? ` title="${esc(r.key + ': ' + ki.note)}"` : '';
    const twisty = isBox(n) ? `<span class="tw ${r.open ? 'open' : ''}" data-act="toggle">${r.open ? '&#9662;' : '&#9656;'}</span>` : '<span class="tw"></span>';
    const typeLabel = n.t === 'real' ? 'Number' : TYPE_LABEL[n.t] || n.t;
    const keyEditable = r.parentType === 'dict' && !state.readOnly;
    const valueClass = isBox(n) ? 'v dim' : n.t === 'bool' ? 'v bool' : 'v';
    const btns = state.readOnly ? '' : `<span class="btns"><button class="b" data-act="add" title="Add an item (Enter on the row adds a sibling, + on an open container adds a child)" aria-label="Add item">+</button>${r.depth ? '<button class="b" data-act="del" title="Delete (Delete key)" aria-label="Delete item">&minus;</button>' : ''}</span>`;
    return `<div class="row${i === sel ? ' sel' : ''}${r.match ? ' match' : ''}${issue ? ' issue-' + issue.level : ''}" data-i="${i}" role="treeitem" aria-level="${r.depth + 1}" aria-expanded="${isBox(n) ? r.open : ''}">`
      + `<div class="c key" data-d="${r.depth}"${tip}>${twisty}<span class="k${keyEditable ? ' ed' : ''}" data-f="key">${keyLabel}</span>${name}</div>`
      + `<div class="c type"><span class="t${state.readOnly ? '' : ' ed'}" data-f="type">${esc(typeLabel)}</span>${btns}</div>`
      + `<div class="c value"><span class="${valueClass}${!isBox(n) && !state.readOnly && n.t !== 'uid' && n.t !== 'null' ? ' ed' : ''}" data-f="value"${issue ? ` title="${esc(issue.message)}"` : ''}>${esc(display(n))}</span></div>`
      + '</div>';
  }

  // ---------- editing ----------
  function post(m) { vscode.postMessage(m); }
  function edit(op) { post({ type: 'edit', op }); }
  function startEdit(i, field, again) {
    const r = rows[i];
    if (!r || state.readOnly) return;
    const el = body.querySelector(`.row[data-i="${i}"] [data-f="${field}"]`);
    if (!el) { editing = { rowIndex: i, field }; return; }
    if (field === 'key' && r.parentType !== 'dict') return;
    if (field === 'value' && (isBox(r.n) || r.n.t === 'uid' || r.n.t === 'null')) return;
    editing = { rowIndex: i, field };
    if (field === 'type') {
      const s = document.createElement('select');
      s.className = 'inline';
      s.setAttribute('aria-label', 'Type');
      for (const [t, l] of TYPES) { const o = document.createElement('option'); o.value = t; o.textContent = l; if (t === r.n.t) o.selected = true; s.appendChild(o); }
      el.replaceWith(s);
      s.focus();
      const done = (commit) => { if (!editing) return; editing = null; if (commit && s.value !== r.n.t) edit({ op: 'setType', path: r.path, t: s.value }); else render(); };
      s.addEventListener('change', () => done(true));
      s.addEventListener('blur', () => done(false));
      s.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); grid.focus(); } if (e.key === 'Enter') { e.preventDefault(); done(true); grid.focus(); } });
      return;
    }
    if (field === 'value' && r.n.t === 'bool') {
      const s = document.createElement('select');
      s.className = 'inline';
      s.setAttribute('aria-label', 'Value');
      for (const v of ['YES', 'NO']) { const o = document.createElement('option'); o.value = v; o.textContent = v; if ((v === 'YES') === r.n.v) o.selected = true; s.appendChild(o); }
      el.replaceWith(s);
      s.focus();
      const done = (commit) => { if (!editing) return; editing = null; if (commit && (s.value === 'YES') !== r.n.v) edit({ op: 'setValue', path: r.path, text: s.value }); else render(); };
      s.addEventListener('change', () => done(true));
      s.addEventListener('blur', () => done(false));
      s.addEventListener('keydown', (e) => { if (e.key === 'Escape') { e.preventDefault(); done(false); grid.focus(); } if (e.key === 'Enter') { e.preventDefault(); done(true); grid.focus(); } });
      return;
    }
    const inp = document.createElement('input');
    inp.className = 'inline';
    inp.spellcheck = false;
    inp.setAttribute('aria-label', field === 'key' ? 'Key' : 'Value');
    inp.value = again && editing.text !== undefined ? editing.text : field === 'key' ? r.key : editText(r.n);
    if (field === 'value' && r.n.t === 'date') inp.placeholder = '2026-11-13T09:30:00Z';
    if (field === 'value' && r.n.t === 'data') inp.placeholder = 'hex bytes, for example 00 1f a2';
    el.replaceWith(inp);
    inp.focus();
    if (!again) inp.select();
    inp.addEventListener('input', () => { if (editing) editing.text = inp.value; });
    const done = (commit) => {
      if (!editing) return;
      editing = null;
      if (commit) {
        if (field === 'key' && inp.value !== r.key) edit({ op: 'setKey', path: r.path, key: inp.value });
        else if (field === 'value' && inp.value !== editText(r.n)) edit({ op: 'setValue', path: r.path, text: inp.value });
        else render();
      } else render();
    };
    inp.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); done(true); grid.focus(); }
      else if (e.key === 'Escape') { e.preventDefault(); done(false); grid.focus(); }
      else if (e.key === 'Tab') { e.preventDefault(); const next = field === 'key' ? 'value' : null; done(true); if (next) setTimeout(() => startEdit(i, next), 30); }
      e.stopPropagation();
    });
    inp.addEventListener('blur', () => done(true));
  }

  function addAt(i) {
    const r = rows[i];
    if (!r || state.readOnly) return;
    if (isBox(r.n) && (r.open || r.depth === 0)) {
      expanded.add(r.id);
      edit({ op: 'insert', parent: r.path, index: 0, focus: true });
    } else {
      edit({ op: 'insert', parent: r.path.slice(0, -1), index: r.path[r.path.length - 1] + 1, focus: true });
    }
  }
  function del(i) {
    const r = rows[i];
    if (!r || !r.depth || state.readOnly) return;
    edit({ op: 'remove', parent: r.path.slice(0, -1), index: r.path[r.path.length - 1] });
  }
  function move(i, d) {
    const r = rows[i];
    if (!r || !r.depth || state.readOnly) return;
    const idx = r.path[r.path.length - 1];
    const parent = r.path.slice(0, -1);
    const to = idx + d;
    edit({ op: 'move', parent, from: idx, to, focusPath: parent.concat(to) });
  }
  function dup(i) {
    const r = rows[i];
    if (!r || !r.depth || state.readOnly) return;
    edit({ op: 'duplicate', path: r.path });
  }

  function toggle(i, open) {
    const r = rows[i];
    if (!r || !isBox(r.n) || filter) return;
    const want = open === undefined ? !expanded.has(r.id) : open;
    if (want) expanded.add(r.id); else expanded.delete(r.id);
    build(); render();
  }
  function expandAll(open) {
    const walk = (n, id) => { if (!isBox(n)) return; if (open) expanded.add(id); if (n.t === 'dict') n.v.forEach(([k, c]) => walk(c, childId(id, 'k' + k))); else n.v.forEach((c, i) => walk(c, childId(id, 'i' + i))); };
    if (!open) { expanded.clear(); expanded.add(''); } else walk(state.tree, '');
    build(); render();
  }
  function select(i, scroll) {
    sel = Math.max(0, Math.min(rows.length - 1, i));
    if (scroll) {
      const top = sel * ROW;
      if (top < grid.scrollTop) grid.scrollTop = top;
      else if (top + ROW > grid.scrollTop + grid.clientHeight) grid.scrollTop = top + ROW - grid.clientHeight;
    }
    render();
  }
  function revealPath(path) {
    // open every ancestor of a path of indexes and select it
    let n = state.tree; let id = '';
    for (const i of path) {
      expanded.add(id);
      if (n.t === 'dict') { const [k, c] = n.v[i] || []; if (c === undefined) break; id = childId(id, 'k' + k); n = c; } else { if (n.v[i] === undefined) break; id = childId(id, 'i' + i); n = n.v[i]; }
    }
    if (filter) { filter = ''; $('#search').value = ''; }
    build();
    const at = rows.findIndex((r) => pathKey(r.path) === pathKey(path));
    if (at >= 0) select(at, true); else render();
  }

  // ---------- events ----------
  grid.addEventListener('scroll', () => { if (!editing) render(); });
  window.addEventListener('resize', () => { if (!editing) render(); });
  body.addEventListener('mousedown', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const i = Number(row.dataset.i);
    const act = e.target.dataset && e.target.dataset.act;
    if (act === 'toggle') { e.preventDefault(); toggle(i); return; }
    if (act === 'add') { e.preventDefault(); select(i); addAt(i); return; }
    if (act === 'del') { e.preventDefault(); select(i); del(i); return; }
    if (e.button === 0 && i !== sel) select(i);
  });
  body.addEventListener('dblclick', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    const i = Number(row.dataset.i);
    const f = e.target.closest('[data-f]');
    if (f) startEdit(i, f.dataset.f);
    else toggle(i);
  });
  body.addEventListener('click', (e) => {
    const f = e.target.closest('[data-f="type"].ed, .bool.ed');
    const row = e.target.closest('.row');
    if (f && row && Number(row.dataset.i) === sel) startEdit(sel, f.dataset.f);
  });
  body.addEventListener('contextmenu', (e) => {
    const row = e.target.closest('.row');
    if (!row) return;
    e.preventDefault();
    select(Number(row.dataset.i));
    menu(e.clientX, e.clientY);
  });
  grid.addEventListener('keydown', (e) => {
    if (editing) return;
    const mod = e.metaKey || e.ctrlKey;
    const r = rows[sel];
    if (e.key === 'ArrowDown' && e.altKey) { e.preventDefault(); move(sel, 1); }
    else if (e.key === 'ArrowUp' && e.altKey) { e.preventDefault(); move(sel, -1); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); select(sel + 1, true); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); select(sel - 1, true); }
    else if (e.key === 'PageDown') { e.preventDefault(); select(sel + Math.floor(grid.clientHeight / ROW), true); }
    else if (e.key === 'PageUp') { e.preventDefault(); select(sel - Math.floor(grid.clientHeight / ROW), true); }
    else if (e.key === 'Home') { e.preventDefault(); select(0, true); }
    else if (e.key === 'End') { e.preventDefault(); select(rows.length - 1, true); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (r && isBox(r.n) && !r.open) toggle(sel, true); else select(sel + 1, true); }
    else if (e.key === 'ArrowLeft') {
      e.preventDefault();
      if (r && isBox(r.n) && r.open && r.depth) toggle(sel, false);
      else if (r && r.depth) { const p = rows.findIndex((x) => pathKey(x.path) === pathKey(r.path.slice(0, -1))); if (p >= 0) select(p, true); }
    }
    else if (e.key === 'Enter' && !mod) { e.preventDefault(); if (r && r.parentType === 'dict') startEdit(sel, 'key'); else if (r && !isBox(r.n)) startEdit(sel, 'value'); else toggle(sel); }
    else if (e.key === 'F2') { e.preventDefault(); startEdit(sel, r && !isBox(r.n) ? 'value' : 'key'); }
    else if (e.key === 'Enter' && mod) { e.preventDefault(); addAt(sel); }
    else if ((e.key === 'Delete' || e.key === 'Backspace') && !mod) { e.preventDefault(); del(sel); }
    else if (mod && e.key.toLowerCase() === 'd') { e.preventDefault(); dup(sel); }
    else if (mod && e.key.toLowerCase() === 'c' && !window.getSelection().toString()) { e.preventDefault(); if (r) post({ type: 'copy', what: 'value', path: r.path }); }
    else if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); $('#search').focus(); $('#search').select(); }
  });

  // context menu
  const menuEl = $('#menu');
  function menu(x, y) {
    const r = rows[sel];
    const ro = state.readOnly;
    const items = [
      !ro && ['add', isBox(r.n) && (r.open || !r.depth) ? 'Add child item' : 'Add item below', 'Ctrl+Enter'],
      !ro && r.depth && ['dup', 'Duplicate', 'Ctrl+D'],
      !ro && r.depth && ['up', 'Move up', 'Alt+Up'],
      !ro && r.depth && ['down', 'Move down', 'Alt+Down'],
      !ro && r.depth && ['del', 'Delete', 'Delete'],
      '-',
      r.parentType === 'dict' && ['copyKey', 'Copy key', ''],
      !isBox(r.n) && ['copyValue', 'Copy value', 'Ctrl+C'],
      ['copyPath', 'Copy key path', ''],
      ['copyXml', 'Copy as XML', ''],
      ['copyJson', 'Copy as JSON', ''],
    ].filter(Boolean);
    menuEl.innerHTML = items.map((it) => (it === '-' ? '<div class="sep"></div>' : `<div class="mi" role="menuitem" tabindex="-1" data-m="${it[0]}"><span>${esc(it[1])}</span><span class="kb">${esc(it[2])}</span></div>`)).join('');
    menuEl.hidden = false;
    const w = menuEl.offsetWidth; const h = menuEl.offsetHeight;
    menuEl.style.left = Math.min(x, window.innerWidth - w - 4) + 'px';
    menuEl.style.top = Math.min(y, window.innerHeight - h - 4) + 'px';
  }
  menuEl.addEventListener('mousedown', (e) => {
    const it = e.target.closest('.mi');
    if (!it) return;
    e.preventDefault();
    menuEl.hidden = true;
    const r = rows[sel];
    const m = it.dataset.m;
    if (m === 'add') addAt(sel);
    else if (m === 'dup') dup(sel);
    else if (m === 'up') move(sel, -1);
    else if (m === 'down') move(sel, 1);
    else if (m === 'del') del(sel);
    else if (m.startsWith('copy')) post({ type: 'copy', what: m.slice(4).toLowerCase(), path: r.path });
    grid.focus();
  });
  document.addEventListener('mousedown', (e) => { if (!e.target.closest('#menu')) menuEl.hidden = true; });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') menuEl.hidden = true; });

  // toolbar
  const search = $('#search');
  let searchTimer = 0;
  search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => { filter = search.value.trim(); matchAt = -1; build(); grid.scrollTop = 0; render(); }, 120);
  });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && matches.length) { e.preventDefault(); matchAt = (matchAt + (e.shiftKey ? -1 : 1) + matches.length) % matches.length; select(matches[matchAt], true); }
    if (e.key === 'Escape') { search.value = ''; filter = ''; build(); render(); grid.focus(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); grid.focus(); }
  });
  document.querySelectorAll('[data-cmd]').forEach((b) => b.addEventListener('click', () => {
    const c = b.dataset.cmd;
    if (c === 'expand') expandAll(true);
    else if (c === 'collapse') expandAll(false);
    else post({ type: 'command', id: c });
  }));
  $('#names').addEventListener('change', (e) => { state.showNames = e.target.checked; post({ type: 'showNames', on: state.showNames }); render(); });

  // column resize
  const handle = $('#resize');
  handle.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--key-w')) || 320;
    const mv = (ev) => document.documentElement.style.setProperty('--key-w', Math.max(120, Math.min(window.innerWidth - 260, start + ev.clientX - startX)) + 'px');
    const up = () => { window.removeEventListener('mousemove', mv); window.removeEventListener('mouseup', up); };
    window.addEventListener('mousemove', mv);
    window.addEventListener('mouseup', up);
  });

  // ---------- messages ----------
  function showError(text) {
    const el = $('#err');
    el.textContent = text;
    el.hidden = !text;
    clearTimeout(showError.t);
    if (text) showError.t = setTimeout(() => { el.hidden = true; }, 6000);
  }
  window.addEventListener('message', (e) => {
    const m = e.data;
    if (!m || typeof m !== 'object') return;
    if (m.type === 'init' || m.type === 'tree') {
      if (m.type === 'init') {
        state.readOnly = !!m.readOnly;
        state.keys = m.keys || state.keys;
        state.showNames = m.showNames !== false;
        state.format = m.format;
        $('#names').checked = state.showNames;
        $('#fmt').textContent = m.formatLabel || '';
        $('#fmt').title = m.formatTitle || '';
        const note = $('#note');
        note.textContent = m.note || '';
        note.hidden = !m.note;
        document.body.classList.toggle('ro', state.readOnly);
        $('#failed').hidden = true;
        $('#main').hidden = false;
      }
      state.tree = m.tree;
      if (m.issues) state.issues = new Map(m.issues.map((x) => [x.path.join('/'), x]));
      if (firstRender && state.tree && isBox(state.tree)) {
        // A small plist (a typical Info.plist or entitlements file) opens fully expanded, like Xcode after
        // Option-click. A large one opens the first level, plus small containers on the second level.
        let count = 0;
        const size = (n) => { count++; if (count > 400 || !isBox(n)) return; if (n.t === 'dict') n.v.forEach(([, c]) => size(c)); else n.v.forEach(size); };
        size(state.tree);
        if (count <= 400) {
          const all = (n, id) => { if (!isBox(n)) return; expanded.add(id); if (n.t === 'dict') n.v.forEach(([k, c]) => all(c, childId(id, 'k' + k))); else n.v.forEach((c, i) => all(c, childId(id, 'i' + i))); };
          all(state.tree, '');
        } else {
          expanded.add('');
          if (state.tree.t === 'dict' && state.tree.v.length <= 60) state.tree.v.forEach(([k, c]) => { if (isBox(c) && c.v.length <= 12) expanded.add(childId('', 'k' + k)); });
        }
        firstRender = false;
      }
      build();
      if (m.focus) {
        revealPath(m.focus);
        if (m.editKey) { const at = rows.findIndex((r) => pathKey(r.path) === pathKey(m.focus)); if (at >= 0) setTimeout(() => startEdit(at, rows[at].parentType === 'dict' ? 'key' : 'value'), 20); }
      } else render();
      if (m.type === 'init') { grid.focus(); post({ type: 'rendered', rows: rows.length }); }
    } else if (m.type === 'failed') {
      $('#main').hidden = true;
      const f = $('#failed');
      f.hidden = false;
      $('#failmsg').textContent = m.message;
      post({ type: 'rendered', rows: 0, failed: true });
    } else if (m.type === 'error') {
      showError(m.message);
    } else if (m.type === 'issues') {
      state.issues = new Map((m.issues || []).map((x) => [x.path.join('/'), x]));
      render();
    } else if (m.type === 'reveal') {
      revealPath(m.path);
      grid.focus();
    } else if (m.type === 'find') {
      search.focus(); search.select();
    }
  });
  post({ type: 'ready' });
  // footer from the template (support links)
  const tpl = document.getElementById('zovo-footer');
  if (tpl && tpl.innerHTML.trim()) { const f = document.getElementById('footer'); f.innerHTML = tpl.innerHTML; }
})();
