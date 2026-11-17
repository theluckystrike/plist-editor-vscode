'use strict';
// Tree compare of two plists (Zovo Pro). Dictionary key order is ignored. Arrays of plain values are compared as
// lists (an inserted value shows as one addition, not as every later item changed); other arrays by position.
const M = require('./model');

const isScalar = (n) => n && !M.isContainer(n);
const childPath = (p, k) => (p ? `${p}.${/^[A-Za-z_][\w-]*$/.test(k) ? k : JSON.stringify(k)}` : (/^[A-Za-z_][\w-]*$/.test(k) ? k : JSON.stringify(k)));

function show(n) {
  if (!n) return '';
  if (n.t === 'string') return JSON.stringify(n.v);
  if (n.t === 'date') return n.v;
  if (M.isContainer(n)) return `${M.TYPE_LABEL[n.t]} ${M.display(n)}`;
  return M.display(n);
}

function lcs(a, b) {
  const n = a.length; const m = b.length;
  if (n * m > 4_000_000) return null; // too big for a table: compare by position
  const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) dp[i][j] = M.equal(a[i], b[j]) ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const ops = [];
  let i = 0; let j = 0;
  while (i < n && j < m) {
    if (M.equal(a[i], b[j])) { i++; j++; } else if (dp[i + 1][j] >= dp[i][j + 1]) ops.push(['removed', i++, null]); else ops.push(['added', null, j++]);
  }
  while (i < n) ops.push(['removed', i++, null]);
  while (j < m) ops.push(['added', null, j++]);
  return ops;
}

/** Changes from a (old) to b (new): [{ kind: added|removed|changed|type, path, old, new }] */
function compare(a, b) {
  const out = [];
  (function walk(x, y, p) {
    if (M.equal(x, y)) return;
    if (x.t !== y.t && !(isNum(x) && isNum(y))) { out.push({ kind: 'type', path: p || 'Root', old: `${M.TYPE_LABEL[x.t]} ${show(x)}`, new: `${M.TYPE_LABEL[y.t]} ${show(y)}` }); return; }
    if (x.t === 'dict') {
      const mb = new Map(y.v);
      const ma = new Map(x.v);
      for (const [k, c] of x.v) {
        if (!mb.has(k)) out.push({ kind: 'removed', path: childPath(p, k), old: show(c), new: '' });
        else walk(c, mb.get(k), childPath(p, k));
      }
      for (const [k, c] of y.v) if (!ma.has(k)) out.push({ kind: 'added', path: childPath(p, k), old: '', new: show(c) });
      return;
    }
    if (x.t === 'array') {
      const ops = x.v.every(isScalar) && y.v.every(isScalar) ? lcs(x.v, y.v) : null;
      if (ops) {
        for (const [kind, i, j] of ops) out.push(kind === 'removed' ? { kind, path: `${p}[${i}]`, old: show(x.v[i]), new: '' } : { kind, path: `${p}[${j}]`, old: '', new: show(y.v[j]) });
        return;
      }
      const n = Math.max(x.v.length, y.v.length);
      for (let i = 0; i < n; i++) {
        if (i >= y.v.length) out.push({ kind: 'removed', path: `${p}[${i}]`, old: show(x.v[i]), new: '' });
        else if (i >= x.v.length) out.push({ kind: 'added', path: `${p}[${i}]`, old: '', new: show(y.v[i]) });
        else walk(x.v[i], y.v[i], `${p}[${i}]`);
      }
      return;
    }
    out.push({ kind: 'changed', path: p || 'Root', old: show(x), new: show(y) });
  })(a, b, '');
  return out;
}
const isNum = (n) => n.t === 'integer' || n.t === 'real';

function summary(changes) {
  const c = { added: 0, removed: 0, changed: 0, type: 0 };
  for (const x of changes) c[x.kind]++;
  return c;
}

const mdCell = (s) => String(s).replace(/\|/g, '\\|').replace(/\r?\n/g, ' ').slice(0, 300);

function markdown(changes, leftName, rightName) {
  const s = summary(changes);
  const lines = [`# Plist compare`, '', `- Old: ${leftName}`, `- New: ${rightName}`, `- ${s.added} added, ${s.removed} removed, ${s.changed} changed, ${s.type} with a new type (key order ignored)`, ''];
  if (!changes.length) { lines.push('The two plists hold the same keys and values.'); return lines.join('\n') + '\n'; }
  lines.push('| Change | Key path | Old | New |', '|---|---|---|---|');
  for (const x of changes) lines.push(`| ${x.kind} | ${mdCell(x.path)} | ${mdCell(x.old)} | ${mdCell(x.new)} |`);
  return lines.join('\n') + '\n';
}

module.exports = { compare, summary, markdown };
