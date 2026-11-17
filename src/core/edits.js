'use strict';
// Edit operations on a document { root }. Each apply() returns the inverse operation, so undo and redo are exact.
//   setKey  { path, key }                 rename a dictionary key
//   replace { path, node }                new value or type (path [] replaces the top value)
//   insert  { parent, index, key?, node } add a row (key for dictionaries)
//   remove  { parent, index }             delete a row
//   move    { parent, from, to }          reorder a row inside its container
const M = require('./model');

function container(doc, path) {
  const n = M.at(doc.root, path);
  if (!M.isContainer(n)) throw new Error('That row is not a dictionary or an array.');
  return n;
}

function uniqueKey(dict, base) {
  const keys = new Set(dict.v.map(([k]) => k));
  if (!keys.has(base)) return base;
  for (let i = 2; ; i++) if (!keys.has(`${base} ${i}`)) return `${base} ${i}`;
}

function apply(doc, op) {
  switch (op.op) {
    case 'setKey': {
      if (!op.path.length) throw new Error('The top row has no key.');
      const parent = container(doc, op.path.slice(0, -1));
      if (parent.t !== 'dict') throw new Error('Array items have no key.');
      const i = op.path[op.path.length - 1];
      const key = String(op.key);
      if (parent.v.some(([k], j) => k === key && j !== i)) throw new Error(`The key "${key}" is already in this dictionary.`);
      const old = parent.v[i][0];
      parent.v[i][0] = key;
      return { op: 'setKey', path: op.path, key: old };
    }
    case 'replace': {
      if (!op.path.length) { const old = doc.root; doc.root = op.node; return { op: 'replace', path: [], node: old }; }
      const parent = container(doc, op.path.slice(0, -1));
      const i = op.path[op.path.length - 1];
      if (parent.v[i] === undefined) throw new Error('That row no longer exists.');
      let old;
      if (parent.t === 'dict') { old = parent.v[i][1]; parent.v[i][1] = op.node; } else { old = parent.v[i]; parent.v[i] = op.node; }
      return { op: 'replace', path: op.path, node: old };
    }
    case 'insert': {
      const parent = container(doc, op.parent);
      const index = Math.max(0, Math.min(op.index, parent.v.length));
      if (parent.t === 'dict') {
        const key = op.key === undefined ? uniqueKey(parent, 'New item') : String(op.key);
        if (parent.v.some(([k]) => k === key)) throw new Error(`The key "${key}" is already in this dictionary.`);
        parent.v.splice(index, 0, [key, op.node]);
      } else {
        parent.v.splice(index, 0, op.node);
      }
      return { op: 'remove', parent: op.parent, index };
    }
    case 'remove': {
      const parent = container(doc, op.parent);
      if (parent.v[op.index] === undefined) throw new Error('That row no longer exists.');
      const [gone] = parent.v.splice(op.index, 1);
      return parent.t === 'dict' ? { op: 'insert', parent: op.parent, index: op.index, key: gone[0], node: gone[1] } : { op: 'insert', parent: op.parent, index: op.index, node: gone };
    }
    case 'move': {
      const parent = container(doc, op.parent);
      const { from, to } = op;
      if (from < 0 || from >= parent.v.length || to < 0 || to >= parent.v.length) throw new Error('Cannot move the row there.');
      const [x] = parent.v.splice(from, 1);
      parent.v.splice(to, 0, x);
      return { op: 'move', parent: op.parent, from: to, to: from };
    }
    default: throw new Error(`Unknown edit ${op.op}`);
  }
}

/** Short label for the undo stack. */
function label(op) {
  return { setKey: 'Rename key', replace: 'Change value', insert: 'Add item', remove: 'Delete item', move: 'Move item' }[op.op] || 'Edit';
}

module.exports = { apply, label, uniqueKey };
