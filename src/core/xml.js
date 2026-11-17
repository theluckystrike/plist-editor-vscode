'use strict';
// XML property lists, read and written with our own small XML reader (no DTD, no external entities, nothing loaded).
// The writer keeps the file's own prolog (XML declaration and DOCTYPE), its indent (tabs or spaces), its line ends
// and its last newline, so an Apple-style file that is edited in one place changes in that place only.

const DEFAULT_PROLOG = '<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n';
const MAX_DEPTH = 512;

function decodeEntities(s, line) {
  const bad = /&(?!#x[0-9a-fA-F]+;|#\d+;|amp;|lt;|gt;|quot;|apos;)[^;\s]{0,20};?/.exec(s);
  if (bad) throw err(`Unknown entity ${bad[0]} (plists use only &amp; &lt; &gt; &quot; &apos; and &#...;)`, line);
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e === 'amp') return '&';
    if (e === 'lt') return '<';
    if (e === 'gt') return '>';
    if (e === 'quot') return '"';
    if (e === 'apos') return "'";
    const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!(cp >= 0 && cp <= 0x10ffff)) throw err(`Bad character reference ${m}`, line);
    return String.fromCodePoint(cp);
  });
}

function err(msg, line) {
  const e = new Error(line ? `Line ${line}: ${msg}` : msg);
  e.line = line;
  return e;
}

/** Tokenizes into elements: returns the root plist element tree { name, attrs, children, text, line }. */
function tokenize(text) {
  let i = 0;
  let line = 1;
  const n = text.length;
  const lineAt = (to) => { for (let k = i; k < to; k++) if (text.charCodeAt(k) === 10) line++; i = to; };
  const stack = [{ name: '#root', children: [], text: '' }];
  let prologEnd = 0;
  let sawRoot = false;
  while (i < n) {
    const lt = text.indexOf('<', i);
    if (lt < 0) {
      const rest = text.slice(i);
      if (rest.trim() && stack.length > 1) stack[stack.length - 1].text += rest;
      else if (rest.trim()) throw err('Text after the end of the plist', line);
      lineAt(n);
      break;
    }
    if (lt > i) {
      const t = text.slice(i, lt);
      const top = stack[stack.length - 1];
      if (stack.length > 1) top.text += t;
      else if (t.trim()) throw err('Text outside the <plist> element', line);
      lineAt(lt);
    }
    if (text.startsWith('<!--', i)) {
      const e = text.indexOf('-->', i + 4);
      if (e < 0) throw err('A comment is not closed (missing -->)', line);
      lineAt(e + 3);
      if (!sawRoot) prologEnd = i;
      continue;
    }
    if (text.startsWith('<![CDATA[', i)) {
      const e = text.indexOf(']]>', i + 9);
      if (e < 0) throw err('A CDATA section is not closed', line);
      if (stack.length > 1) stack[stack.length - 1].text += '\u0000CDATA' + text.slice(i + 9, e) + '\u0000';
      lineAt(e + 3);
      continue;
    }
    if (text.startsWith('<?', i)) {
      const e = text.indexOf('?>', i + 2);
      if (e < 0) throw err('An XML declaration is not closed', line);
      lineAt(e + 2);
      if (!sawRoot) prologEnd = i;
      continue;
    }
    if (text.startsWith('<!', i)) {
      // DOCTYPE: skipped, never resolved.
      // An internal subset ([ ... ]) is skipped: its definitions are never used, so no entity can expand or load.
      let close = text.indexOf('>', i);
      const sub = text.indexOf('[', i);
      if (sub >= 0 && (close < 0 || sub < close)) { const endSub = text.indexOf(']', sub); close = endSub < 0 ? -1 : text.indexOf('>', endSub); }
      if (close < 0) throw err('The DOCTYPE is not closed', line);
      lineAt(close + 1);
      if (!sawRoot) prologEnd = i;
      continue;
    }
    const close = text.indexOf('>', i);
    if (close < 0) throw err('A tag is not closed (missing >)', line);
    const raw = text.slice(i + 1, close);
    const startLine = line;
    lineAt(close + 1);
    if (raw.startsWith('/')) {
      const name = raw.slice(1).trim();
      const top = stack.pop();
      if (!top || top.name !== name) throw err(`</${name}> does not match <${top ? top.name : '?'}>`, startLine);
      if (stack.length === 0) throw err(`Unexpected </${name}>`, startLine);
      continue;
    }
    const selfClose = raw.endsWith('/');
    const body = selfClose ? raw.slice(0, -1) : raw;
    const m = /^([A-Za-z_][\w.-]*)([\s\S]*)$/.exec(body.trim());
    if (!m) throw err(`Bad tag <${raw.slice(0, 30)}>`, startLine);
    const attrs = {};
    m[2].replace(/([\w:.-]+)\s*=\s*("([^"]*)"|'([^']*)')/g, (_, k, __, a, b) => { attrs[k] = a !== undefined ? a : b; return ''; });
    const el = { name: m[1], attrs, children: [], text: '', line: startLine };
    if (stack.length > MAX_DEPTH) throw err('The plist is nested too deeply', startLine);
    const parent = stack[stack.length - 1];
    if (parent.name === '#root') {
      if (sawRoot) throw err('More than one root element', startLine);
      sawRoot = true;
      if (!prologEnd) prologEnd = 0;
    }
    parent.children.push(el);
    if (!selfClose) stack.push(el);
  }
  if (stack.length > 1) throw err(`<${stack[stack.length - 1].name}> is not closed`, stack[stack.length - 1].line);
  const root = stack[0].children[0];
  if (!root) throw err('No plist element found');
  return root;
}

