const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { isShopUrl, isAppUrl, normalizeAppUrl, findVisibleSearchInput, findVisibleNaverLowestSort, inspectShoppingPage, validateStart } = require('../security.cjs');
const { clickVisibleTarget, submitVisibleSearch } = require('../native-search.cjs');
const { captureVisibleShoppingProducts } = require('../parser.cjs');
const { captureVisibleObservation, decideNaverSort } = require('../browser-driver.cjs');
test('shopping navigation is HTTPS and exact-domain scoped', () => {
  for (const url of ['javascript:alert(1)', 'file:///etc/passwd', 'http://naver.com', 'https://naver.com.attacker.test', 'https://user:pass@naver.com', 'https://localhost:8400', 'https://naver.com:8443']) assert.equal(isShopUrl('naver', url), false, url);
  assert.equal(isShopUrl('naver', 'https://nid.naver.com/nidlogin.login'), true);
  assert.equal(isShopUrl('naver', 'https://search.shopping.naver.com/search/all?query=a'), true);
  assert.equal(isShopUrl('naver', 'https://www.coupang.com'), false);
});
test('only the fixed local PriceScan origin has a desktop bridge', () => {
  assert.equal(isAppUrl('http://127.0.0.1:8300/pricescan/'), true);
  for (const value of ['https://naver.com', 'http://127.0.0.1:9999/pricescan/', 'http://127.0.0.1:8300/elsewhere', 'http://attacker.test/pricescan/']) assert.equal(isAppUrl(value), false);
});
test('the desktop shell accepts an explicit HTTPS deployment URL but rejects unsafe app URLs', () => {
  assert.equal(normalizeAppUrl('https://pricescan.d2blue.com/pricescan'), 'https://pricescan.d2blue.com/pricescan/');
  assert.equal(normalizeAppUrl('http://localhost:8300/pricescan/'), 'http://localhost:8300/pricescan/');
  for (const value of ['http://pricescan.d2blue.com/pricescan/', 'file:///tmp/pricescan/', 'https://user:pass@pricescan.d2blue.com/pricescan/']) {
    assert.throws(() => normalizeAppUrl(value));
  }
});
function inspect({ host = 'search.shopping.naver.com', path = '/search/all', text = '', query = '노트북', captcha = false, visible = true } = {}) {
  return vm.runInNewContext(`(${inspectShoppingPage.toString()})('naver', '노트북')`, {
    URL, location: { hostname: host, href: `https://${host}${path}?query=${encodeURIComponent(query)}` },
    document: { body: { innerText: text }, readyState: 'complete', querySelectorAll: () => captcha ? [{ getClientRects: () => visible ? [{}] : [] }] : [] },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block' }),
  }).state;
}
test('Naver login and visible CAPTCHA are human handoffs, not bypasses', () => {
  assert.equal(inspect({ host: 'nid.naver.com' }), 'needs_login');
  assert.equal(inspect({ captcha: true }), 'needs_verification');
  assert.equal(inspect({ text: '자동입력 방지 문자를 입력하세요' }), 'needs_verification');
  assert.equal(inspect({ captcha: true, visible: false }), 'ready');
});
test('access denial stays blocked and a changed query cannot be silently captured', () => {
  assert.equal(inspect({ text: 'Access Denied' }), 'blocked');
  assert.equal(inspect({ text: '쇼핑 서비스 이용이 제한되었습니다.' }), 'blocked');
  assert.equal(inspect({ query: '다른 상품' }), 'needs_page');
  assert.equal(inspect(), 'ready');
  assert.equal(inspect({ path: '/ns/search' }), 'ready');
});
test('start input cannot carry arbitrary URLs or shell commands into stored jobs', () => {
  const input = validateStart({ query: '노트북', productId: 'product-1', token: 'secret', sources: ['naver'], apiBaseUrl: 'https://evil.test', command: 'shell', cookies: 'secret' });
  assert.equal(input.apiBaseUrl, undefined); assert.equal(input.command, undefined); assert.equal(input.token, undefined); assert.equal(input.cookies, undefined);
});
test('manual scroll collection is an explicit validated mode with legacy grid compatibility', () => {
  const ai = validateStart({ query: '노트북', productId: 'p1', mergeRunId: 'ai_123', token: 'secret', sources: ['naver'], captureMode: 'ai_supervised' });
  assert.equal(ai.captureMode, 'ai_supervised');
  assert.equal(ai.mergeRunId, 'ai_123');
  assert.throws(() => validateStart({ query: '노트북', productId: 'p1', token: 'secret', sources: ['naver'], captureMode: 'ai_supervised' }), /AI 검색 실행/);
  assert.equal(validateStart({ query: '노트북', productId: 'p1', token: 'secret', sources: ['naver'], captureMode: 'manual_scroll' }).captureMode, 'manual_scroll');
  assert.equal(validateStart({ query: '노트북', productId: 'p1', token: 'secret', sources: ['naver'], captureMode: 'manual_grid' }).captureMode, 'manual_grid');
  assert.equal(validateStart({ query: '노트북', productId: 'p1', token: 'secret', sources: ['naver'], captureMode: 'other' }).captureMode, 'automatic');
});
function locate(inputs) {
  const all = inputs || [];
  const document = { querySelectorAll: selector => selector === '*' ? all : all.filter(item => item.matches?.includes(selector)) };
  return vm.runInNewContext(`(${findVisibleSearchInput.toString()})()`, {
    document, innerWidth: 1200, innerHeight: 800,
    getComputedStyle: item => item.style || { visibility: 'visible', display: 'block', opacity: '1' },
  });
}
test('visible search locator returns geometry only and skips unusable fields', () => {
  const hidden = { matches: ["input[name='query']"], disabled: true, getBoundingClientRect: () => ({ left: 10, top: 10, right: 210, bottom: 50, width: 200, height: 40 }) };
  const visible = { matches: ["input[type='search']"], getBoundingClientRect: () => ({ left: 100, top: 50, right: 500, bottom: 90, width: 400, height: 40 }) };
  assert.deepEqual({ ...locate([hidden, visible]) }, { x: 300, y: 70, width: 400, height: 40 });
  assert.equal(locate([{ matches: ["input[type='search']"], readOnly: true, getBoundingClientRect: visible.getBoundingClientRect }]), null);
});
function locateLowestSort(elements, href = 'https://search.shopping.naver.com/search/all?query=test') {
  const all = elements || [];
  const document = { querySelectorAll: selector => selector === '*' ? all : all.filter(item => item.matches?.includes(selector)) };
  return vm.runInNewContext(`(${findVisibleNaverLowestSort.toString()})()`, {
    URL, location: { href }, document, innerWidth: 1200, innerHeight: 800,
    getComputedStyle: item => item.style || { visibility: 'visible', display: 'block', opacity: '1' },
  });
}
test('Naver lowest-price locator finds only the visible low-price control and recognizes an applied sort', () => {
  const high = { matches: ['button'], innerText: '높은 가격순', getAttribute: () => null, className: '', getBoundingClientRect: () => ({ left: 600, top: 100, right: 700, bottom: 140, width: 100, height: 40 }) };
  const low = { matches: ['button'], innerText: '낮은 가격순', getAttribute: () => null, className: '', getBoundingClientRect: () => ({ left: 400, top: 100, right: 520, bottom: 140, width: 120, height: 40 }) };
  assert.deepEqual({ ...locateLowestSort([high, low]) }, { selected: false, x: 460, y: 120, width: 120, height: 40 });
  assert.deepEqual({ ...locateLowestSort([], 'https://search.shopping.naver.com/search/all?query=test&sort=price_asc') }, { selected: true });
  assert.deepEqual({ ...locateLowestSort([], 'https://search.shopping.naver.com/ns/search?query=test&sort=LOW_PRICE') }, { selected: true });
});
test('Naver lowest-price automation clicks once and requires confirmed selection before collection', () => {
  const target = { selected: false, x: 460, y: 120 };
  assert.equal(decideNaverSort({ selected: true }), 'done');
  assert.equal(decideNaverSort(target), 'click');
  assert.equal(decideNaverSort(target, { clickAttempted: true }), 'handoff');
  assert.equal(decideNaverSort(null, { timedOut: false }), 'wait');
  assert.equal(decideNaverSort(null, { timedOut: true }), 'handoff');
  assert.equal(decideNaverSort(target, { manual: true }), 'wait_for_user');
});
test('native target click sends exactly one normal mouse click', async () => {
  const events = [];
  await clickVisibleTarget({ sendInputEvent: event => events.push(event) }, { x: 460.2, y: 119.8 }, async () => {});
  assert.deepEqual(events.map(event => event.type), ['mouseMove', 'mouseDown', 'mouseUp']);
  assert.deepEqual(events.slice(1).map(event => event.clickCount), [1, 1]);
});
test('native search uses visible click, normal text insertion and Enter', async () => {
  const events = []; const inserted = [];
  const webContents = { sendInputEvent: event => events.push(event), insertText: async value => inserted.push(value) };
  await submitVisibleSearch(webContents, { x: 125.4, y: 42.8 }, '  노트북\n1TB  ', async () => {});
  assert.deepEqual(inserted, ['노트북 1TB']);
  assert.deepEqual(events.slice(0, 3).map(event => event.type), ['mouseMove', 'mouseDown', 'mouseUp']);
  assert.deepEqual(events.slice(-2).map(event => [event.type, event.keyCode]), [['keyDown', 'Enter'], ['keyUp', 'Enter']]);
});
test('serialized parser works without extension globals or outer helper functions', async () => {
  const empty = { innerText: '', textContent: '', querySelectorAll: () => [], querySelector: () => null };
  const context = { URL, location: { href: 'https://search.shopping.naver.com/search/all?query=test' }, document: { ...empty, body: empty, documentElement: { contains: () => true } }, window: { scrollY: 0 } };
  const result = await vm.runInNewContext(`(${captureVisibleShoppingProducts.toString()})('naver', 10, 'test')`, context);
  assert.equal(result.items.length, 0); assert.match(result.warnings[0], /찾지 못/);
});
test('AI observation contains bounded visible product-card text and links but no input values', () => {
  const card = { innerText: '노트북 MODEL-1 900,000원 무료배송', parentElement: null };
  const anchor = {
    href: 'https://search.shopping.naver.com/product/1', innerText: '노트북 MODEL-1', parentElement: card,
    getBoundingClientRect: () => ({ left: 10, top: 10, right: 210, bottom: 50, width: 200, height: 40 }),
  };
  const result = vm.runInNewContext(`(${captureVisibleObservation.toString()})('naver', 'MODEL-1')`, {
    URL, innerWidth: 1200, innerHeight: 800, location: { href: 'https://search.shopping.naver.com/ns/search?query=MODEL-1' },
    document: { title: '검색', querySelectorAll: selector => selector === 'a[href]' ? [anchor] : [], body: { innerText: '계정명 secret input-value' } },
    getComputedStyle: () => ({ visibility: 'visible', display: 'block', opacity: '1' }), Set,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(result.links)), [{ text: '노트북 MODEL-1', url: 'https://search.shopping.naver.com/product/1' }]);
  assert.match(result.visible_text, /900,000원/);
  assert.doesNotMatch(result.visible_text, /secret|input-value/);
});
