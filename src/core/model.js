'use strict';
// The plist value tree used by every reader, writer and the editor. Pure JavaScript, no VS Code.
// A node is { t, v } with t one of:
//   dict    v: [[key, node], ...]  (order kept, keys unique)
//   array   v: [node, ...]          (set: true when the binary file stored a set)
//   string  v: string
//   integer v: decimal string (kept as text so 64-bit and 128-bit values never lose digits)
//   real    v: number
//   bool    v: boolean
//   date    v: ISO 8601 string in UTC, for example 2026-11-13T02:40:00Z
//   data    v: base64 string
//   uid     v: number (NSKeyedArchiver object reference, binary plists only)
//   null    (binary plists only, very rare)

const TYPES = ['dict', 'array', 'string', 'integer', 'real', 'bool', 'date', 'data'];
const TYPE_LABEL = { dict: 'Dictionary', array: 'Array', string: 'String', integer: 'Number', real: 'Number', bool: 'Boolean', date: 'Date', data: 'Data', uid: 'UID', null: 'Null' };

const INT_MIN = -(2n ** 63n);
const INT_MAX = 2n ** 64n - 1n; // unsigned 64-bit values are written as 128-bit integers, as CoreFoundation does

const str = (v) => ({ t: 'string', v: String(v) });
const int = (v) => ({ t: 'integer', v: normInt(v) });
const real = (v) => ({ t: 'real', v: Number(v) });
const bool = (v) => ({ t: 'bool', v: !!v });
const date = (v) => ({ t: 'date', v: normDate(v) });
const data = (v) => ({ t: 'data', v: Buffer.isBuffer(v) ? v.toString('base64') : String(v) });
const dict = (entries) => ({ t: 'dict', v: entries || [] });
const array = (items) => ({ t: 'array', v: items || [] });

function normInt(v) {
  const s = String(v).trim();
  let b;
  if (/^[+-]?0x[0-9a-f]+$/i.test(s)) b = s.startsWith('-') ? -BigInt(s.replace(/^[+-]/, '')) : BigInt(s.replace(/^\+/, ''));
  else if (/^[+-]?\d+$/.test(s)) b = BigInt(s);
  else throw new Error(`"${s}" is not a whole number`);
  if (b < INT_MIN || b > INT_MAX) throw new Error(`${s} is outside the range a plist can store`);
  return b.toString();
}

/** Accepts an ISO string or a Date; returns ISO 8601 UTC with Z, without milliseconds when they are 0. */
function normDate(v) {
  const d = v instanceof Date ? v : new Date(String(v).trim());
  if (Number.isNaN(d.getTime())) throw new Error(`"${v}" is not a date (use 2026-11-13T09:30:00Z)`);
  return d.toISOString().replace('.000Z', 'Z');
}

function isContainer(n) { return n && (n.t === 'dict' || n.t === 'array'); }

function clone(n) {
  if (!n || typeof n !== 'object') return n;
  if (n.t === 'dict') return { t: 'dict', v: n.v.map(([k, c]) => [k, clone(c)]) };
  if (n.t === 'array') return n.set ? { t: 'array', set: true, v: n.v.map(clone) } : { t: 'array', v: n.v.map(clone) };
  return { ...n };
}

/** Node at a path of child indexes (root = []). */
function at(root, path) {
  let n = root;
  for (const i of path) {
    if (!isContainer(n)) return undefined;
    const c = n.v[i];
    if (c === undefined) return undefined;
    n = n.t === 'dict' ? c[1] : c;
  }
  return n;
}

function count(n) {
  if (!isContainer(n)) return 1;
  let c = 1;
  for (const x of n.v) c += count(n.t === 'dict' ? x[1] : x);
  return c;
}

/** Deep equality. Dictionary key order counts only when ordered is true. */
function equal(a, b, ordered = false) {
  if (!a || !b || a.t !== b.t) {
    if (a && b && isNum(a) && isNum(b)) return Number(a.v) === Number(b.v);
    return false;
  }
  if (a.t === 'dict') {
    if (a.v.length !== b.v.length) return false;
    if (ordered) return a.v.every(([k, c], i) => b.v[i][0] === k && equal(c, b.v[i][1], true));
    const m = new Map(b.v);
    return a.v.every(([k, c]) => m.has(k) && equal(c, m.get(k), false));
  }
  if (a.t === 'array') return a.v.length === b.v.length && a.v.every((c, i) => equal(c, b.v[i], ordered));
  if (a.t === 'real') return a.v === b.v || (Number.isNaN(a.v) && Number.isNaN(b.v));
  if (a.t === 'data') return Buffer.from(a.v, 'base64').equals(Buffer.from(b.v, 'base64'));
  if (a.t === 'null') return true;
  if (a.t === 'date') return Math.floor(Date.parse(a.v) / 1000) === Math.floor(Date.parse(b.v) / 1000); // XML plists keep whole seconds
  return a.v === b.v;
}
const isNum = (n) => n.t === 'integer' || n.t === 'real';

