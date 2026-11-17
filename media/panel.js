// Result panel of the Pro tools (compare and check). Data arrives by postMessage; everything is drawn as text, so
// nothing from a plist can run here.
(function () {
  'use strict';
  const vscode = window.acquireVsCodeApi ? window.acquireVsCodeApi() : acquireVsCodeApi();
  const app = document.getElementById('app');
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  let data = null;
  let show = { added: true, removed: true, changed: true, type: true, error: true, warning: true, info: true };

  function actions(list) {
    document.getElementById('actions').innerHTML = list.map(([id, label]) => `<button class="tb" data-a="${id}">${esc(label)}</button>`).join('');
  }
  document.getElementById('actions').addEventListener('click', (e) => { const b = e.target.closest('[data-a]'); if (b) vscode.postMessage({ type: 'action', id: b.dataset.a }); });

  function renderCompare(d) {
    document.getElementById('title').textContent = d.title;
    actions([['saveMd', 'Save as Markdown'], ['swap', 'Swap sides']]);
    const c = d.counts;
    const chip = (k, label, n) => `<label class="chip ${k}"><input type="checkbox" data-k="${k}" ${show[k] ? 'checked' : ''}> ${esc(label)} <b>${n}</b></label>`;
    let h = `<p class="files"><span class="old">Old</span> ${esc(d.left)}<br><span class="new">New</span> ${esc(d.right)}</p>`;
    h += `<div class="chips">${chip('added', 'Added', c.added)}${chip('removed', 'Removed', c.removed)}${chip('changed', 'Changed', c.changed)}${chip('type', 'New type', c.type)}<span class="muted">Key order is ignored.</span></div>`;
    if (!d.changes.length) h += '<p class="same">The two plists hold the same keys and values.</p>';
    else {
      h += '<table><thead><tr><th>Change</th><th>Key path</th><th>Old</th><th>New</th></tr></thead><tbody>';
      for (const x of d.changes) if (show[x.kind]) h += `<tr class="${x.kind}"><td><span class="tag ${x.kind}">${esc(x.kind === 'type' ? 'new type' : x.kind)}</span></td><td class="mono">${esc(x.path)}</td><td class="mono old">${esc(x.old)}</td><td class="mono new">${esc(x.new)}</td></tr>`;
      h += '</tbody></table>';
    }
    app.innerHTML = h;
  }

  function renderCheck(d) {
    document.getElementById('title').textContent = d.title;
    actions([['saveMd', 'Save as Markdown'], ['rerun', 'Check again']]);
    const c = { error: 0, warning: 0, info: 0 };
    for (const i of d.issues) c[i.level]++;
    const chip = (k, label, n) => `<label class="chip ${k}"><input type="checkbox" data-k="${k}" ${show[k] ? 'checked' : ''}> ${esc(label)} <b>${n}</b></label>`;
    let h = `<p class="files">${esc(d.file)}</p>`;
    h += '<table class="sum"><tbody>' + d.summary.map(([k, v]) => `<tr><th>${esc(k)}</th><td class="mono">${esc(v)}</td></tr>`).join('') + '</tbody></table>';
    if (d.certificates && d.certificates.length) {
      h += '<h3>Certificates</h3><table><thead><tr><th>Name</th><th>Valid from</th><th>Valid until</th><th>Serial</th></tr></thead><tbody>';
      for (const x of d.certificates) h += `<tr class="${x.expired ? 'error' : ''}"><td>${esc(x.name)}</td><td>${esc(x.validFrom || '')}</td><td>${esc(x.validTo || '')}${x.expired ? ' <span class="tag error">expired</span>' : ''}</td><td class="mono">${esc(x.serial || x.error || '')}</td></tr>`;
      h += '</tbody></table>';
    }
    h += `<h3>Findings</h3><div class="chips">${chip('error', 'Errors', c.error)}${chip('warning', 'Warnings', c.warning)}${chip('info', 'Notes', c.info)}</div>`;
    if (!d.issues.length) h += '<p class="same">No problems found.</p>';
    else {
      h += '<ul class="issues">';
      d.issues.forEach((x, i) => { if (show[x.level]) h += `<li class="${x.level}"><span class="tag ${x.level}">${esc(x.level)}</span> <a href="#" data-i="${i}" class="mono" title="Show in the editor">${esc(x.path)}</a><div>${esc(x.message)}</div>${x.fix ? `<div class="fix">${esc(x.fix)}</div>` : ''}</li>`; });
      h += '</ul>';
    }
    app.innerHTML = h;
  }

  function render() { if (!data) return; if (data.kind === 'compare') renderCompare(data); else renderCheck(data); }
  app.addEventListener('change', (e) => { const k = e.target.dataset && e.target.dataset.k; if (k) { show[k] = e.target.checked; render(); } });
  app.addEventListener('click', (e) => { const a = e.target.closest('a[data-i]'); if (a) { e.preventDefault(); vscode.postMessage({ type: 'reveal', index: Number(a.dataset.i) }); } });
  window.addEventListener('message', (e) => { const m = e.data; if (m && m.type === 'data') { data = m.data; render(); vscode.postMessage({ type: 'shown' }); } });
  vscode.postMessage({ type: 'ready' });
})();