function textOf(el) {
  const out = [];
  const parts = el.text.split('\u0000');
  for (let k = 0; k < parts.length; k++) {
    const p = parts[k];
    if (p.startsWith('CDATA')) out.push(p.slice(5));
    else out.push(decodeEntities(p, el.line));
  }
  return out.join('');
}

function node(el, depth) {
  if (depth > MAX_DEPTH) throw err('The plist is nested too deeply', el.line);
  switch (el.name) {
    case 'dict': {
      const entries = [];
      const seen = new Map();
      const kids = el.children;
      for (let k = 0; k < kids.length; k += 2) {
        const key = kids[k];
        if (key.name !== 'key') throw err(`Expected <key> in <dict>, found <${key.name}>`, key.line);
        const val = kids[k + 1];
        if (!val) throw err(`The key "${textOf(key)}" has no value`, key.line);
        const name = textOf(key);
        const v = node(val, depth + 1);
        if (seen.has(name)) { entries[seen.get(name)][1] = v; continue; } // last value wins, as CoreFoundation does
        seen.set(name, entries.length);
        entries.push([name, v]);
      }
      // NSKeyedArchiver UIDs are written to XML as <dict><key>CF$UID</key><integer>n</integer></dict>
      if (entries.length === 1 && entries[0][0] === 'CF$UID' && entries[0][1].t === 'integer') return { t: 'uid', v: Number(entries[0][1].v) };
      return { t: 'dict', v: entries };
    }
    case 'array': return { t: 'array', v: el.children.map((c) => node(c, depth + 1)) };
    case 'string': return { t: 'string', v: textOf(el) };
    case 'key': throw err('A <key> outside a <dict>', el.line);
    case 'integer': {
      const s = textOf(el).trim();
      if (!/^[+-]?(\d+|0x[0-9a-fA-F]+)$/.test(s)) throw err(`"${s}" is not a whole number`, el.line);
      const neg = s.startsWith('-');
      const b = BigInt(s.replace(/^[+-]/, ''));
      return { t: 'integer', v: (neg ? -b : b).toString() };
    }
    case 'real': {
      const s = textOf(el).trim();
      const low = s.toLowerCase();
      let v;
      if (low === 'nan') v = NaN;
      else if (low === '+infinity' || low === 'infinity' || low === 'inf' || low === '+inf') v = Infinity;
      else if (low === '-infinity' || low === '-inf') v = -Infinity;
      else { v = Number(s); if (s === '' || Number.isNaN(v)) throw err(`"${s}" is not a number`, el.line); }
      return { t: 'real', v };
    }
    case 'true': return { t: 'bool', v: true };
    case 'false': return { t: 'bool', v: false };
    case 'date': {
      const s = textOf(el).trim();
      const d = new Date(s);
      if (Number.isNaN(d.getTime())) throw err(`"${s}" is not a date`, el.line);
      return { t: 'date', v: d.toISOString().replace('.000Z', 'Z') };
    }
    case 'data': {
      const s = textOf(el).replace(/\s+/g, '');
      if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s)) throw err('<data> is not valid base64', el.line);
      return { t: 'data', v: Buffer.from(s, 'base64').toString('base64') };
    }
    default: throw err(`<${el.name}> is not a plist element`, el.line);
  }
}

