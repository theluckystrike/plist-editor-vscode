'use strict';
// Plist Viewer & Editor by Zovo: binary, XML and OpenStep plists as an editable tree. No network, no telemetry.
// Activation shows nothing: no message, no popup. The editor opens only for files the user opens.
const vscode = require('vscode');
const { PlistEditorProvider, VIEW_TYPE } = require('./editor');
const { createTools } = require('./tools');
const { createPro } = require('./pro');
const { createRatingPrompt } = require('./rate');
const support = require('./support');
const { createReach } = require('./reach');
const reachConfig = require('./reach-config');

const PREFIX = 'plistEditor';
const EXT_ID = 'zovo.zovo-plist-editor';
const setting = (k, d) => vscode.workspace.getConfiguration(PREFIX).get(k, d);

function activate(context) {
  const sub = (d) => context.subscriptions.push(d);
  let rating = { success() {}, failure() {} };
  try { rating = createRatingPrompt({ vscode, context, extensionId: EXT_ID, section: PREFIX, name: 'Plist Editor' }); } catch (e) { /* rating is optional */ }
  support.registerSupport({ vscode, context, prefix: PREFIX, selfId: EXT_ID });
  const pro = createPro({ vscode, context });
  const reach = createReach({ vscode, ...reachConfig, maximum: pro.TRIAL_USES, context, licensed: () => !!pro.licensed, shown: () => setting('showProTools', true) !== false });
  reach.registerCtx();
  sub(pro.onDidChange(() => reach.refresh()));

  const provider = new PlistEditorProvider(context, {
    reach: () => reach,
    onSuccess: (doc) => rating.success(doc.uri),
    onFailure: () => rating.failure(),
  });
  sub(vscode.window.registerCustomEditorProvider(VIEW_TYPE, provider, { webviewOptions: { retainContextWhenHidden: true }, supportsMultipleEditorsPerDocument: false }));
  const tools = createTools({ context, provider, pro, reach, viewType: VIEW_TYPE });

  const reg = (id, fn) => sub(vscode.commands.registerCommand(id, fn));
  reg(`${PREFIX}.showXml`, (uri) => tools.showXml(uri));
  reg(`${PREFIX}.saveCopyAs`, (uri) => tools.saveCopyAs(uri));
  reg(`${PREFIX}.openWithEditor`, (uri) => {
    const u = uri && uri.scheme ? uri : (vscode.window.activeTextEditor && vscode.window.activeTextEditor.document.uri);
    if (!u) { vscode.window.showInformationMessage('Open or select a plist file first.'); return undefined; }
    return vscode.commands.executeCommand('vscode.openWith', u, VIEW_TYPE);
  });
  reg(`${PREFIX}.openAsText`, (uri) => {
    const u = uri && uri.scheme ? uri : provider.active && provider.active.uri;
    if (!u) return undefined;
    return vscode.commands.executeCommand('vscode.openWith', u, 'default');
  });
  reg(`${PREFIX}.find`, () => { const d = provider.active; if (d) for (const p of d.panels) p.webview.postMessage({ type: 'find' }); });
  reg(`${PREFIX}.openSample`, async () => {
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(context.extensionUri, 'samples', 'Info.plist'), VIEW_TYPE);
  });
  reg(`${PREFIX}.openBinarySample`, async () => {
    await vscode.commands.executeCommand('vscode.openWith', vscode.Uri.joinPath(context.extensionUri, 'samples', 'Settings-binary.plist'), VIEW_TYPE);
  });
  reg(`${PREFIX}.openWalkthrough`, () => vscode.commands.executeCommand('workbench.action.openWalkthrough', `${EXT_ID}#${PREFIX}.start`, false));
  reg(`${PREFIX}.compare`, reach.wrap((uri, uris) => tools.compare(uri && uri.scheme ? uri : undefined, uris)));
  reg(`${PREFIX}.batchConvert`, reach.wrap((uri) => tools.batchConvert(uri && uri.scheme ? uri : undefined)));
  reg(`${PREFIX}.check`, reach.wrap((uri) => tools.check(uri && uri.scheme ? uri : undefined)));
  sub(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration(`${PREFIX}.showProTools`)) reach.refresh(); }));
  sub(vscode.window.registerUriHandler({ handleUri: (uri) => pro.handleUri(uri) }));
  return { provider, tools, pro };
}

function deactivate() {}

module.exports = { activate, deactivate };
