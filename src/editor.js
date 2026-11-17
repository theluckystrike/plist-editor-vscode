'use strict';
// The custom editor: one PlistDocument per file. Edits arrive from the webview, are applied here, and go to VS Code
// as undoable edits; save writes the same format the file came in (binary stays binary). Nothing is written to disk
// unless the user saves, and a file that was only opened is never rewritten.
const vscode = require('vscode');
const path = require('path');
const F = require('./core/format');
const M = require('./core/model');
const E = require('./core/edits');
const X = require('./core/xml');
const { KEYS } = require('./core/keys');
const { editorHtml } = require('./html');
const { commandUris } = require('./support');

const VIEW_TYPE = 'plistEditor.editor';
const PREFIX = 'plistEditor';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);
const baseName = (uri) => path.posix.basename(uri.path);

let keysForWebview = null;
function keysPayload() {
  if (!keysForWebview) keysForWebview = Object.fromEntries(Object.entries(KEYS).map(([k, v]) => [k, { name: v.name, note: v.note }]));
  return keysForWebview;
}

class PlistDocument {
  constructor(uri) {
    this.uri = uri;
    this.root = null;
    this.format = 'xml';
    this.style = {};
    this.readOnly = false;
    this.note = '';
    this.failed = '';
    this.savedBytes = null;
    this.dirty = 0;
    this.panels = new Set();
    this.issues = null;
    this._onDispose = new vscode.EventEmitter();
    this.onDidDispose = this._onDispose.event;
  }
  load(bytes) {
    this.failed = '';
    this.issues = null;
    try {
      const r = F.read(Buffer.from(bytes), baseName(this.uri));
      this.root = r.root;
      this.format = r.format;
      this.style = r.style || {};
      this.readOnly = !!r.readOnly;
      this.note = r.note || '';
      if (r.format === 'openstep' && this.style.comments) this.note = 'Old-style OpenStep plist. Saving writes it in the same format, without the comments it has now.';
      if (r.format === 'json') this.note = 'JSON file shown as a plist tree. Saving writes JSON.';
    } catch (e) {
      this.root = null;
      this.failed = String((e && e.message) || e);
      this.readOnly = true;
    }
  }
  bytes() { return F.write(this.root, this.format, this.style); }
  dispose() { this._onDispose.fire(); this._onDispose.dispose(); }
}

class PlistEditorProvider {
  constructor(context, hooks) {
    this.context = context;
    this.hooks = hooks || {};
    this.docs = new Set();
    this.active = null;
    this._onDidChange = new vscode.EventEmitter();
    this.onDidChangeCustomDocument = this._onDidChange.event;
    this._onTree = new vscode.EventEmitter();
    this.onDidChangeTree = this._onTree.event;
  }

  async openCustomDocument(uri, openContext) {
    const doc = new PlistDocument(uri);
    const src = openContext && openContext.backupId ? vscode.Uri.parse(openContext.backupId) : uri;
    let bytes;
    try {
      const st = await vscode.workspace.fs.stat(src);
      const max = Number(setting('maxFileSizeMB', 100)) || 100;
      if (st.size > max * 1024 * 1024) {
        doc.failed = `The file is ${(st.size / 1048576).toFixed(1)} MB, more than the ${max} MB set in plistEditor.maxFileSizeMB. Raise the setting to open it.`;
        doc.readOnly = true;
        this.docs.add(doc);
        return doc;
      }
      bytes = await vscode.workspace.fs.readFile(src);
    } catch (e) {
      doc.failed = `The file could not be read: ${(e && e.message) || e}`;
      doc.readOnly = true;
      this.docs.add(doc);
      return doc;
    }
    doc.load(bytes);
    if (!(openContext && openContext.backupId)) doc.savedBytes = Buffer.from(bytes);
    else {
      doc.dirty = 1;
      try { doc.savedBytes = Buffer.from(await vscode.workspace.fs.readFile(uri)); } catch (e) { doc.savedBytes = null; }
    }
    this.docs.add(doc);
    this.watch(doc);
    doc.onDidDispose(() => { this.docs.delete(doc); if (this.active === doc) this.active = null; });
    return doc;
  }

