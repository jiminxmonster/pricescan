const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { EmbeddedLayout } = require('../embedded-layout.cjs');

function fixture() {
  const children = []; const listeners = new Map();
  const window = {
    contentView: {
      addChildView: view => children.push(view),
      removeChildView: view => { const index = children.indexOf(view); if (index >= 0) children.splice(index, 1); },
    },
    on: (name, callback) => listeners.set(name, callback),
    removeListener: name => listeners.delete(name),
    getContentSize: () => [1200, 900],
    isMinimized: () => false,
    restore() {}, show() {}, focus() {},
    minimize: () => { window.minimized = true; },
  };
  const make = name => ({ name, setBounds: bounds => { make.bounds[name] = bounds; } });
  make.bounds = {};
  const entry = { controls: make('controls'), view: make('view'), visible: false };
  return { window, children, entry, bounds: make.bounds };
}

test('marketplace views are overlaid inside the existing PriceScan window', () => {
  const { window, children, entry, bounds } = fixture();
  const layout = new EmbeddedLayout(window);
  layout.show(entry);
  assert.deepEqual(children, [entry.controls, entry.view]);
  assert.deepEqual(bounds.controls, { x: 0, y: 0, width: 1200, height: 112 });
  assert.deepEqual(bounds.view, { x: 0, y: 112, width: 1200, height: 788 });
  layout.hide(entry);
  assert.deepEqual(children, []);
  assert.equal(entry.visible, false);
});

test('embedded controls can minimize the one main window', () => {
  const { window } = fixture();
  const layout = new EmbeddedLayout(window);
  layout.minimize();
  assert.equal(window.minimized, true);
});

test('scroll workspace keeps one marketplace large and swaps it without opening another window', () => {
  const { window, children } = fixture(); const bounds = {};
  const entries = ['naver', 'danawa'].map(source => ({ source, visible: false,
    controls: { setBounds: value => { bounds[`${source}-controls`] = value; } },
    view: { setBounds: value => { bounds[`${source}-view`] = value; } },
  }));
  const layout = new EmbeddedLayout(window);
  layout.show(entries[0]);
  assert.deepEqual(bounds['naver-view'], { x: 0, y: 112, width: 1200, height: 788 });
  layout.show(entries[1]);
  assert.equal(entries[0].visible, false);
  assert.equal(entries[1].visible, true);
  assert.deepEqual(children, [entries[1].controls, entries[1].view]);
  assert.deepEqual(bounds['danawa-view'], { x: 0, y: 112, width: 1200, height: 788 });
  layout.hide();
  assert.equal(children.length, 0);
});

test('browser driver never constructs a second BrowserWindow', () => {
  const source = fs.readFileSync(path.join(__dirname, '../browser-driver.cjs'), 'utf8');
  assert.doesNotMatch(source, /new\s+BrowserWindow\s*\(/);
  assert.doesNotMatch(source, /action:\s*['"]allow['"]/);
});

test('Naver lowest sort is applied through one visible native click before capture', () => {
  const source = fs.readFileSync(path.join(__dirname, '../browser-driver.cjs'), 'utf8');
  assert.match(source, /job\.sortMode === 'lowest'/);
  assert.match(source, /findVisibleNaverLowestSort/);
  assert.match(source, /clickVisibleTarget/);
  assert.match(source, /\['manual_scroll', 'manual_grid'\]\.includes\(job\.captureMode\)/);
  assert.match(source, /this\.interpret\(controls\.token, observation, controls\.signal\)/);
});
