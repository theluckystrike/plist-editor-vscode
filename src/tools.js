'use strict';
// Commands: Show XML, Save a Copy As (free) and the three Pro tools (compare, batch convert, check).
const vscode = require('vscode');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFile } = require('child_process');
const F = require('./core/format');
const M = require('./core/model');
const D = require('./core/diff');
const C = require('./core/check');
const X = require('./core/xml');
const { panelHtml } = require('./html');

const PREFIX = 'plistEditor';
const PLIST_EXT = /\.(plist|entitlements|xcprivacy|mobileprovision|provisionprofile)$/i;
const CONVERTIBLE = /\.(plist|entitlements|xcprivacy)$/i;
const SKIP_DIRS = new Set(['node_modules', '.git', 'Pods', 'DerivedData', '.build', 'build', '.svn', '.hg']);
const baseName = (uri) => path.posix.basename(uri.path);
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

function createTools({ context, provider, pro, reach, viewType }) {
  const panels = {};

  // ---------- helpers ----------
  async function readTree(uri) {
    const doc = provider.docFor(uri);
    if (doc && doc.root) return { root: doc.root, format: doc.format, style: doc.style, label: `${baseName(uri)}${doc.dirty ? ' (unsaved edits)' : ''}` };
    const bytes = await vscode.workspace.fs.readFile(uri);
    const r = F.read(Buffer.from(bytes), baseName(uri));
    return { root: r.root, format: r.format, style: r.style, label: baseName(uri) };
  }
  function targetUri(arg) {
    if (arg && arg.scheme) return arg;
    if (provider.active) return provider.active.uri;
    const ed = vscode.window.activeTextEditor;
    if (ed && PLIST_EXT.test(ed.document.uri.path)) return ed.document.uri;
    return null;
  }
  async function pickFile(title) {
    const r = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Choose', title, filters: { 'Property lists': ['plist', 'entitlements', 'xcprivacy', 'mobileprovision', 'provisionprofile', 'strings'], 'All files': ['*'] } });
    return r && r[0];
  }
  function git(args, cwd) {
    return new Promise((resolve, reject) => {
      execFile('git', args, { cwd, encoding: 'buffer', maxBuffer: 256 * 1024 * 1024, timeout: 20000 }, (err, stdout, stderr) => {
        if (err) { const e = new Error(String(stderr || err.message).trim() || 'git failed'); e.code = err.code; reject(e); } else resolve(stdout);
      });
    });
  }
  async function gitHead(uri) {
    // git runs only in a trusted folder (README Privacy, package.json untrustedWorkspaces): Restricted Mode never starts it
    if (!vscode.workspace.isTrusted) return null;
    if (uri.scheme !== 'file') return null;
    const real = fs.realpathSync.native(uri.fsPath);
    const dir = path.dirname(real);
    let top;
    try { top = (await git(['rev-parse', '--show-toplevel'], dir)).toString('utf8').trim(); } catch (e) { return null; }
    const rel = path.relative(fs.realpathSync.native(top), real).split(path.sep).join('/');
    try { return await git(['show', `HEAD:${rel}`], top); } catch (e) { return null; }
  }

  function openPanel(kind, title) {
    const media = vscode.Uri.joinPath(context.extensionUri, 'media');
    let p = panels[kind];
    if (p) { p.panel.title = title; p.panel.reveal(vscode.ViewColumn.Beside, false); return p; }
    const panel = vscode.window.createWebviewPanel(`${PREFIX}.${kind}`, title, { viewColumn: vscode.ViewColumn.Beside, preserveFocus: false }, {
      enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [media],
      enableCommandUris: reach ? reach.commandIds().concat(require('./support').commandUris(PREFIX)) : require('./support').commandUris(PREFIX),
    });
    panel.webview.html = panelHtml({
      cspSource: panel.webview.cspSource,
      scriptUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.js')).toString(),
      styleUri: panel.webview.asWebviewUri(vscode.Uri.joinPath(media, 'panel.css')).toString(),
      title, head: reach ? (n) => reach.headHtml(n) : undefined, showSupportLinks: setting('showSupportLinks', true) !== false,
    });
    if (reach) reach.attach(panel.webview, panel);
    p = { panel, ready: false, queue: null, onAction: null, onShown: null };
    panel.webview.onDidReceiveMessage(async (m) => {
      if (reach && reach.onMessage(m)) return;
      if (!m) return;
      try {
        if (m.type === 'ready') { p.ready = true; if (p.queue) { panel.webview.postMessage(p.queue); } }
        else if (m.type === 'shown') { const f = p.onShown; p.onShown = null; if (f) await f(); }
        else if (m.type === 'action' && p.onAction) await p.onAction(m.id);
        else if (m.type === 'reveal' && p.onReveal) await p.onReveal(m.index);
      } catch (e) { vscode.window.showErrorMessage(String((e && e.message) || e)); }
    });
    panel.onDidDispose(() => { delete panels[kind]; });
    panels[kind] = p;
    return p;
  }
  function show(p, data, onShown) {
    const msg = { type: 'data', data };
    p.onShown = onShown;
    if (p.ready) p.panel.webview.postMessage(msg); else p.queue = msg;
  }
  async function saveMarkdown(text, suggested, near) {
    const dir = near && near.scheme === 'file' ? vscode.Uri.joinPath(near, '..') : (vscode.workspace.workspaceFolders || [])[0]?.uri;
    const dest = await vscode.window.showSaveDialog({ defaultUri: dir ? vscode.Uri.joinPath(dir, suggested) : undefined, filters: { Markdown: ['md'] }, saveLabel: 'Save report' });
    if (!dest) return;
    await vscode.workspace.fs.writeFile(dest, Buffer.from(text, 'utf8'));
    vscode.window.setStatusBarMessage(`Saved ${baseName(dest)}.`, 4000);
  }

  // ---------- free: Show XML ----------
  const xmlChanged = new vscode.EventEmitter();
  const xmlUris = new Map();
  const xmlProvider = {
    onDidChange: xmlChanged.event,
    async provideTextDocumentContent(uri) {
      const src = vscode.Uri.parse(uri.query);
      const t = await readTree(src);
      return X.write(t.root, t.format === 'xml' ? t.style : {});
    },
  };
  context.subscriptions.push(xmlChanged, vscode.workspace.registerTextDocumentContentProvider('plist-xml', xmlProvider));
  context.subscriptions.push(provider.onDidChangeTree((doc) => { const u = xmlUris.get(doc.uri.toString()); if (u) xmlChanged.fire(u); }));
  async function showXml(arg) {
    const uri = targetUri(arg);
    if (!uri) { vscode.window.showInformationMessage('Open a plist file first.'); return; }
    const x = vscode.Uri.from({ scheme: 'plist-xml', path: `${uri.path}.xml`, query: uri.toString() });
    xmlUris.set(uri.toString(), x);
    const doc = await vscode.workspace.openTextDocument(x);
    await vscode.languages.setTextDocumentLanguage(doc, 'xml').then(undefined, () => doc);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true, preserveFocus: true });
  }

  // ---------- free: Save a Copy As ----------
  async function saveCopyAs(arg) {
    const uri = targetUri(arg);
    if (!uri) { vscode.window.showInformationMessage('Open a plist file first.'); return; }
    let t;
    try { t = await readTree(uri); } catch (e) { vscode.window.showErrorMessage(`${baseName(uri)} could not be read as a plist: ${e.message}`); return; }
    const items = [['xml', 'XML plist', '.plist'], ['binary', 'Binary plist', '.plist'], ['json', 'JSON', '.json'], ['openstep', 'OpenStep (old-style text)', '.plist']].map(([fmt, label, ext]) => {
      const loss = F.losses(t.root, fmt);
      return { label, fmt, ext, description: fmt === t.format ? 'the format it has now' : '', detail: loss.length ? loss.join(' ') : 'Nothing is lost.' };
    });
    const pick = await vscode.window.showQuickPick(items, { placeHolder: `Save a copy of ${baseName(uri)} as...`, matchOnDetail: false });
    if (!pick) return;
    const stem = baseName(uri).replace(/\.[^.]+$/, '');
    const name = pick.fmt === 'json' ? `${stem}.json` : `${stem}-${pick.fmt}.plist`;
    const dir = uri.scheme === 'file' ? vscode.Uri.joinPath(uri, '..') : undefined;
    const dest = await vscode.window.showSaveDialog({ defaultUri: dir ? vscode.Uri.joinPath(dir, name) : undefined, saveLabel: 'Save copy' });
    if (!dest) return;
    await vscode.workspace.fs.writeFile(dest, F.write(t.root, pick.fmt, pick.fmt === t.format ? t.style : {}));
    vscode.window.setStatusBarMessage(`Saved ${baseName(dest)} (${pick.label}).`, 5000);
  }

  // ---------- Pro: compare ----------
  async function compare(arg, uris) {
    if (!(await pro.allowed('compare', arg))) return;
    let left; let right;
    if (Array.isArray(uris) && uris.length === 2 && uris.every((u) => u && u.scheme)) {
      [left, right] = uris;
      left = { uri: left, ...(await safeRead(left)) };
      right = { uri: right, ...(await safeRead(right)) };
    } else {
      let uri = targetUri(arg);
      if (!uri) uri = await pickFile('Choose the newer plist');
      if (!uri) return;
      const doc = provider.docFor(uri);
      const head = await gitHead(uri);
      const choices = [];
      if (doc && doc.dirty) choices.push({ label: '$(save) The saved file', detail: 'Your unsaved edits against the file on disk', v: 'saved' });
      if (head) choices.push({ label: '$(git-commit) Git HEAD version', detail: 'The last committed version of this file', v: 'head' });
      choices.push({ label: '$(file) Another plist file...', detail: 'Pick any binary, XML, OpenStep or JSON plist', v: 'file' });
      const pick = choices.length === 1 ? choices[0] : await vscode.window.showQuickPick(choices, { placeHolder: `Compare ${baseName(uri)} with...` });
      if (!pick) return;
      right = { uri, ...(await safeRead(uri)) };
      if (pick.v === 'saved') {
        const r = F.read(Buffer.from(await vscode.workspace.fs.readFile(uri)), baseName(uri));
        left = { uri, root: r.root, label: `${baseName(uri)} (saved)` };
      } else if (pick.v === 'head') {
        const r = F.read(head, baseName(uri));
        left = { uri, root: r.root, label: `${baseName(uri)} (git HEAD)` };
      } else {
        const other = await pickFile('Choose the plist to compare with');
        if (!other) return;
        left = { uri: other, ...(await safeRead(other)) };
      }
    }
    if (left.error || right.error) { vscode.window.showErrorMessage((left.error || right.error)); return; }
    let swapped = false;
    const run = () => {
      const [a, b] = swapped ? [right, left] : [left, right];
      const changes = D.compare(a.root, b.root);
      return { kind: 'compare', title: `Compare: ${a.label} and ${b.label}`, left: a.label, right: b.label, counts: D.summary(changes), changes };
    };
    const p = openPanel('compare', `Compare ${right.label}`);
    let data = run();
    p.onAction = async (id) => {
      if (id === 'swap') { swapped = !swapped; data = run(); show(p, data); }
      if (id === 'saveMd') await saveMarkdown(D.markdown(data.changes, data.left, data.right), `${(right.label || 'plist').replace(/[^\w.-]+/g, '-')}-compare.md`, right.uri);
    };
    p.onReveal = null;
    show(p, data, () => pro.produced('compare'));
  }
  async function safeRead(uri) {
    try { return await readTree(uri); } catch (e) { return { error: `${baseName(uri)} could not be read as a plist: ${e.message}` }; }
  }

  // ---------- Pro: batch convert ----------
  async function walk(dir, out, limit) {
    let entries;
    try { entries = await vscode.workspace.fs.readDirectory(dir); } catch (e) { return; }
    for (const [name, type] of entries) {
      if (out.length >= limit) return;
      const u = vscode.Uri.joinPath(dir, name);
      if (type & vscode.FileType.Directory) { if (!SKIP_DIRS.has(name) && !name.endsWith('.xcassets')) await walk(u, out, limit); }
      else if (CONVERTIBLE.test(name)) out.push(u);
    }
  }
  async function batchConvert(arg) {
    if (!(await pro.allowed('convert', arg))) return;
    let folder = arg && arg.scheme ? arg : null;
    if (folder) { try { const st = await vscode.workspace.fs.stat(folder); if (!(st.type & vscode.FileType.Directory)) folder = vscode.Uri.joinPath(folder, '..'); } catch (e) { folder = null; } }
    if (!folder) {
      const r = await vscode.window.showOpenDialog({ canSelectFolders: true, canSelectFiles: false, openLabel: 'Convert this folder', defaultUri: (vscode.workspace.workspaceFolders || [])[0]?.uri });
      folder = r && r[0];
    }
    if (!folder) return;
    const target = await vscode.window.showQuickPick([
      { label: 'XML', detail: 'Readable text that diffs well in git', fmt: 'xml' },
      { label: 'Binary', detail: 'bplist00, the compact format apps ship', fmt: 'binary' },
      { label: 'JSON', detail: 'For scripts and web tools; dates and data become text', fmt: 'json' },
    ], { placeHolder: `Convert the plists in ${baseName(folder)} to...` });
    if (!target) return;
    const files = [];
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Finding plists...' }, () => walk(folder, files, 20000));
    if (!files.length) { vscode.window.showInformationMessage(`No .plist, .entitlements or .xcprivacy files in ${baseName(folder)} (node_modules, Pods, build and .git are skipped).`); return; }
    const outName = `${baseName(folder)}-${target.fmt}`;
    const where = await vscode.window.showQuickPick([
      { label: `New folder ${outName}`, detail: 'Next to this folder, with the same structure. The originals stay as they are.', v: 'copy' },
      { label: target.fmt === 'json' ? 'Next to each file (.json)' : 'In place', detail: target.fmt === 'json' ? 'Writes name.json beside each plist; the plists stay.' : `Replaces each file. The originals are copied to ${baseName(folder)}-backup-<time> first.`, v: 'place' },
      { label: 'Dry run', detail: 'Only the report: what would change, with nothing written. Does not use a free try.', v: 'dry' },
    ], { placeHolder: `${files.length} plist file${files.length === 1 ? '' : 's'} found` });
    if (!where) return;
    const parent = vscode.Uri.joinPath(folder, '..');
    const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*$/, '').replace('T', '-');
    const backup = vscode.Uri.joinPath(parent, `${baseName(folder)}-backup-${stamp}`);
    const outDir = vscode.Uri.joinPath(parent, outName);
    const rows = [];
    const rel = (u) => path.posix.relative(folder.path, u.path);
    await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Converting to ${target.label}`, cancellable: true }, async (prog, token) => {
      for (let i = 0; i < files.length; i++) {
        if (token.isCancellationRequested) { rows.push({ file: '(stopped)', from: '', result: `stopped after ${i} files`, note: '' }); break; }
        const u = files[i];
        if (i % 20 === 0) prog.report({ message: `${i} of ${files.length}`, increment: 2000 / files.length });
        let r; let buf;
        try { buf = Buffer.from(await vscode.workspace.fs.readFile(u)); r = F.read(buf, baseName(u)); } catch (e) { rows.push({ file: rel(u), from: '?', result: 'skipped', note: `not readable: ${e.message}` }); continue; }
        if (r.format === 'profile') { rows.push({ file: rel(u), from: 'profile', result: 'skipped', note: 'signed profile' }); continue; }
        const loss = F.losses(r.root, target.fmt).join(' ');
        if (r.format === target.fmt && where.v !== 'copy') { rows.push({ file: rel(u), from: F.FORMAT_LABEL[r.format], result: 'already', note: '' }); continue; }
        const out = F.write(r.root, target.fmt, r.format === target.fmt ? r.style : {});
        let dest;
        if (where.v === 'copy') dest = vscode.Uri.joinPath(outDir, target.fmt === 'json' ? rel(u).replace(/\.[^./]+$/, '.json') : rel(u));
        else if (target.fmt === 'json') dest = u.with({ path: u.path.replace(/\.[^./]+$/, '.json') });
        else dest = u;
        if (where.v === 'dry') { rows.push({ file: rel(u), from: F.FORMAT_LABEL[r.format], result: 'would convert', note: loss, bytes: `${buf.length} -> ${out.length}` }); continue; }
        try {
          if (where.v === 'place' && target.fmt !== 'json') {
            const b = vscode.Uri.joinPath(backup, rel(u));
            await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(b, '..'));
            await vscode.workspace.fs.writeFile(b, buf);
          }
          await vscode.workspace.fs.createDirectory(vscode.Uri.joinPath(dest, '..'));
          await vscode.workspace.fs.writeFile(dest, out);
          rows.push({ file: rel(u), from: F.FORMAT_LABEL[r.format], result: 'converted', note: loss, bytes: `${buf.length} -> ${out.length}` });
        } catch (e) { rows.push({ file: rel(u), from: F.FORMAT_LABEL[r.format], result: 'failed', note: e.message }); }
      }
    });
    const n = (k) => rows.filter((x) => x.result === k).length;
    const cell = (s) => String(s || '').replace(/\|/g, '\\|');
    const md = [
      `# Plist batch convert to ${target.label}${where.v === 'dry' ? ' (dry run)' : ''}`, '',
      `- Folder: ${folder.fsPath || folder.toString()}`,
      `- Output: ${where.v === 'copy' ? outDir.fsPath : where.v === 'dry' ? 'nothing written' : target.fmt === 'json' ? 'a .json next to each plist' : `in place, originals in ${backup.fsPath}`}`,
      `- ${files.length} files: ${n('converted')} converted, ${n('would convert')} would convert, ${n('already')} already ${target.label}, ${n('skipped')} skipped, ${n('failed')} failed`, '',
      '| File | From | Result | Size (bytes) | Notes |', '|---|---|---|---|---|',
      ...rows.map((x) => `| ${cell(x.file)} | ${cell(x.from)} | ${cell(x.result)} | ${cell(x.bytes)} | ${cell(x.note)} |`),
    ].join('\n') + '\n';
    const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: md });
    await vscode.window.showTextDocument(doc, { preview: false });
    if (where.v !== 'dry') await pro.produced('convert');
  }

  // ---------- Pro: check ----------
  function indexPath(root, str) {
    if (!str || str === 'Root') return [];
    const out = [];
    let n = root;
    let s = str;
    while (s.length && n) {
      if (s[0] === '[') {
        const m = /^\[(\d+)\]\.?/.exec(s);
        if (!m || n.t !== 'array') break;
        out.push(Number(m[1]));
        n = n.v[Number(m[1])];
        s = s.slice(m[0].length);
        continue;
      }
      if (n.t !== 'dict') break;
      let best = -1; let bestLen = 0;
      n.v.forEach(([k], i) => { if (s.startsWith(k) && (s.length === k.length || s[k.length] === '.' || s[k.length] === '[') && k.length > bestLen) { best = i; bestLen = k.length; } });
      if (best < 0) break;
      out.push(best);
      n = n.v[best][1];
      s = s.slice(bestLen).replace(/^\./, '');
    }
    return out;
  }
  async function check(arg) {
    if (!(await pro.allowed('check', arg))) return;
    let uri = targetUri(arg);
    if (!uri) uri = await pickFile('Choose an Info.plist, entitlements file or provisioning profile');
    if (!uri) return;
    const run = async () => {
      const t = await readTree(uri);
      let profiles = [];
      if (C.kindOf(t.root, baseName(uri)) === 'info') {
        const found = await vscode.workspace.findFiles('**/*.{mobileprovision,provisionprofile}', '**/{node_modules,Pods,DerivedData}/**', 10).then(undefined, () => []);
        for (const f of found) { try { const r = F.read(Buffer.from(await vscode.workspace.fs.readFile(f)), baseName(f)); profiles.push({ name: baseName(f), root: r.root }); } catch (e) { /* not a profile */ } }
      }
      const report = C.check(t.root, baseName(uri), { X509: crypto.X509Certificate, profiles });
      const doc = provider.docFor(uri);
      const mapped = report.issues.map((x) => ({ level: x.level, message: x.message, path: indexPath(t.root, x.path) }));
      if (doc) provider.postIssues(doc, mapped);
      return { ...report, kind: 'check', reportKind: report.kind, title: `${report.title}: ${baseName(uri)}`, file: uri.fsPath || uri.toString(), mapped, root: t.root };
    };
    let data;
    try { data = await run(); } catch (e) { vscode.window.showErrorMessage(`${baseName(uri)} could not be read as a plist: ${e.message}`); return; }
    const p = openPanel('check', `Check ${baseName(uri)}`);
    p.onAction = async (id) => {
      if (id === 'rerun') { data = await run(); show(p, strip(data)); }
      if (id === 'saveMd') await saveMarkdown(C.markdown(data, baseName(uri)), `${baseName(uri).replace(/\.[^.]+$/, '')}-check.md`, uri);
    };
    p.onReveal = async (i) => {
      const x = data.mapped[i];
      if (!x) return;
      await vscode.commands.executeCommand('vscode.openWith', uri, viewType, { viewColumn: vscode.ViewColumn.One, preserveFocus: false });
      const doc = provider.docFor(uri);
      if (doc) { provider.postIssues(doc, data.mapped); setTimeout(() => provider.reveal(doc, x.path), 300); }
    };
    show(p, strip(data), () => pro.produced('check'));
  }
  const strip = (d) => { const { root, ...rest } = d; void root; return rest; };

  return { showXml, saveCopyAs, compare, batchConvert, check, indexPath };
}

module.exports = { createTools, PLIST_EXT };