  watch(doc) {
    if (doc.uri.scheme !== 'file' || !vscode.workspace.createFileSystemWatcher) return;
    const w = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.joinPath(doc.uri, '..'), baseName(doc.uri)));
    const changed = async () => {
      if (doc.dirty) return; // the user's unsaved edits win; VS Code asks on save
      let bytes;
      try { bytes = Buffer.from(await vscode.workspace.fs.readFile(doc.uri)); } catch (e) { return; }
      if (doc.savedBytes && bytes.equals(doc.savedBytes)) return;
      doc.savedBytes = bytes;
      doc.load(bytes);
      this.sendInit(doc);
      this._onTree.fire(doc);
    };
    const subs = [w, w.onDidChange(changed), w.onDidCreate(changed)];
    doc.onDidDispose(() => subs.forEach((s) => s.dispose()));
  }

  async resolveCustomEditor(doc, panel) {
    doc.panels.add(panel);
    this.active = doc;
    const media = vscode.Uri.joinPath(this.context.extensionUri, 'media');
    const reach = this.hooks.reach && this.hooks.reach();
    panel.webview.options = {
      enableScripts: true,
      enableCommandUris: [...new Set([...commandUris(PREFIX), ...(reach ? reach.commandIds() : [])])],
      localResourceRoots: [media],
    };
    panel.webview.html = editorHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'editor.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'editor.css')).toString(),
      title: baseName(doc.uri),
      showSupportLinks: setting('showSupportLinks', true) !== false,
      head: reach ? (n) => reach.headHtml(n) : undefined,
      canOpenText: doc.format !== 'binary' && doc.format !== 'profile',
    });
    if (reach) reach.attach(panel.webview, panel);
    panel.onDidChangeViewState((e) => { if (e.webviewPanel.active) this.active = doc; });
    panel.onDidDispose(() => { doc.panels.delete(panel); });
    let counted = false;
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m || typeof m !== 'object') return;
      try {
        if (m.type === 'ready') this.sendInit(doc, panel);
        else if (m.type === 'rendered') {
          if (counted) return;
          counted = true;
          if (m.failed) { if (this.hooks.onFailure) this.hooks.onFailure(doc); } else if (this.hooks.onSuccess) this.hooks.onSuccess(doc);
        } else if (m.type === 'edit') await this.edit(doc, m.op, panel);
        else if (m.type === 'copy') await this.copy(doc, m.what, m.path);
        else if (m.type === 'showNames') await vscode.workspace.getConfiguration(PREFIX).update('showKeyNames', !!m.on, vscode.ConfigurationTarget.Global);
        else if (m.type === 'command') {
          this.active = doc;
          if (m.id === 'openAsText') await vscode.commands.executeCommand('vscode.openWith', doc.uri, 'default');
          else if (m.id === 'showXml') await vscode.commands.executeCommand(`${PREFIX}.showXml`, doc.uri);
          else if (m.id === 'saveCopy') await vscode.commands.executeCommand(`${PREFIX}.saveCopyAs`, doc.uri);
        }
      } catch (e) {
        panel.webview.postMessage({ type: 'error', message: String((e && e.message) || e) });
      }
    });
  }

  sendInit(doc, only) {
    const label = doc.failed ? '' : F.FORMAT_LABEL[doc.format] || doc.format;
    const msg = doc.failed
      ? { type: 'failed', message: doc.failed }
      : {
        type: 'init', tree: doc.root, format: doc.format, formatLabel: `${label}${doc.readOnly ? ' (read-only)' : ''}`,
        formatTitle: doc.format === 'binary' ? 'Binary plist (bplist00). Saving keeps it binary.' : doc.format === 'xml' ? 'XML plist. Saving keeps the XML format and its indent.' : '',
        readOnly: doc.readOnly, note: doc.note, keys: keysPayload(), showNames: setting('showKeyNames', true) !== false,
        issues: doc.issues || [],
      };
    for (const p of only ? [only] : doc.panels) p.webview.postMessage(msg);
  }

  sendTree(doc, extra) {
    for (const p of doc.panels) p.webview.postMessage({ type: 'tree', tree: doc.root, ...(extra || {}) });
    this._onTree.fire(doc);
  }

  /** Translates a webview edit into a core edit, applies it and registers undo and redo with VS Code. */
  async edit(doc, w, panel) {
    if (doc.readOnly || !doc.root) throw new Error(doc.failed ? 'The file could not be read, so it cannot be edited.' : 'This file is read-only.');
    let op;
    let focus = null;
    let editKey = false;
    switch (w.op) {
      case 'setKey': op = { op: 'setKey', path: w.path, key: String(w.key) }; break;
      case 'setValue': {
        const old = M.at(doc.root, w.path);
        if (!old) throw new Error('That row no longer exists.');
        let t = old.t;
        const text = String(w.text);
        if (t === 'integer' && /^[+-]?(\d+\.\d*|\.\d+|\d+(\.\d*)?e[+-]?\d+|nan|[+-]?inf(inity)?)$/i.test(text.trim())) t = 'real';
        let node = M.parseValue(t, text);
        if (old.t === 'real' && node.t === 'real' && old.f32) node = { ...node, f32: Math.fround(node.v) === node.v };
        op = { op: 'replace', path: w.path, node };
        break;
      }
      case 'setType': {
        const old = M.at(doc.root, w.path);
        if (!old) throw new Error('That row no longer exists.');
        if (!M.TYPES.includes(w.t)) throw new Error('Unknown type.');
        op = { op: 'replace', path: w.path, node: M.retype(old, w.t) };
        break;
      }
      case 'insert': {
        const parent = M.at(doc.root, w.parent);
        if (!M.isContainer(parent)) throw new Error('Items can be added only to a dictionary or an array.');
        op = { op: 'insert', parent: w.parent, index: w.index, node: M.str('') };
        if (parent.t === 'dict') op.key = E.uniqueKey(parent, 'New item');
        focus = w.parent.concat(Math.max(0, Math.min(w.index, parent.v.length)));
        editKey = true;
        break;
      }
      case 'duplicate': {
        const parentPath = w.path.slice(0, -1);
        const parent = M.at(doc.root, parentPath);
        const i = w.path[w.path.length - 1];
        if (!M.isContainer(parent) || parent.v[i] === undefined) throw new Error('That row no longer exists.');
        const src = parent.t === 'dict' ? parent.v[i] : [null, parent.v[i]];
        op = { op: 'insert', parent: parentPath, index: i + 1, node: M.clone(src[1]) };
        if (parent.t === 'dict') op.key = E.uniqueKey(parent, `${src[0]} copy`);
        focus = parentPath.concat(i + 1);
        editKey = parent.t === 'dict';
        break;
      }
      case 'remove': op = { op: 'remove', parent: w.parent, index: w.index }; focus = w.parent.concat(Math.max(0, w.index - 1)); break;
      case 'move': {
        const parent = M.at(doc.root, w.parent);
        if (!M.isContainer(parent) || w.to < 0 || w.to >= parent.v.length) return; // already first or last
        op = { op: 'move', parent: w.parent, from: w.from, to: w.to };
        focus = w.focusPath || w.parent.concat(w.to);
        break;
      }
      default: throw new Error('Unknown edit.');
    }
    const inverse = E.apply(doc, op);
    doc.dirty++;
    doc.issues = null;
    this.sendTree(doc, focus ? { focus, editKey, issues: [] } : { issues: [] });
    const label = E.label(op);
    this._onDidChange.fire({
      document: doc,
      label,
      undo: () => { E.apply(doc, inverse); doc.dirty--; this.sendTree(doc); },
      redo: () => { E.apply(doc, op); doc.dirty++; this.sendTree(doc); },
    });
    void panel;
  }

  async copy(doc, what, p) {
    const n = M.at(doc.root, p || []);
    if (!n) return;
    let text = '';
    if (what === 'key') { const parent = M.at(doc.root, p.slice(0, -1)); text = parent && parent.t === 'dict' ? parent.v[p[p.length - 1]][0] : ''; }
    else if (what === 'path') text = M.keyPath(doc.root, p);
    else if (what === 'json') text = JSON.stringify(M.toPlain(n), null, 2);
    else if (what === 'xml') text = fragment(n, doc.root, p);
    else text = n.t === 'string' ? n.v : n.t === 'data' ? Buffer.from(n.v, 'base64').toString('hex') : M.isContainer(n) ? JSON.stringify(M.toPlain(n), null, 2) : M.display(n);
    await vscode.env.clipboard.writeText(text);
    vscode.window.setStatusBarMessage(`Copied ${what === 'path' ? 'the key path' : what === 'key' ? 'the key' : what === 'xml' ? 'as XML' : what === 'json' ? 'as JSON' : 'the value'}.`, 3000);
  }

  async saveCustomDocument(doc) {
    const bytes = doc.bytes();
    await vscode.workspace.fs.writeFile(doc.uri, bytes);
    doc.savedBytes = Buffer.from(bytes);
    doc.dirty = 0;
  }

  async saveCustomDocumentAs(doc, dest) {
    const fmt = /\.json$/i.test(dest.path) ? 'json' : doc.format === 'profile' ? 'xml' : doc.format;
    await vscode.workspace.fs.writeFile(dest, F.write(doc.root, fmt, fmt === doc.format ? doc.style : {}));
  }

  async revertCustomDocument(doc) {
    const bytes = await vscode.workspace.fs.readFile(doc.uri);
    doc.load(bytes);
    doc.savedBytes = Buffer.from(bytes);
    doc.dirty = 0;
    this.sendInit(doc);
    this._onTree.fire(doc);
  }

  async backupCustomDocument(doc, context) {
    const dest = context.destination;
    await vscode.workspace.fs.writeFile(dest, doc.root ? doc.bytes() : Buffer.alloc(0));
    return { id: dest.toString(), delete: async () => { try { await vscode.workspace.fs.delete(dest); } catch (e) { /* gone */ } } };
  }

  docFor(uri) {
    if (uri) for (const d of this.docs) if (d.uri.toString() === uri.toString()) return d;
    return uri ? null : this.active;
  }
  postIssues(doc, issues) {
    doc.issues = issues;
    for (const p of doc.panels) p.webview.postMessage({ type: 'issues', issues });
  }
  reveal(doc, p) {
    for (const panel of doc.panels) { panel.reveal(panel.viewColumn, false); panel.webview.postMessage({ type: 'reveal', path: p }); }
  }
}

/** "Copy as XML": the value element (with its key line for a dictionary entry) without the plist wrapper. */
function fragment(n, root, p) {
  const text = X.write(n, { prolog: '', finalNewline: false });
  const inner = text.replace(/^<plist[^>]*>\n/, '').replace(/\n<\/plist>$/, '');
  if (!p.length) return inner;
  const parent = M.at(root, p.slice(0, -1));
  if (parent && parent.t === 'dict') {
    const k = parent.v[p[p.length - 1]][0].replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<key>${k}</key>\n${inner}`;
  }
  return inner;
}

module.exports = { PlistEditorProvider, PlistDocument, VIEW_TYPE, fragment };
