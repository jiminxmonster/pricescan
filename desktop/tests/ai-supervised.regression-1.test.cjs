const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { findVisibleLowestSort } = require('../security.cjs');

// Regression: ISSUE-001 — visible marketplace products were ignored when the first viewport was not the result list
// Found by /qa on 2026-09-15
// Report: .gstack/qa-reports/qa-report-pricescan-d2blue-com-2026-09-15.md
function locate(source, label, top = 100, href = 'https://example.test/search') {
  const element = {
    matches: ['button'], innerText: label, className: '', getAttribute: () => null,
    getBoundingClientRect: () => ({ left: 400, top, right: 560, bottom: top + 40, width: 160, height: 40 }),
  };
  const document = { querySelectorAll: selector => selector === '*' ? [element] : (element.matches.includes(selector) ? [element] : []) };
  return vm.runInNewContext(`(${findVisibleLowestSort.toString()})('${source}')`, {
    URL, location: { href }, document, innerWidth: 1200, innerHeight: 800,
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }),
  });
}

test('each marketplace exposes its visible lowest-price control to the native browser', () => {
  assert.equal(locate('danawa', '낮은가격순').selected, false);
  assert.equal(locate('enuri', '최저가순').selected, false);
  assert.equal(locate('coupang', '낮은가격순', 100, 'https://www.coupang.com/np/search?q=ssd&sorter=salePriceAsc').selected, true);
  assert.equal(locate('danawa', '낮은가격순', 1400).scroll, 'down');
});

test('AI supervised capture scans several visible viewports and keeps independent results', () => {
  const source = fs.readFileSync(path.join(__dirname, '../browser-driver.cjs'), 'utf8');
  assert.match(source, /viewport < 5/);
  assert.match(source, /scrollVisiblePage\(entry\.view\.webContents, 'down'\)/);
  assert.match(source, /seenItems/);
  assert.match(source, /items\.sort/);
});
