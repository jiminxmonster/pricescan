const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function load(bodyText, anchors) {
  const body = { innerText: bodyText, querySelectorAll: () => anchors };
  const context = {
    URL,
    location: { href: 'https://search.danawa.com/dsearch.php?query=ssd' },
    document: {
      title: 'SSD 검색',
      body,
      querySelector: () => null,
    },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/agent-observer.js`, 'utf8'), context);
  return context.PriceScanAgentObserver.observe();
}

test('generic observer reads only bounded visible text and public links', () => {
  const anchor = {
    href: 'https://search.danawa.com/product/1', innerText: '삼성 SSD 2TB', title: '',
    getAttribute: () => '', getBoundingClientRect: () => ({ width: 100, height: 20 }),
  };
  const result = load(`상품 결과 ${'x'.repeat(15000)}`, [anchor]);
  assert.equal(result.visible_text.length, 14000);
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].url, anchor.href);
  assert.equal('cookies' in result, false);
  assert.equal('form_values' in result, false);
});

test('generic observer prefers the page main content over account and navigation chrome', () => {
  const contentAnchor = {
    href: 'https://search.danawa.com/product/2', innerText: '상품 링크', title: '',
    getAttribute: () => '', getBoundingClientRect: () => ({ width: 100, height: 20 }),
  };
  const body = {
    innerText: '로그인 사용자 이름 상품 결과',
    querySelectorAll: () => [],
  };
  const main = {
    innerText: '상품 결과 199,000원',
    querySelectorAll: () => [contentAnchor],
  };
  const context = {
    URL,
    location: { href: 'https://search.danawa.com/dsearch.php?query=ssd' },
    document: {
      title: 'SSD 검색',
      body,
      querySelector: () => main,
    },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/agent-observer.js`, 'utf8'), context);
  const result = context.PriceScanAgentObserver.observe();
  assert.equal(result.visible_text, main.innerText);
  assert.equal(result.links.length, 1);
});

test('generic observer locally detects CAPTCHA without attempting to solve it', () => {
  const result = load('보안 확인을 완료해 주세요. 로봇이 아닙니다.', []);
  assert.equal(result.local_blocked, true);
});
