'use strict';
// Binary property lists (bplist00), read and written with our own code. Format: the "bplist00" header, the objects,
// an offset table and a 32-byte trailer (offset size, reference size, object count, top object, table offset).
const MAGIC = Buffer.from('bplist00', 'latin1');
const EPOCH_2001 = Date.UTC(2001, 0, 1); // binary dates are seconds since 2001-01-01 UTC
const MAX_OBJECTS = 20_000_000;
const MAX_DEPTH = 512;

function isBinary(buf) {
  return buf.length >= 8 && buf.subarray(0, 6).toString('latin1') === 'bplist';
}

function readUInt(buf, pos, size) {
  if (pos + size > buf.length) throw new Error('The binary plist ends early (it may be cut off).');
  let v = 0n;
  for (let i = 0; i < size; i++) v = (v << 8n) | BigInt(buf[pos + i]);
  return v;
}
const readNum = (buf, pos, size) => Number(readUInt(buf, pos, size));

function parse(buf) {
  if (!isBinary(buf)) throw new Error('This is not a binary plist (no bplist header).');
  const ver = buf.subarray(6, 8).toString('latin1');
  if (ver !== '00') throw new Error(`Binary plist version "bplist${ver}" is not supported (only bplist00).`);
  if (buf.length < 8 + 32) throw new Error('The binary plist is too short to hold a trailer.');
  const t = buf.length - 32;
  const offSize = buf[t + 6];
  const refSize = buf[t + 7];
  const numObjects = readNum(buf, t + 8, 8);
  const top = readNum(buf, t + 16, 8);
  const tableAt = readNum(buf, t + 24, 8);
  if (![1, 2, 4, 8].includes(offSize) || ![1, 2, 4, 8].includes(refSize)) throw new Error('The binary plist trailer is damaged (bad offset or reference size).');
  if (numObjects < 1 || numObjects > MAX_OBJECTS) throw new Error('The binary plist trailer is damaged (bad object count).');
  if (top >= numObjects) throw new Error('The binary plist trailer is damaged (top object out of range).');
  if (tableAt < 8 || tableAt + numObjects * offSize > t) throw new Error('The binary plist trailer is damaged (offset table out of range).');
  const offsets = new Array(numObjects);
  for (let i = 0; i < numObjects; i++) {
    const o = readNum(buf, tableAt + i * offSize, offSize);
    if (o < 8 || o >= tableAt) throw new Error(`The binary plist is damaged: object ${i} points outside the object area.`);
    offsets[i] = o;
  }

  const active = new Set();
  function lengthAt(pos, low) {
    if (low !== 0xf) return { len: low, pos: pos + 1 };
    const m = buf[pos + 1];
    if ((m & 0xf0) !== 0x10) throw new Error(`Bad length marker at byte ${pos + 1}.`);
    const size = 1 << (m & 0xf);
    return { len: readNum(buf, pos + 2, size), pos: pos + 2 + size };
  }
  function obj(ref, depth) {
    if (ref >= numObjects) throw new Error(`Reference ${ref} is out of range.`);
    if (depth > MAX_DEPTH) throw new Error('The plist is nested too deeply.');
    if (active.has(ref)) throw new Error('The binary plist contains a loop (an object that contains itself).');
    const pos = offsets[ref];
    const m = buf[pos];
    const hi = m >> 4;
    const low = m & 0xf;
    switch (hi) {
      case 0x0:
        if (m === 0x00) return { t: 'null' };
        if (m === 0x08) return { t: 'bool', v: false };
        if (m === 0x09) return { t: 'bool', v: true };
        throw new Error(`Unknown object type 0x${m.toString(16)} at byte ${pos}.`);
      case 0x1: {
        const size = 1 << low;
        if (size > 16) throw new Error(`Integer of ${size} bytes at byte ${pos} is not supported.`);
        let v = readUInt(buf, pos + 1, size);
        if (size === 8 && v >= 2n ** 63n) v -= 2n ** 64n; // 8-byte integers are signed
        if (size === 16 && v >= 2n ** 127n) v -= 2n ** 128n;
        return { t: 'integer', v: v.toString() };
      }
      case 0x2: {
        if (low === 2) { if (pos + 5 > buf.length) throw new Error('Cut off number.'); return { t: 'real', v: buf.readFloatBE(pos + 1), f32: true }; }
        if (low === 3) { if (pos + 9 > buf.length) throw new Error('Cut off number.'); return { t: 'real', v: buf.readDoubleBE(pos + 1) }; }
        throw new Error(`Real number of 2^${low} bytes at byte ${pos} is not supported.`);
      }
      case 0x3: {
        if (m !== 0x33) throw new Error(`Bad date marker at byte ${pos}.`);
        const secs = buf.readDoubleBE(pos + 1);
        const d = new Date(EPOCH_2001 + secs * 1000);
        if (Number.isNaN(d.getTime())) return { t: 'date', v: new Date(EPOCH_2001).toISOString().replace('.000Z', 'Z') };
        return { t: 'date', v: d.toISOString().replace('.000Z', 'Z') };
      }
      case 0x4: {
        const l = lengthAt(pos, low);
        if (l.pos + l.len > buf.length) throw new Error('Cut off data.');
        return { t: 'data', v: buf.subarray(l.pos, l.pos + l.len).toString('base64') };
      }
      case 0x5: {
        const l = lengthAt(pos, low);
        if (l.pos + l.len > buf.length) throw new Error('Cut off string.');
        return { t: 'string', v: buf.subarray(l.pos, l.pos + l.len).toString('latin1') };
      }
      case 0x6: {
        const l = lengthAt(pos, low);
        if (l.pos + l.len * 2 > buf.length) throw new Error('Cut off string.');
        const b = Buffer.from(buf.subarray(l.pos, l.pos + l.len * 2));
        b.swap16();
        return { t: 'string', v: b.toString('utf16le') };
      }
      case 0x7: {
        const l = lengthAt(pos, low);
        return { t: 'string', v: buf.subarray(l.pos, l.pos + l.len).toString('utf8') };
      }
      case 0x8: return { t: 'uid', v: readNum(buf, pos + 1, low + 1) };
      case 0xa: case 0xb: case 0xc: {
        const l = lengthAt(pos, low);
        active.add(ref);
        const items = [];
        for (let i = 0; i < l.len; i++) items.push(obj(readNum(buf, l.pos + i * refSize, refSize), depth + 1));
        active.delete(ref);
        return hi === 0xa ? { t: 'array', v: items } : { t: 'array', set: true, v: items };
      }
      case 0xd: {
        const l = lengthAt(pos, low);
        active.add(ref);
        const entries = [];
        const seen = new Set();
        for (let i = 0; i < l.len; i++) {
          const k = obj(readNum(buf, l.pos + i * refSize, refSize), depth + 1);
          if (k.t !== 'string') throw new Error(`A dictionary key at byte ${pos} is not a string.`);
          const v = obj(readNum(buf, l.pos + (l.len + i) * refSize, refSize), depth + 1);
          if (seen.has(k.v)) continue; // CoreFoundation keeps one value per key
          seen.add(k.v);
          entries.push([k.v, v]);
        }
        active.delete(ref);
        return { t: 'dict', v: entries };
      }
      default: throw new Error(`Unknown object type 0x${m.toString(16)} at byte ${pos}.`);
    }
  }
  return obj(top, 0);
}

