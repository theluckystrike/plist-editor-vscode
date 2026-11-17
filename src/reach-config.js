'use strict';
// REACH1: this listing's Pro tools for the editor toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  prefix: 'plistEditor',
  triesKey: 'plistEditor.proTrial',
  slot: '#toolbar',
  tools: [
    { id: 'compare', title: 'Compare two plists', command: 'plistEditor.compare' },
    { id: 'convert', title: 'Batch convert a folder', command: 'plistEditor.batchConvert' },
    { id: 'check', title: 'Check Info.plist and profiles', command: 'plistEditor.check' },
  ],
};
