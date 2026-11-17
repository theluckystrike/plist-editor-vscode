'use strict';
// Webview HTML for the editor and the Pro result panels. No vscode import, so tests can check the CSP: no remote
// origin, no connect-src, scripts only with the page nonce.
const crypto = require('crypto');
const { footerHtml, FOOTER_CSS } = require('./support');

const PREFIX = 'plistEditor';
const attr = (s) => String(s).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function csp(cspSource, n) {
  return ["default-src 'none'", `style-src ${cspSource} 'nonce-${n}'`, `script-src 'nonce-${n}'`, `img-src ${cspSource} data:`, `font-src ${cspSource}`].join('; ');
}

/** p: { cspSource, scriptUri, styleUri, title, showSupportLinks, head?(nonce), canOpenText } */
function editorHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>
</head>
<body>
<div id="toolbar" role="toolbar" aria-label="Plist editor">
  <span id="fmt"></span>
  <input id="search" type="search" placeholder="Filter keys and values" aria-label="Filter keys and values">
  <span id="count" aria-live="polite"></span>
  <button class="tb" data-cmd="expand" title="Open every dictionary and array">Expand all</button>
  <button class="tb" data-cmd="collapse" title="Close every dictionary and array">Collapse all</button>
  <button class="tb" data-cmd="showXml" title="Show this plist as XML text next to the editor">Show XML</button>
  ${p.canOpenText ? '<button class="tb" data-cmd="openAsText" title="Open the file in the text editor">Open as Text</button>' : ''}
  <button class="tb" data-cmd="saveCopy" title="Save a copy as XML, binary or JSON">Save a Copy As...</button>
  <label class="chk" title="Show the readable name of known Info.plist keys"><input type="checkbox" id="names" checked> Key names</label>
</div>
<p id="note" hidden></p>
<div id="err" role="alert" hidden></div>
<div id="main">
  <div id="head"><div>Key</div><div>Type</div><div>Value</div><span id="resize" title="Drag to resize"></span></div>
  <div id="grid" tabindex="0" role="tree" aria-label="Plist"><div id="spacer"></div><div id="rows"></div></div>
</div>
<div id="failed" hidden><h2>This file could not be read as a plist</h2><p id="failmsg"></p><p><button class="btn tb" data-cmd="openAsText">Open as Text</button></p></div>
<div id="menu" role="menu" hidden></div>
<div id="footer"></div>
<template id="zovo-footer">${footer}</template>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

/** Result panel of a Pro tool. p: { cspSource, scriptUri, styleUri, title, head?(nonce), showSupportLinks } */
function panelHtml(p) {
  const n = p.nonce || crypto.randomBytes(18).toString('base64url');
  const footer = footerHtml(PREFIX, p.showSupportLinks !== false, '');
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp(p.cspSource, n)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${attr(p.styleUri)}">
${footer ? `<style nonce="${n}">${FOOTER_CSS}</style>` : ''}
${typeof p.head === 'function' ? p.head(n) : ''}
<title>${attr(p.title)}</title>
</head>
<body>
<div id="toolbar" role="toolbar"><strong id="title"></strong><span id="actions"></span></div>
<div id="app"><p class="muted">Working...</p></div>
<div id="footer">${footer}</div>
<script nonce="${n}" src="${attr(p.scriptUri)}"></script>
</body>
</html>`;
}

module.exports = { editorHtml, panelHtml, csp };