function bytesFor(n) { return n < 0x100 ? 1 : n < 0x10000 ? 2 : n < 0x100000000 ? 4 : 8; }

function writeUInt(n, size) {
  const b = Buffer.alloc(size);
  let v = BigInt(n);
  for (let i = size - 1; i >= 0; i--) { b[i] = Number(v & 0xffn); v >>= 8n; }
  return b;
}

function intBytes(s) {
  const v = BigInt(s);
  if (v >= 0n && v < 0x100n) return Buffer.concat([Buffer.from([0x10]), writeUInt(v, 1)]);
  if (v >= 0n && v < 0x10000n) return Buffer.concat([Buffer.from([0x11]), writeUInt(v, 2)]);
  if (v >= 0n && v < 0x100000000n) return Buffer.concat([Buffer.from([0x12]), writeUInt(v, 4)]);
  if (v >= -(2n ** 63n) && v < 2n ** 63n) return Buffer.concat([Buffer.from([0x13]), writeUInt(v < 0n ? v + 2n ** 64n : v, 8)]);
  return Buffer.concat([Buffer.from([0x14]), writeUInt(v < 0n ? v + 2n ** 128n : v, 16)]);
}

function marker(hi, len) {
  if (len < 15) return Buffer.from([(hi << 4) | len]);
  const ib = intBytes(String(len));
  return Buffer.concat([Buffer.from([(hi << 4) | 0xf]), ib]);
}