/** A default value of a type, for new rows and type changes. */
function empty(t) {
  switch (t) {
    case 'dict': return dict([]);
    case 'array': return array([]);
    case 'integer': return int(0);
    case 'real': return real(0);
    case 'bool': return bool(false);
    case 'date': return date(new Date(Math.floor(Date.now() / 1000) * 1000));
    case 'data': return data(Buffer.alloc(0));
    default: return str('');
  }
}

/** Converts a node to another type, keeping the value when it makes sense (like Xcode's Type column). */
function retype(n, t) {
  if (n.t === t) return clone(n);
  if (t === 'dict' || t === 'array') {
    if (n.t === 'dict' && t === 'array') return array(n.v.map(([, c]) => clone(c)));
    if (n.t === 'array' && t === 'dict') return dict(n.v.map((c, i) => [`Item ${i}`, clone(c)]));
    return empty(t);
  }
  if (isContainer(n)) return empty(t);
  const text = display(n);
  try {
    switch (t) {
      case 'string': return str(n.t === 'data' ? Buffer.from(n.v, 'base64').toString('utf8') : text);
      case 'integer':
        if (n.t === 'real') return int(Math.trunc(n.v));
        if (n.t === 'bool') return int(n.v ? 1 : 0);
        if (n.t === 'date') return int(Math.round(new Date(n.v).getTime() / 1000));
        return int(text);
      case 'real': {
        if (n.t === 'bool') return real(n.v ? 1 : 0);
        const x = Number(text);
        return Number.isFinite(x) ? real(x) : empty('real');
      }
      case 'bool': return bool(n.t === 'string' ? /^(yes|true|1)$/i.test(text.trim()) : n.t === 'integer' || n.t === 'real' ? Number(n.v) !== 0 : false);
      case 'date': return date(n.t === 'integer' || n.t === 'real' ? new Date(Number(n.v) * 1000) : text);
      case 'data': return data(Buffer.from(n.t === 'string' ? n.v : text, 'utf8'));
      default: return empty(t);
    }
  } catch (e) {
    return empty(t);
  }
}

/** Short text for a value cell. */
function display(n) {
  switch (n.t) {
    case 'dict': return `(${n.v.length} item${n.v.length === 1 ? '' : 's'})`;
    case 'array': return `(${n.v.length} item${n.v.length === 1 ? '' : 's'})`;
    case 'bool': return n.v ? 'YES' : 'NO';
    case 'real': return Number.isInteger(n.v) ? n.v.toFixed(1) : String(n.v);
    case 'data': {
      const b = Buffer.from(n.v, 'base64');
      return `<${b.subarray(0, 32).toString('hex').replace(/(.{8})/g, '$1 ').trim()}${b.length > 32 ? ' ...' : ''}>`;
    }
    case 'uid': return `UID ${n.v}`;
    case 'null': return 'null';
    default: return String(n.v);
  }
}

/** Parses the text a user typed in a value cell for a node of type t. Throws a readable error. */
function parseValue(t, text) {
  const s = String(text);
  switch (t) {
    case 'string': return str(s);
    case 'integer': return int(s);
    case 'real': {
      const x = Number(s.trim());
      if (s.trim() === '' || Number.isNaN(x)) throw new Error(`"${s}" is not a number`);
      return real(x);
    }
    case 'bool': {
      if (/^(yes|true|1)$/i.test(s.trim())) return bool(true);
      if (/^(no|false|0)$/i.test(s.trim())) return bool(false);
      throw new Error('Use YES or NO');
    }
    case 'date': return date(s);
    case 'data': {
      const hex = s.replace(/^<|>$/g, '').replace(/\s+/g, '');
      if (!/^([0-9a-f]{2})*$/i.test(hex)) throw new Error('Data must be hex bytes, for example 00 1f a2');
      return data(Buffer.from(hex, 'hex'));
    }
    case 'uid': {
      if (!/^\d+$/.test(s.trim())) throw new Error('A UID is a whole number from 0');
      return { t: 'uid', v: Number(s.trim()) };
    }
    default: throw new Error(`A ${TYPE_LABEL[t] || t} has no single value`);
  }
}

/** Key path text like CFBundleURLTypes[0].CFBundleURLSchemes. */
function keyPath(root, path) {
  let n = root;
  let out = '';
  for (const i of path) {
    if (n.t === 'dict') {
      const k = n.v[i][0];
      out += (out ? '.' : '') + (/^[A-Za-z_][\w-]*$/.test(k) ? k : JSON.stringify(k));
      n = n.v[i][1];
    } else {
      out += `[${i}]`;
      n = n.v[i];
    }
  }
  return out || 'Root';
}

/** Plain JavaScript value (for JSON): dates as ISO strings, data as base64, integers as numbers when safe. */
function toPlain(n) {
  switch (n.t) {
    case 'dict': return Object.fromEntries(n.v.map(([k, c]) => [k, toPlain(c)]));
    case 'array': return n.v.map(toPlain);
    case 'integer': { const b = BigInt(n.v); return b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : n.v; }
    case 'uid': return { 'CF$UID': n.v };
    case 'null': return null;
    default: return n.v;
  }
}

module.exports = {
  TYPES, TYPE_LABEL, str, int, real, bool, date, data, dict, array, normInt, normDate,
  isContainer, clone, at, count, equal, empty, retype, display, parseValue, keyPath, toPlain,
};
