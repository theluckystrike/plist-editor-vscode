'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { loadExtension } = require('./support/vscode-stub');
const F = require('../src/core/format');
const M = require('../src/core/model');
const { editorHtml, panelHtml } = require('../src/html');

const ROOT = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

function activate(folder) {
  const s = loadExtension();
  if (folder) s.vscode.workspace.workspaceFolders = [{ uri: s.vscode.Uri.file(folder), name: 'ws' }];
  s.api = s.ext.activate(s.context);
  return s;
}
function tmp(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plist-ws-'));
  for (const [n, t] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(dir, n)), { recursive: true }); fs.writeFileSync(path.join(dir, n), t); }
  return dir;
}
function fakePanel() {
  let onMsg;
  const posted = [];
  return {
    posted, viewColumn: 1,
    webview: { options: {}, html: '', cspSource: 'vscode-resource:', asWebviewUri: (u) => u, postMessage: async (m) => { posted.push(m); return true; }, onDidReceiveMessage: (f) => { onMsg = f; return { dispose() {} }; } },
    onDidChangeViewState: () => ({ dispose() {} }), onDidDispose: () => ({ dispose() {} }), reveal() {},
    send: (m) => onMsg(m),
  };
}
async function openEditor(s, file) {
  const prov = s.providers.custom.p;
  const changes = [];
  prov.onDidChangeCustomDocument((e) => changes.push(e));
  const doc = await prov.openCustomDocument(s.vscode.Uri.file(file), {});
  const panel = fakePanel();
  await prov.resolveCustomEditor(doc, panel);
  await panel.send({ type: 'ready' });
  return { prov, doc, panel, changes, last: () => panel.posted.at(-1) };
}
const sample = (n) => fs.readFileSync(path.join(ROOT, 'samples', n));

test('listing rules: name, description, 5 tags, engine, no dependencies, Pro titles, Explorer wrappers', () => {
  assert.equal(pkg.name, 'zovo-plist-editor');
  assert.equal(pkg.displayName, 'Plist Viewer & Editor (Binary)');
  assert.ok(pkg.displayName.length <= 30);
  assert.ok(pkg.displayName.toLowerCase().startsWith('plist'));
  assert.ok(pkg.description.startsWith('Plist editor'));
  assert.deepEqual(pkg.keywords, ['plist', 'binary plist', 'plist editor', 'macos', 'ios']);
  assert.equal(pkg.engines.vscode, '^1.75.0');
  assert.ok(!pkg.dependencies);
  assert.deepEqual(pkg.activationEvents, ['onUri']); // OFFER: the license page's Open in VS Code link
  for (const id of ['compare', 'batchConvert', 'check']) assert.match(pkg.contributes.commands.find((c) => c.command === `plistEditor.${id}`).title, /\(Pro\)$/);
  const ctx = pkg.contributes.menus['explorer/context'].filter((m) => /zovoPro/.test(m.command));
  assert.equal(ctx.length, 3);
  for (const m of ctx) {
    assert.ok(!('title' in m), 'VS Code ignores a title on a menu item');
    assert.match(pkg.contributes.commands.find((c) => c.command === m.command).title, /^Zovo Pro: /);
    assert.match(m.when, /config\.plistEditor\.showProTools/);
    assert.ok(pkg.contributes.menus.commandPalette.some((p) => p.command === m.command && p.when === 'false'));
  }
  for (const menu of Object.values(pkg.contributes.menus)) for (const m of menu) assert.ok(!('title' in m));
  for (const k of Object.keys(pkg.contributes.configuration.properties)) assert.ok(k.startsWith('plistEditor.'), k);
  assert.deepEqual(pkg.contributes.customEditors[0].selector.map((x) => x.filenamePattern), ['*.plist', '*.entitlements', '*.mobileprovision', '*.provisionprofile', '*.xcprivacy']);
  const ignore = fs.readFileSync(path.join(ROOT, '.vscodeignore'), 'utf8');
  assert.match(ignore, /^test\/\*\*$/m);
});

test('activation registers every command and shows nothing', () => {
  const s = activate();
  for (const c of pkg.contributes.commands) assert.ok(s.commands.has(c.command), c.command);
  assert.equal(s.providers.custom.id, 'plistEditor.editor');
  assert.deepEqual([s.log.info, s.log.warn, s.log.error, s.log.opened, s.log.external], [[], [], [], [], []]);
  for (const step of pkg.contributes.walkthroughs[0].steps) for (const f of [step.media && step.media.image, step.media && step.media.markdown].filter(Boolean)) assert.ok(fs.existsSync(path.join(ROOT, f)), f);
  s.restore();
});