/** Writes a node tree as bplist00. Equal strings, numbers, dates and data are stored once, like CoreFoundation. */
function write(root) {
  const objects = []; // { kind, node, refs }
  const unique = new Map();
  function add(n) {
    if (n.t === 'dict' || n.t === 'array') {
      const idx = objects.length;
      const o = { node: n, refs: null };
      objects.push(o);
      if (n.t === 'dict') {
        const keys = n.v.map(([k]) => add({ t: 'string', v: k }));
        const vals = n.v.map(([, c]) => add(c));
        o.refs = keys.concat(vals);
      } else {
        o.refs = n.v.map(add);
      }
      return idx;
    }
    const k = n.t + '\u0000' + (n.t === 'real' && n.f32 ? 'f' : '') + String(n.v);
    if (unique.has(k)) return unique.get(k);
    const idx = objects.length;
    objects.push({ node: n });
    unique.set(k, idx);
    return idx;
  }
  add(root);
  const refSize = bytesFor(objects.length);
  const parts = [MAGIC];
  let pos = MAGIC.length;
  const offsets = [];
  for (const o of objects) {
    offsets.push(pos);
    const b = encode(o, refSize);
    parts.push(b);
    pos += b.length;
  }
  const offSize = bytesFor(pos);
  const tableAt = pos;
  for (const o of offsets) parts.push(writeUInt(o, offSize));
  const trailer = Buffer.alloc(32);
  trailer[6] = offSize;
  trailer[7] = refSize;
  writeUInt(objects.length, 8).copy(trailer, 8);
  writeUInt(0, 8).copy(trailer, 16);
  writeUInt(tableAt, 8).copy(trailer, 24);
  parts.push(trailer);
  return Buffer.concat(parts);
}

function encode(o, refSize) {
  const n = o.node;
  switch (n.t) {
    case 'null': return Buffer.from([0x00]);
    case 'bool': return Buffer.from([n.v ? 0x09 : 0x08]);
    case 'integer': return intBytes(n.v);
    case 'real': {
      if (n.f32 && Math.fround(n.v) === n.v) { const b = Buffer.alloc(5); b[0] = 0x22; b.writeFloatBE(n.v, 1); return b; }
      const b = Buffer.alloc(9); b[0] = 0x23; b.writeDoubleBE(n.v, 1); return b;
    }
    case 'date': {
      const b = Buffer.alloc(9); b[0] = 0x33; b.writeDoubleBE((new Date(n.v).getTime() - EPOCH_2001) / 1000, 1); return b;
    }
    case 'data': { const d = Buffer.from(n.v, 'base64'); return Buffer.concat([marker(0x4, d.length), d]); }
    case 'string': {
      const s = String(n.v);
      // eslint-disable-next-line no-control-regex
      if (/^[\x00-\x7f]*$/.test(s)) return Buffer.concat([marker(0x5, s.length), Buffer.from(s, 'latin1')]);
      const b = Buffer.from(s, 'utf16le');
      b.swap16();
      return Buffer.concat([marker(0x6, b.length / 2), b]);
    }
    case 'uid': {
      const v = Number(n.v);
      const size = v < 0x100 ? 1 : v < 0x10000 ? 2 : v < 0x100000000 ? 4 : 8;
      return Buffer.concat([Buffer.from([0x80 | (size - 1)]), writeUInt(v, size)]);
    }
    case 'array': {
      const hi = n.set ? 0xc : 0xa;
      return Buffer.concat([marker(hi, o.refs.length), ...o.refs.map((r) => writeUInt(r, refSize))]);
    }
    case 'dict': return Buffer.concat([marker(0xd, o.refs.length / 2), ...o.refs.map((r) => writeUInt(r, refSize))]);
    default: throw new Error(`Cannot write a value of type ${n.t}.`);
  }
}

module.exports = { parse, write, isBinary, EPOCH_2001 };