/** Parses XML plist text. Returns { root, style } where style keeps prolog, indent, eol and final newline. */
function parse(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const top = tokenize(text);
  let el = top;
  if (top.name === 'plist') {
    if (top.children.length > 1) throw err('<plist> must hold exactly one value', top.line);
    if (top.children.length === 0) return { root: { t: 'dict', v: [] }, style: styleOf(text) };
    el = top.children[0];
  }
  return { root: node(el, 0), style: styleOf(text) };
}

function styleOf(text) {
  const eol = /\r\n/.test(text) ? '\r\n' : '\n';
  const start = text.search(/<plist[\s>]/);
  let prolog = start >= 0 ? text.slice(0, start) : DEFAULT_PROLOG; // a file that starts at <plist> keeps no prolog
  if (prolog.charCodeAt(0) === 0xfeff) prolog = prolog.slice(1);
  const m = /\n([ \t]+)<(key|dict|array|string|integer|real|true|false|date|data)\b/.exec(text);
  let indent = '\t';
  if (m) {
    // the first indented child of the top value: one level of indent (the top value itself sits at column 0)
    indent = m[1];
    const lvl = /<plist[^>]*>\s*\n([ \t]*)</.exec(text);
    if (lvl && lvl[1] && m[1].startsWith(lvl[1]) && m[1].length > lvl[1].length) indent = m[1].slice(lvl[1].length);
  }
  const lvl = /<plist[^>]*>\s*\n([ \t]*)</.exec(text);
  const base = lvl ? lvl[1] : '';
  const dataIndent = /<data>\s*\n/.test(text) ? 'block' : /<data>[^<\n]/.test(text) ? 'inline' : 'block';
  return { prolog, indent, eol, finalNewline: /\n\s*$/.test(text), base, dataIndent, version: (/<plist[^>]*version="([^"]*)"/.exec(text) || [])[1] || '1.0' };
}

function esc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function realText(v) {
  if (Number.isNaN(v)) return 'nan';
  if (v === Infinity) return '+infinity';
  if (v === -Infinity) return '-infinity';
  return String(v);
}

/** Writes a node tree as an XML plist in the given style (defaults: Apple's, tabs, LF). */
function write(root, style = {}) {
  const ind = style.indent || '\t';
  const eol = style.eol || '\n';
  const base = style.base || '';
  const out = [];
  function emit(n, depth) {
    const pad = base + ind.repeat(depth);
    switch (n.t) {
      case 'dict':
        if (!n.v.length) { out.push(pad + '<dict/>'); return; }
        out.push(pad + '<dict>');
        for (const [k, c] of n.v) { out.push(pad + ind + '<key>' + esc(k) + '</key>'); emit(c, depth + 1); }
        out.push(pad + '</dict>');
        return;
      case 'array':
        if (!n.v.length) { out.push(pad + '<array/>'); return; }
        out.push(pad + '<array>');
        for (const c of n.v) emit(c, depth + 1);
        out.push(pad + '</array>');
        return;
      case 'string': out.push(pad + '<string>' + esc(n.v) + '</string>'); return;
      case 'integer': out.push(pad + '<integer>' + n.v + '</integer>'); return;
      case 'real': out.push(pad + '<real>' + realText(n.v) + '</real>'); return;
      case 'bool': out.push(pad + (n.v ? '<true/>' : '<false/>')); return;
      case 'date': out.push(pad + '<date>' + new Date(n.v).toISOString().replace(/\.\d{3}Z$/, 'Z') + '</date>'); return;
      case 'data': {
        const b64 = n.v;
        if (style.dataIndent === 'inline' || !b64.length) { out.push(pad + '<data>' + b64 + '</data>'); return; }
        out.push(pad + '<data>');
        for (let k = 0; k < b64.length; k += 68) out.push(pad + b64.slice(k, k + 68));
        out.push(pad + '</data>');
        return;
      }
      case 'uid':
        out.push(pad + '<dict>', pad + ind + '<key>CF$UID</key>', pad + ind + '<integer>' + n.v + '</integer>', pad + '</dict>');
        return;
      case 'null': out.push(pad + '<string></string>'); return; // XML plists have no null
      default: throw new Error(`Cannot write a value of type ${n.t}.`);
    }
  }
  emit(root, 0);
  let prolog = typeof style.prolog === 'string' ? style.prolog : DEFAULT_PROLOG;
  prolog = prolog.replace(/\r?\n/g, eol);
  const text = prolog + `<plist version="${style.version || '1.0'}">` + eol + out.join(eol) + eol + '</plist>' + (style.finalNewline === false ? '' : eol);
  return text;
}

module.exports = { parse, write, styleOf, DEFAULT_PROLOG, tokenize };
