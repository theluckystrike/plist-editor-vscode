'use strict';
// One entry point for reading and writing: detects binary, XML, OpenStep, JSON and signed provisioning profiles.
const binary = require('./binary');
const xml = require('./xml');
const openstep = require('./openstep');
const M = require('./model');

const FORMAT_LABEL = { binary: 'Binary', xml: 'XML', openstep: 'OpenStep', json: 'JSON', profile: 'Provisioning profile' };

function decodeText(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return { text: buf.subarray(2).toString('utf16le'), encoding: 'utf16le' };
  if (buf[0] === 0xfe && buf[1] === 0xff) { const b = Buffer.from(buf.subarray(2)); b.swap16(); return { text: b.toString('utf16le'), encoding: 'utf16be' }; }
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return { text: buf.subarray(3).toString('utf8'), encoding: 'utf8bom' };
  return { text: buf.toString('utf8'), encoding: 'utf8' };
}

function encodeText(text, encoding) {
  if (encoding === 'utf16le') return Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(text, 'utf16le')]);
  if (encoding === 'utf16be') { const b = Buffer.from(text, 'utf16le'); b.swap16(); return Buffer.concat([Buffer.from([0xfe, 0xff]), b]); }
  if (encoding === 'utf8bom') return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text, 'utf8')]);
  return Buffer.from(text, 'utf8');
}

/** A signed profile (.mobileprovision, .provisionprofile) is CMS DER with the XML plist inside. */
function profileXml(buf) {
  if (buf[0] !== 0x30) return null;
  const start = buf.indexOf('<?xml');
  const end = buf.indexOf('</plist>');
  if (start < 0 || end < start) return null;
  return buf.subarray(start, end + 8).toString('utf8');
}

/**
 * Reads a plist file. Returns { root, format, style, readOnly, note }.
 * hint: the file name, used only for messages and to treat .json as JSON.
 */
function read(buf, hint = '') {
  if (!buf || !buf.length) return { root: M.dict([]), format: /\.json$/i.test(hint) ? 'json' : 'xml', style: {}, empty: true };
  if (binary.isBinary(buf)) return { root: binary.parse(buf), format: 'binary', style: {} };
  const px = profileXml(buf);
  if (px) {
    const r = xml.parse(px);
    return { root: r.root, format: 'profile', style: r.style, readOnly: true, note: 'A signed provisioning profile opens read-only: editing would break its signature.' };
  }
  const { text, encoding } = decodeText(buf);
  const head = text.replace(/^\s+/, '').slice(0, 200);
  if (head.startsWith('<?xml') || head.startsWith('<!DOCTYPE') || head.startsWith('<plist') || head.startsWith('<!--')) {
    const r = xml.parse(text);
    r.style.encoding = encoding;
    return { root: r.root, format: 'xml', style: r.style };
  }
  if (/\.json$/i.test(hint) || ((head.startsWith('{') || head.startsWith('[')) && looksJson(text))) {
    return { root: fromJson(JSON.parse(text)), format: 'json', style: { encoding } };
  }
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x08\x0e-\x1f]/.test(text.slice(0, 4096))) throw new Error('This file is not a plist: it is binary data without a bplist header.');
  const r = openstep.parse(text);
  r.style.encoding = encoding;
  return { root: r.root, format: 'openstep', style: r.style };
}

function looksJson(text) { try { JSON.parse(text); return true; } catch (e) { return false; } }

/** Writes a tree in a format. Returns a Buffer. */
function write(root, format, style = {}) {
  switch (format) {
    case 'binary': return binary.write(root);
    case 'xml': case 'profile': return encodeText(xml.write(root, style), style.encoding || 'utf8');
    case 'openstep': return encodeText(openstep.write(root, style), style.encoding || 'utf8');
    case 'json': return Buffer.from(JSON.stringify(M.toPlain(root), null, 2) + '\n', 'utf8');
    default: throw new Error(`Unknown format ${format}`);
  }
}

/** What a format cannot hold, as readable lines (empty when nothing is lost). */
function losses(root, format) {
  const out = [];
  const walk = (n, p, fn) => {
    fn(n, p);
    if (n.t === 'dict') n.v.forEach(([k, c]) => walk(c, p ? `${p}.${k}` : k, fn));
    else if (n.t === 'array') n.v.forEach((c, i) => walk(c, `${p}[${i}]`, fn));
  };
  if (format === 'openstep') {
    const l = openstep.lossy(root);
    if (l.length) out.push(`${l.length} number, boolean or date value${l.length === 1 ? '' : 's'} become text (OpenStep has only strings, data, arrays and dictionaries): ${l.slice(0, 5).join(', ')}${l.length > 5 ? ', ...' : ''}`);
  }
  if (format === 'json') {
    const kinds = new Set();
    walk(root, '', (n) => { if (n.t === 'date') kinds.add('dates become ISO text'); if (n.t === 'data') kinds.add('data becomes base64 text'); if (n.t === 'uid') kinds.add('UIDs become {"CF$UID": n}'); if (n.t === 'integer' && !Number.isSafeInteger(Number(n.v))) kinds.add('integers past 2^53 become text'); if (n.t === 'real' && !Number.isFinite(n.v)) kinds.add('nan and infinity become null'); });
    if (kinds.size) out.push(`JSON has no date or data type: ${[...kinds].join(', ')}.`);
  }
  if (format === 'xml') {
    let nulls = 0;
    walk(root, '', (n) => { if (n.t === 'null') nulls++; });
    if (nulls) out.push(`${nulls} null value${nulls === 1 ? '' : 's'} become empty strings (XML plists have no null).`);
  }
  if (root.t !== 'dict' && root.t !== 'array' && format !== 'json') out.push('The top value is not a dictionary or an array; some tools expect one.');
  return out;
}

/** JSON value to a plist tree. Whole numbers become integers, other numbers reals, null is refused. */
function fromJson(v, p = 'Root') {
  if (v === null) throw new Error(`${p} is null, and plists have no null value.`);
  if (Array.isArray(v)) return M.array(v.map((c, i) => fromJson(c, `${p}[${i}]`)));
  if (typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 1 && keys[0] === 'CF$UID' && Number.isInteger(v['CF$UID'])) return { t: 'uid', v: v['CF$UID'] };
    return M.dict(keys.map((k) => [k, fromJson(v[k], `${p}.${k}`)]));
  }
  if (typeof v === 'boolean') return M.bool(v);
  if (typeof v === 'number') return Number.isInteger(v) ? M.int(v) : M.real(v);
  return M.str(v);
}

module.exports = { read, write, losses, fromJson, decodeText, encodeText, profileXml, FORMAT_LABEL };
