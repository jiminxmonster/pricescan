const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { findVisibleLowestSort } = require('../security.cjs');

// Regression: production QA — a visible marketplace result list was paused when sort UI markup changed.
// Found by /qa on 2026-09-15
// Report: .gstack/qa-reports/qa-report-pricescan-d2blue-com-2026-09-15.md
test('Danawa list-item sort controls resolve to their visible child link', () => {
  const link = {
    innerText: '낮은가격순', className: '', getAttribute: () => null,
    matches: selector => selector.includes('a'),
    getBoundingClientRect: () => ({ left: 410, top: 100, right: 530, bottom: 140, width: 120, height: 40 }),
  };
  const item = {
    innerText: '낮은가격순', className: 'order_item', getAttribute: name => name === 'data-sort-method' ? 'priceASC' : null,
    matches: () => false, querySelector: () => link,
    getBoundingClientRect: link.getBoundingClientRect,
  };
  const document = { querySelectorAll: selector => selector === '*' ? [item] : (selector === 'li' || selector === '[data-sort-method]' ? [item] : []) };
  const result = vm.runInNewContext(`(${findVisibleLowestSort.toString()})('danawa')`, {
    URL, location: { href: 'https://search.danawa.com/dsearch.php?query=ssd' }, document,
    innerWidth: 1200, innerHeight: 800,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  });
  assert.deepEqual({ ...result }, { selected: false, x: 470, y: 120, width: 120, height: 40 });
});

test('AI mode recovers Naver to its shopping landing page and does not block on changed sort UI', () => {
  const source = fs.readFileSync(path.join(__dirname, '../browser-driver.cjs'), 'utf8');
  assert.match(source, /currentUrl\.hostname !== 'shopping\.naver\.com'/);
  assert.match(source, /void entry\.view\.webContents\.loadURL\(landingUrl\)/);
  assert.match(source, /job\.captureMode === 'ai_supervised'/);
  assert.match(source, /AI가 화면에서 확인한 후보를 총액순으로 정리합니다/);
});