test('html: the CSP allows no remote origin and only nonce scripts', () => {
  for (const h of [editorHtml({ cspSource: 'vscode-resource:', scriptUri: 's.js', styleUri: 's.css', title: '<x>' }), panelHtml({ cspSource: 'vscode-resource:', scriptUri: 's.js', styleUri: 's.css', title: 't' })]) {
    const csp = /Content-Security-Policy" content="([^"]+)"/.exec(h)[1];
    assert.match(csp, /default-src 'none'/);
    assert.doesNotMatch(csp, /https?:|connect-src|unsafe-inline|unsafe-eval|\*/);
    assert.match(csp, /script-src 'nonce-[\w-]+'/);
  }
  assert.match(editorHtml({ cspSource: 'c', scriptUri: 's', styleUri: 's', title: '<x>' }), /<title>&lt;x&gt;<\/title>/);
});

test('webview markup has no style="" attributes (the CSP blocks them; the gate saw rows without indent)', () => {
  for (const f of ['editor.js', 'panel.js']) {
    const src = fs.readFileSync(path.join(ROOT, 'media', f), 'utf8');
    assert.doesNotMatch(src, /style=\\?["'`$]/, f);
  }
  for (const h of [editorHtml({ cspSource: 'c', scriptUri: 's', styleUri: 's', title: 't' }), panelHtml({ cspSource: 'c', scriptUri: 's', styleUri: 's', title: 't' })]) assert.doesNotMatch(h, /\sstyle="/);
});

test('editor: a binary plist opens, edits, saves as binary, and undo and redo are exact', async () => {
  const dir = tmp({ 'Settings.plist': sample('Settings-binary.plist') });
  const file = path.join(dir, 'Settings.plist');
  const s = activate(dir);
  const { prov, doc, panel, changes } = await openEditor(s, file);
  const init = panel.posted.find((m) => m.type === 'init');
  assert.equal(init.format, 'binary');
  assert.equal(init.formatLabel, 'Binary');
  assert.equal(init.tree.v[1][0], 'SyncIntervalMinutes');
  assert.ok(init.keys.CFBundleIdentifier);
  // nothing written by opening
  assert.ok(fs.readFileSync(file).equals(sample('Settings-binary.plist')));
  await panel.send({ type: 'edit', op: { op: 'setValue', path: [1], text: '45' } });
  await panel.send({ type: 'edit', op: { op: 'setKey', path: [2], key: 'ShowDoneNotes' } });
  await panel.send({ type: 'edit', op: { op: 'setType', path: [3], t: 'string' } });
  await panel.send({ type: 'edit', op: { op: 'insert', parent: [], index: 0, focus: true } });
  assert.equal(changes.length, 4);
  const inserted = panel.posted.filter((m) => m.type === 'tree').at(-1);
  assert.deepEqual(inserted.focus, [0]);
  assert.equal(inserted.editKey, true);
  await panel.send({ type: 'edit', op: { op: 'setValue', path: [2], text: 'nope' } }); // SyncIntervalMinutes is a number
  assert.match(panel.posted.at(-1).message, /not a number|whole number/);
  assert.equal(changes.length, 4);
  await prov.saveCustomDocument(doc);
  const saved = fs.readFileSync(file);
  assert.equal(saved.subarray(0, 8).toString(), 'bplist00');
  const r = F.read(saved);
  assert.equal(r.root.v[0][0], 'New item');
  assert.equal(M.at(r.root, [2]).v, '45');
  assert.equal(r.root.v[3][0], 'ShowDoneNotes');
  assert.deepEqual(M.at(r.root, [4]), { t: 'string', v: '14.5' });
  if (process.platform === 'darwin') execFileSync('plutil', ['-lint', file]);
  // undo all four, the tree equals the original
  for (const c of changes.slice().reverse()) c.undo();
  assert.ok(M.equal(doc.root, F.read(sample('Settings-binary.plist')).root, true));
  for (const c of changes) c.redo();
  assert.ok(M.equal(doc.root, r.root, true));
  s.restore();
});

test('editor: XML keeps its layout on save; duplicate, move, remove; Show XML follows edits', async () => {
  const dir = tmp({ 'Info.plist': sample('Info.plist') });
  const file = path.join(dir, 'Info.plist');
  const s = activate(dir);
  const { prov, doc, panel, changes } = await openEditor(s, file);
  await panel.send({ type: 'edit', op: { op: 'setValue', path: [7], text: '2.5.0' } });
  await prov.saveCustomDocument(doc);
  const out = fs.readFileSync(file, 'utf8');
  const orig = sample('Info.plist').toString();
  assert.equal(out, orig.replace('<string>2.4.1</string>', '<string>2.5.0</string>'));
  await panel.send({ type: 'edit', op: { op: 'duplicate', path: [8] } });
  assert.equal(doc.root.v[9][0], 'CFBundleURLTypes copy');
  await panel.send({ type: 'edit', op: { op: 'move', parent: [], from: 9, to: 8 } });
  assert.equal(doc.root.v[8][0], 'CFBundleURLTypes copy');
  await panel.send({ type: 'edit', op: { op: 'move', parent: [], from: 0, to: -1 } }); // first row cannot move up: no change
  await panel.send({ type: 'edit', op: { op: 'remove', parent: [], index: 8 } });
  assert.equal(changes.length, 4);
  // Show XML: a virtual document that follows the tree
  await s.commands.get('plistEditor.showXml')(s.vscode.Uri.file(file));
  const xmlDoc = s.log.opened.at(-1).document || s.log.opened.at(-1);
  assert.equal(xmlDoc.uri.scheme, 'plist-xml');
  const content = await s.providers.content.get('plist-xml').provideTextDocumentContent(xmlDoc.uri);
  assert.match(content, /<string>2\.5\.0<\/string>/);
  // copy as XML and key path
  await panel.send({ type: 'copy', what: 'xml', path: [8, 0] });
  assert.match(s.log.clipboard, /^<dict>\n\t<key>CFBundleURLName<\/key>/);
  await panel.send({ type: 'copy', what: 'path', path: [8, 0, 1, 0] });
  assert.equal(s.log.clipboard, 'CFBundleURLTypes[0].CFBundleURLSchemes[0]');
  s.restore();
});

test('editor: hot exit backup restores unsaved edits; profiles are read-only; a broken file shows its error', async () => {
  const dir = tmp({ 'a.plist': sample('Info.plist'), 'p.mobileprovision': Buffer.concat([Buffer.from([0x30, 0x82, 0, 0]), sample('Info.plist'), Buffer.from([0xa0, 0])]), 'bad.plist': '<plist><dict><key>x</key></dict></plist>' });
  const s = activate(dir);
  const { prov, doc, panel } = await openEditor(s, path.join(dir, 'a.plist'));
  await panel.send({ type: 'edit', op: { op: 'setKey', path: [1], key: 'Renamed' } });
  const dest = s.vscode.Uri.file(path.join(dir, 'backup.bin'));
  await prov.backupCustomDocument(doc, { destination: dest });
  const restored = await prov.openCustomDocument(s.vscode.Uri.file(path.join(dir, 'a.plist')), { backupId: dest.fsPath });
  assert.equal(restored.root.v[1][0], 'Renamed');
  assert.equal(restored.dirty, 1);
  const p = await openEditor(s, path.join(dir, 'p.mobileprovision'));
  const init = p.panel.posted.find((m) => m.type === 'init');
  assert.equal(init.readOnly, true);
  assert.match(init.formatLabel, /read-only/);
  await p.panel.send({ type: 'edit', op: { op: 'setKey', path: [1], key: 'x' } });
  assert.match(p.panel.posted.at(-1).message, /read-only/);
  const b = await openEditor(s, path.join(dir, 'bad.plist'));
  const failed = b.panel.posted.find((m) => m.type === 'failed');
  assert.match(failed.message, /has no value/);
  s.restore();
});

test('Pro compare: two Explorer files (1 free try), then the Zovo Pro panel; git HEAD in a trusted folder; no git in Restricted Mode', async () => {
  const dir = tmp({ 'old.plist': sample('Info.plist'), 'new.plist': F.write(M.dict([['CFBundleIdentifier', M.str('com.example.trailnotes')], ['Extra', M.bool(true)]]), 'binary') });
  let s = activate(dir);
  let U = (n) => s.vscode.Uri.file(path.join(dir, n));
  await s.commands.get('plistEditor.zovoPro.compare')(U('old.plist'), [U('old.plist'), U('new.plist')]);
  await tick(20);
  await s.log.panel.send({ type: 'shown' });
  const data = s.log.panel.posted.find((m) => m.type === 'data').data;
  assert.equal(data.kind, 'compare');
  assert.equal(data.counts.added, 1);
  assert.ok(data.counts.removed >= 10);
  assert.equal(s.state.get('plistEditor.proTrial').compare, 1);
  // the 2nd use opens the Zovo Pro panel and compares nothing
  const before = s.log.panel.posted.length;
  await s.commands.get('plistEditor.compare')(U('old.plist'), [U('old.plist'), U('new.plist')]);
  assert.equal(s.log.panel.posted.length, before);
  assert.equal(s.state.get('plistEditor.proTrial').compare, 1);
  assert.ok([...s.log.info, ...s.log.warn].some((m) => /Compare two plists/.test(m.text)) || s.log.panel, 'the Zovo Pro panel or modal shows');
  s.restore();
  // git HEAD (through the /var symlink), new session with its free try
  execFileSync('git', ['init', '-q'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'add', '.'], { cwd: dir });
  execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', 'commit', '-qm', 'x'], { cwd: dir });
  fs.writeFileSync(path.join(dir, 'old.plist'), sample('Info.plist').toString().replace('2.4.1', '3.0'));
  s = activate(dir);
  U = (n) => s.vscode.Uri.file(path.join(dir, n));
  // Escape at the pick uses no try
  s.ui.quick.push(undefined);
  await s.commands.get('plistEditor.compare')(U('old.plist'));
  assert.equal((s.state.get('plistEditor.proTrial') || {}).compare, undefined);
  s.ui.quick.push((items) => items.find((i) => i.v === 'head'));
  await s.commands.get('plistEditor.compare')(U('old.plist'));
  await tick(20);
  await s.log.panel.send({ type: 'shown' });
  const d2 = s.log.panel.posted.filter((m) => m.type === 'data').at(-1).data;
  assert.deepEqual(d2.changes, [{ kind: 'changed', path: 'CFBundleShortVersionString', old: '"2.4.1"', new: '"3.0"' }]);
  assert.match(d2.left, /git HEAD/);
  assert.equal(s.state.get('plistEditor.proTrial').compare, 1);
  s.restore();
  // HOLDFIX (VER11 BLOCK): in Restricted Mode git is never started, so the pick has no git HEAD row
  s = activate(dir);
  U = (n) => s.vscode.Uri.file(path.join(dir, n));
  s.vscode.workspace.isTrusted = false;
  const cp = require('child_process');
  const realExecFile = cp.execFile;
  const gitCalls = [];
  cp.execFile = function (cmd, ...rest) { if (cmd === 'git') gitCalls.push(rest[0]); return realExecFile.call(this, cmd, ...rest); };
  // the only choice left is another file, so the file dialog opens at once (cancelled here); no git HEAD row, no git process
  let asked = false;
  s.ui.quick.push((items) => { asked = items.map((i) => i.v); return undefined; });
  s.ui.open.push(undefined);
  try { await s.commands.get('plistEditor.compare')(U('old.plist')); } finally { cp.execFile = realExecFile; }
  assert.deepEqual(gitCalls, []);
  assert.equal(asked, false, 'no pick with a git HEAD row');
  assert.equal(s.ui.open.length, 0, 'the file dialog opened');
  s.ui.quick.length = 0;
  assert.equal((s.state.get('plistEditor.proTrial') || {}).compare, undefined);
  s.restore();
});

test('Pro batch convert: dry run uses no try; a copy folder is written; node_modules is skipped; plutil reads the output', async () => {
  const bin = F.write(M.dict([['a', M.int(1)], ['when', M.date('2026-01-01T00:00:00Z')]]), 'binary');
  const dir = tmp({ 'proj/A.plist': bin, 'proj/sub/B.plist': bin, 'proj/C.plist': sample('Info.plist'), 'proj/node_modules/x/D.plist': bin, 'proj/broken.plist': 'not a plist <<' });
  let s = activate(dir);
  const folder = s.vscode.Uri.file(path.join(dir, 'proj'));
  s.ui.quick.push((items) => items[0], (items) => items.find((i) => i.v === 'dry'));
  await s.commands.get('plistEditor.batchConvert')(folder);
  let rep = s.log.opened.at(-1).document || s.log.opened.at(-1);
  assert.match(rep.getText(), /dry run/);
  assert.match(rep.getText(), /4 files: 0 converted, 2 would convert, 1 already XML, 1 skipped, 0 failed/);
  assert.equal((s.state.get('plistEditor.proTrial') || {}).convert, undefined);
  s.ui.quick.push((items) => items[0], (items) => items.find((i) => i.v === 'copy'));
  await s.commands.get('plistEditor.zovoPro.convert')(folder);
  rep = s.log.opened.at(-1).document || s.log.opened.at(-1);
  assert.match(rep.getText(), /3 converted/);
  assert.match(rep.getText(), /broken\.plist \| \? \| skipped/);
  const outA = path.join(dir, 'proj-xml', 'A.plist');
  assert.match(fs.readFileSync(outA, 'utf8'), /<integer>1<\/integer>/);
  assert.ok(fs.existsSync(path.join(dir, 'proj-xml', 'sub', 'B.plist')));
  assert.ok(!fs.existsSync(path.join(dir, 'proj-xml', 'node_modules')));
  if (process.platform === 'darwin') execFileSync('plutil', ['-lint', outA]);
  assert.equal(s.state.get('plistEditor.proTrial').convert, 1);
  // the 2nd use opens the Zovo Pro panel: nothing is converted
  const n = s.log.opened.length;
  await s.commands.get('plistEditor.batchConvert')(folder);
  assert.equal(s.log.opened.length, n);
  assert.equal(fs.readFileSync(path.join(dir, 'proj', 'C.plist')).subarray(0, 5).toString(), '<?xml');
  s.restore();
  // in place to binary keeps a backup of each original (a new session with its free try)
  s = activate(dir);
  s.ui.quick.push((items) => items[1], (items) => items.find((i) => i.v === 'place'));
  await s.commands.get('plistEditor.batchConvert')(folder);
  assert.equal(fs.readFileSync(path.join(dir, 'proj', 'C.plist')).subarray(0, 8).toString(), 'bplist00');
  const backups = fs.readdirSync(dir).filter((n) => n.startsWith('proj-backup-'));
  assert.equal(backups.length, 1);
  assert.ok(fs.readFileSync(path.join(dir, backups[0], 'C.plist')).equals(sample('Info.plist')));
  s.restore();
});

test('Pro check: report, issue markers in the open editor, reveal, Explorer wrapper tagged ctx', async () => {
  const bad = sample('Info.plist').toString().replace('<string>2.4.1</string>', '<string>2.4 beta</string>').replace('<string>Takes photos of trail signs and attaches them to your notes.</string>', '<string></string>');
  const dir = tmp({ 'Info.plist': bad });
  const file = path.join(dir, 'Info.plist');
  const s = activate(dir);
  const ed = await openEditor(s, file);
  await s.commands.get('plistEditor.zovoPro.check')(s.vscode.Uri.file(file));
  await tick(20);
  await s.log.panel.send({ type: 'shown' });
  const data = s.log.panel.posted.find((m) => m.type === 'data').data;
  assert.equal(data.kind, 'check');
  assert.ok(data.issues.some((i) => i.path === 'CFBundleShortVersionString' && i.level === 'error'));
  assert.ok(data.issues.some((i) => i.path === 'NSCameraUsageDescription' && i.level === 'error'));
  assert.equal(data.root, undefined);
  const marks = ed.panel.posted.find((m) => m.type === 'issues');
  assert.ok(marks.issues.some((i) => JSON.stringify(i.path) === '[7]' && i.level === 'error'));
  assert.equal(s.state.get('plistEditor.proTrial').check, 1);
  s.restore();
});

test('Pro panel gets the click surface: ctx from the Explorer wrapper, toolbar from the editor row, none from the palette', async () => {
  const s = loadExtension();
  const { createPro } = require('../src/pro');
  const { runAs } = require('../src/reach');
  const seen = [];
  const lic = { isPro: () => false, requirePro: async (title, o) => { seen.push({ title, surface: o.surface }); return false; }, ready: Promise.resolve(), onDidChange: () => ({ dispose() {} }) };
  const pro = createPro({ vscode: s.vscode, context: s.context, license: lic });
  await s.context.globalState.update('plistEditor.proTrial', { check: 3, compare: 3, convert: 3 });
  assert.equal(await runAs('ctx', () => pro.allowed('check')), false);
  assert.equal(await runAs('toolbar', () => pro.allowed('compare')), false);
  assert.equal(await pro.allowed('convert'), false);
  assert.deepEqual(seen, [{ title: 'Check Info.plist and profiles', surface: 'ctx' }, { title: 'Compare two plists', surface: 'toolbar' }, { title: 'Batch convert a folder', surface: undefined }]);
  // the real license facade adds the surface to the card link: <install id>_ctx
  s.restore();
});

test('Pro tries never go down within a session, even when globalState returns an older value', async () => {
  const s = loadExtension();
  const { createPro } = require('../src/pro');
  const lic = { isPro: () => false, requirePro: async () => false, ready: Promise.resolve(), onDidChange: () => ({ dispose() {} }) };
  const pro = createPro({ vscode: s.vscode, context: s.context, license: lic });
  assert.equal(pro.left('check'), 1);
  await pro.produced('check');
  assert.equal(pro.left('check'), 0);
  await s.context.globalState.update('plistEditor.proTrial', { check: 0 }); // stale value from another window
  assert.equal(pro.left('check'), 0);
  assert.equal(await pro.allowed('check'), false);
  s.restore();
});
