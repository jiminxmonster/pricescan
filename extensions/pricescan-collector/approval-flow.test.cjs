const test = require('node:test');
const assert = require('node:assert/strict');
const Flow = require('./approval-flow.js');
const fs = require('node:fs');
const vm = require('node:vm');
const make = extra => Flow.create({ id: 'df561a3a-f736-415d-9e5f-4890d1da7302', query: '삼성 SSD 2TB', returnUrl: 'http://localhost:8300/pricescan/', apiBase: 'http://localhost:8300/pricescan/api/seller-products', apiToken: 'test-token', ...extra });
const config = { configured: true, legacy_parser_fallback: false, protocol_version: 'test', sources: [] };
const input = (job, extra = {}) => ({ id: job.id, revision: job.revision, action: 'approve', ...extra });
const offer = (source, n = 1) => ({ source, name: `SSD 2TB ${n}`, price: 190000 + n, shipping: 0, url: `https://${Flow.sources.find(s => s.id === source).hosts[0]}/products/${n}` });
function results(job) { return { pageUrl: Flow.current(job).search(job.query), items: [offer(Flow.current(job).id), offer(Flow.current(job).id, 2)] }; }
test('PriceScan starts Naver in the same approved search flow', () => {
  const planned = make({ sourceQueries: { naver: '삼성 SSD NVMe 2TB' } });
  const result = Flow.transition(planned, input(planned));
  assert.match(result.effect.navigate, /^https:\/\/search\.shopping\.naver\.com\/ns\/search/);
  assert.match(decodeURIComponent(result.effect.navigate), /삼성 SSD NVMe 2TB/);
  assert.equal(result.effect.attachCurrent, undefined);
  assert.equal(result.job.stage, 'results');
});
test('Naver seller links remain data only; selected offers never navigate and unknown shipping needs review', () => {
  const url = 'https://cr.shopping.naver.com/adcr?offer=one';
  assert.equal(Flow.safeUrl(url, 'naver'), '');
  assert.equal(Flow.offerUrl(url, 'naver'), url);
  for (const bad of ['https://cr.shopping.naver.com.evil.test/adcr', 'https://cr.shopping.naver.com/login', 'http://cr.shopping.naver.com/adcr']) assert.equal(Flow.offerUrl(bad, 'naver'), '');
  let job = Flow.transition(make({ selectedSources: ['naver'] }), input(make())).job;
  const item = { ...offer('naver'), mall: '판매처 A', url, shipping: null };
  job = Flow.transition(job, input(job, { confirmSorted: true }), { pageUrl: 'https://search.shopping.naver.com/catalog/123', items: [item, { ...item, mall: '판매처 B', url: url + '2' }] }).job;
  let result = Flow.transition(job, input(job, { selected: [0, 1] }));
  assert.equal(result.job.stage, 'detail_review'); assert.deepEqual(result.effect, {});
  job = result.job;
  assert.throws(() => Flow.transition(job, input(job, { confirmDetail: true, review: item })), /미확인 배송비/);
  result = Flow.transition(job, input(job, { confirmDetail: true, review: { ...item, shipping: 0 } }));
  assert.deepEqual(result.effect, {}); assert.equal(result.job.stage, 'detail_review');
  assert.equal(result.job.items[0].url, url);
});
test('one action per approval, all four sources, only selected details, final publish only', () => {
  let job = make(); let publishes = 0, navigations = 0;
  const step = (extra, observation) => {
    const old = structuredClone(job);
    const result = Flow.transition(job, input(job, extra), observation);
    assert.deepEqual(job, old, 'transition must not mutate persisted state');
    job = result.job; navigations += Boolean(result.effect.navigate); publishes += Boolean(result.effect.publish);
    return result;
  };
  for (let i = 0; i < 4; i++) {
    step(); assert.equal(job.stage, 'results');
    step({ confirmSorted: true }, results(job)); assert.equal(job.stage, 'candidates');
    step({ selected: [1] }); assert.equal(job.queue.length, 1);
    const item = offer(Flow.current(job).id, 2);
    if (Flow.current(job).id !== 'naver') step({}, { item, pageUrl: item.url });
    assert.equal(job.stage, 'detail_review');
    step({ review: item, confirmDetail: true }, { pageUrl: item.url });
    assert.equal(publishes, 0);
  }
  assert.equal(job.stage, 'final'); assert.equal(job.items.length, 4); assert.equal(navigations, 7);
  const final = step(); assert.equal(final.effect.publish.items.length, 4);
  assert.equal(final.effect.publish.returnUrl, 'http://localhost:8300/pricescan/');
  assert.equal(job.stage, 'awaiting_import');
  step(); assert.equal(publishes, 1, 'retrying import must not create another capture');
});
test('supervised AI mode selects the lowest loaded offer without claiming user-confirmed sorting', () => {
  let job = make({ selectedSources: ['naver'], mergeRunId: 'ai-existing-run' });
  job = Flow.transition(job, input(job)).job;
  const expensive = { ...offer('naver', 1), price: 300000, shipping: 0, mall: '비싼몰' };
  const lowest = { ...offer('naver', 2), price: 180000, shipping: 2500, mall: '최저몰' };
  job = Flow.transition(job, input(job, { acceptVisibleLowest: true }), {
    pageUrl: Flow.current(job).search(job.query), items: [expensive, lowest],
  }).job;
  assert.equal(job.stage, 'candidates');
  assert.equal(job.candidates[0].mall, '최저몰');
  assert.match(job.warnings[0], /현재 화면에 로드된 후보/);
  job = Flow.transition(job, input(job, { selected: [0] })).job;
  assert.equal(job.stage, 'detail_review');
  let finished = Flow.transition(job, input(job, { confirmDetail: true, review: lowest }), {
    pageUrl: job.pageUrls.naver, items: [lowest],
  });
  assert.equal(finished.job.stage, 'final');
  assert.equal(finished.job.items[0].total, 182500);
  finished = Flow.transition(finished.job, input(finished.job));
  assert.equal(finished.effect.publish.mergeRunId, 'ai-existing-run');
});
test('detail review keeps the approved search price when the detail page cannot expose it', () => {
  let job = make({ selectedSources: ['danawa'] });
  job = Flow.transition(job, input(job)).job;
  const candidate = { ...offer('danawa'), name: '갤럭시북6 프로 NT940XJG-K51A · SSD 256GB', price: 2519000, shipping: 0 };
  job = Flow.transition(job, input(job, { confirmSorted: true }), {
    pageUrl: Flow.current(job).search(job.query), items: [candidate],
  }).job;
  job = Flow.transition(job, input(job, { selected: [0] })).job;
  assert.equal(job.stage, 'detail');

  job = Flow.transition(job, input(job), {
    pageUrl: candidate.url,
    item: { source: 'danawa', name: candidate.name, price: null, shipping: null, url: candidate.url },
  }).job;

  assert.equal(job.stage, 'detail_review');
  assert.equal(job.review.price, 2519000);
  assert.equal(job.review.shipping, 0);
  assert.equal(job.review.priceEvidence, 'search');
  assert.equal(job.review.shippingEvidence, 'search');

  const restored = structuredClone(job);
  restored.review.price = null;
  restored.review.shipping = null;
  delete restored.review.priceEvidence;
  delete restored.review.shippingEvidence;
  assert.equal(Flow.reviewValues(restored).price, 2519000, 'an already-open review also reuses the selected search price');
  assert.equal(Flow.reviewValues(restored).shipping, 0);
});
test('double-click revision, blocked screen, unconfirmed sort and unknown shipping cannot advance', () => {
  const start = make(); const action = input(start);
  let job = Flow.transition(start, action).job;
  assert.throws(() => Flow.transition(job, action), /이미 처리/);
  assert.throws(() => Flow.transition(job, input(job), { blocked: true }), /상품을 읽지/);
  assert.throws(() => Flow.transition(job, input(job), results(job)), /낮은 가격순/);
  job = Flow.transition(job, input(job, { confirmSorted: true }), results(job)).job;
  job = Flow.transition(job, input(job, { selected: [0] })).job;
  assert.throws(() => Flow.transition(job, input(job, { confirmDetail: true, review: { ...offer('naver'), shipping: null } }), { pageUrl: offer('naver').url }), /미확인 배송비/);
});
test('skip has no data, no automatic next-source navigation; cancel prevents approval', () => {
  const result = Flow.transition(make(), input(make(), { action: 'skip_source' }));
  assert.equal(result.job.stage, 'next_source'); assert.deepEqual(result.effect, {}); assert.equal(result.job.items.length, 0);
  const cancelled = Flow.transition(result.job, input(result.job, { action: 'cancel' })).job;
  assert.throws(() => Flow.transition(cancelled, input(cancelled)), /진행할 수 없는/);
});
test('URL boundaries reject private, login, spoofed hosts, other app destinations', () => {
  for (const url of ['http://localhost:8400/', 'javascript:alert(1)', 'https://www.coupang.com.evil.test/', 'https://www.coupang.com/login', 'https://me:pw@www.coupang.com/']) assert.equal(Flow.safeUrl(url, 'coupang'), '');
  assert.equal(Flow.appUrl('https://pricescan.d2blue.com.evil.test/pricescan/'), '');
});
test('service worker never navigates on startup, get, or blocked observation; rejects untrusted sender', async () => {
  const listeners = [], store = {}, calls = [];
  const clone = x => structuredClone(x);
  const chrome = { runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`, onMessage: { addListener: fn => listeners.push(fn) } },
    storage: { local: { get: async key => ({ [key]: clone(store[key]) }), set: async values => Object.assign(store, clone(values)) } },
    sidePanel: { open: async () => {} },
    tabs: { query: async () => [{ id: 5, windowId: 2, active: true, status: 'complete', url: 'https://search.shopping.naver.com/ns/search?query=SSD' }], create: async args => { calls.push(args); return { id: 5 }; }, update: async (id, args) => { calls.push(args); return { id }; }, get: async () => ({ id: 5, active: true, status: 'complete', url: 'https://search.shopping.naver.com/ns/search?query=SSD' }) },
    scripting: { executeScript: async args => args.files ? [] : [{ result: { blocked: true, message: '접근 제한' } }] } };
  const fetch = async url => ({ ok: true, json: async () => String(url).endsWith('/collection-config') ? config : { blocked: true, needs_user: true, message: '접근 제한', items: [] } });
  const context = { chrome, PriceScanApprovalFlow: Flow, crypto: { randomUUID: () => make().id }, structuredClone, URL, fetch };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/approval-runtime.js`, 'utf8'), context);
  assert.equal(calls.length, 0);
  const internal = { id: 'test', url: 'chrome-extension://test/approval-panel.html' };
  const app = { id: 'test', url: 'http://localhost:8300/pricescan/', tab: { id: 1, windowId: 2 } };
  const send = (message, sender = internal) => new Promise(resolve => { const handled = listeners[0](message, sender, resolve); if (!handled) resolve(null); });
  assert.equal(await send({ type: 'PRICESCAN_APPROVAL_START' }, { id: 'test', url: 'https://evil.test/' }), null);
  let result = await send({ type: 'PRICESCAN_APPROVAL_START', query: 'SSD', sources: ['naver'], token: 'test-token' }, app);
  assert.equal(result.ok, true, 'Naver starts from the PriceScan AI search form');
  assert.equal(calls.length, 0, 'preparing a job does not navigate before the user clicks continue');
  result = await send({ type: 'PRICESCAN_APPROVAL_ACT', ...input(result.job) });
  assert.equal(result.ok, true); assert.equal(calls.length, 1);
  assert.match(calls[0].url, /^https:\/\/search\.shopping\.naver\.com/);
  const current = result.job;
  result = await send({ type: 'PRICESCAN_APPROVAL_ACT', ...input(current, { confirmSorted: true }) });
  assert.equal(result.ok, false); assert.match(result.error, /접근 제한/); assert.equal(calls.length, 1);
  assert.equal((await send({ type: 'PRICESCAN_APPROVAL_GET' })).job.stage, 'results');
  store.pricescanApprovalJob.busy = true;
  assert.equal((await send({ type: 'PRICESCAN_APPROVAL_GET' })).job.busy, false);
  assert.equal(calls.length, 1, 'restoring a checkpoint must never replay navigation');
});
test('legacy Naver-first entry point is disabled so PriceScan remains the single start', async () => {
  const listeners = [], store = {}, calls = [];
  const naver = { id: 25, windowId: 2, active: true, status: 'complete', url: 'https://search.shopping.naver.com/catalog/123?query=SSD' };
  const chrome = { runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`, onMessage: { addListener: fn => listeners.push(fn) } },
    storage: { local: { get: async key => ({ [key]: structuredClone(store[key]) }), set: async values => Object.assign(store, structuredClone(values)) } },
    sidePanel: { open: async () => calls.push('panel') },
    tabs: { get: async id => id === 25 ? naver : null, query: async () => [naver], create: async () => calls.push('navigate'), update: async () => calls.push('navigate') },
    scripting: { executeScript: async () => calls.push('read') } };
  const fetch = async () => ({ ok: true, json: async () => config });
  vm.runInNewContext(fs.readFileSync(`${__dirname}/approval-runtime.js`, 'utf8'), { chrome, PriceScanApprovalFlow: Flow, structuredClone, URL, crypto: { randomUUID: () => make().id }, fetch });
  const internal = { id: 'test', url: 'chrome-extension://test/popup.html' };
  const send = (message, sender = internal) => new Promise(resolve => { if (!listeners[0](message, sender, resolve)) resolve(null); });
  const start = { type: 'PRICESCAN_APPROVAL_FROM_NAVER', tabId: 25, query: 'SSD', returnUrl: 'http://localhost:8300/pricescan/', sources: ['naver', 'danawa'] };
  assert.equal(await send(start, { id: 'test', url: 'https://evil.test/' }), null);
  assert.equal(Boolean((await send({ ...start, returnUrl: 'https://evil.test/' }))?.ok), false);
  const result = await send(start);
  assert.equal(result, null);
  assert.deepEqual(calls, []);
});
test('PriceScan web search is extensionless while the collector remains compatibility-only', () => {
  const ui = fs.readFileSync(`${__dirname}/../../frontend/src/SellerWorkspace.tsx`, 'utf8');
  const app = fs.readFileSync(`${__dirname}/../../frontend/src/App.tsx`, 'utf8');
  assert.match(ui, /AI 최저가 찾기/);
  assert.match(ui, /pricescan:ai-search-allowed/);
  assert.doesNotMatch(ui, /supervised_sources/);
  assert.doesNotMatch(ui, /requireApprovalCollector/);
  assert.doesNotMatch(ui, /네이버 로그인 상태를 확인했고 감시형 AI 조사에 동의/);
  assert.match(ui, /확장 프로그램 없이 네이버·다나와·에누리·쿠팡/);
  assert.doesNotMatch(app, /checkCollectorConnection/);
  assert.doesNotMatch(app, /showCollectorConnection/);
  assert.doesNotMatch(ui, /네이버는 여기서 검색하지 않습니다/);
  assert.doesNotMatch(ui, /naverFirst/);
  assert.doesNotMatch(app, /window\.open\(naverShoppingSearchUrl/);
  assert.match(app, /capture\.mode !== "supervised_ai"/);
  assert.match(app, /approval_scope: "server_managed_ai"/);
  assert.doesNotMatch(app, /guided \? "user_per_step"/);
});
test('popup has one entry point and never starts collection from a shopping page', async () => {
  const nodes = {}, calls = [];
  function element() { return { style: {}, dataset: {}, hidden: false, addEventListener(type, listener) { this[type] = listener; } }; }
  for (const id of ['capture', 'guidedOpen', 'status', 'statusText', 'openPriceScan']) nodes[id] = element();
  const naver = { id: 25, windowId: 2, active: true, url: 'https://search.shopping.naver.com/search/all?query=SSD' };
  const context = { URL, document: { getElementById: id => nodes[id] }, window: { close: () => calls.push('close') }, chrome: {
    tabs: { query: async args => args.active ? [naver] : [naver], create: async args => calls.push({ create: args }), update: async (id, args) => calls.push({ update: id, args }) },
    sidePanel: { open: async () => calls.push('panel') },
    runtime: { sendMessage: async message => { calls.push(message); return { ok: true, job: null }; } },
  } };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/popup.js`, 'utf8'), context);
  await new Promise(resolve => setImmediate(resolve));
  await nodes.capture.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.some(value => value?.type === 'PRICESCAN_APPROVAL_FROM_NAVER'), false);
  assert.equal(calls.some(value => value?.create?.url === 'https://pricescan.d2blue.com/pricescan/'), true);
});
test('AI search opens Naver and reuses its dedicated tab for the next source', async () => {
  const listeners = [], calls = [], store = {};
  let active = { id: 9, windowId: 2, active: true, status: 'complete', url: 'http://localhost:8300/pricescan/' };
  let observation = {};
  const chrome = { runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`, onMessage: { addListener: fn => listeners.push(fn) } },
    storage: { local: { get: async key => ({ [key]: structuredClone(store[key]) }), set: async values => Object.assign(store, structuredClone(values)) } },
    sidePanel: { open: async () => {} }, tabs: {
      query: async args => { assert.deepEqual(JSON.parse(JSON.stringify(args)), { active: true, windowId: 2 }); return active ? [active] : []; },
      get: async () => active,
      create: async args => { calls.push({ kind: 'create', ...args }); active = { id: 10, windowId: 2, active: true, status: 'complete', url: args.url }; return active; },
      update: async (id, args) => { calls.push({ kind: 'update', id, ...args }); active = { ...active, ...args, id, status: 'complete' }; return active; },
    }, scripting: { executeScript: async args => args.files ? [] : [{ result: observation }] } };
  const fetch = async () => ({ ok: true, json: async () => ({ ...observation, pageUrl: active.url }) });
  vm.runInNewContext(fs.readFileSync(`${__dirname}/approval-runtime.js`, 'utf8'), { chrome, PriceScanApprovalFlow: Flow, structuredClone, URL, crypto: { randomUUID: () => make().id }, fetch });
  const internal = { id: 'test', url: 'chrome-extension://test/approval-panel.html' };
  const send = message => new Promise(resolve => listeners[0](message, internal, resolve));
  store.pricescanApprovalJob = make({ windowId: 2, appTabId: 1 });
  const act = extra => send({ type: 'PRICESCAN_APPROVAL_ACT', ...input(store.pricescanApprovalJob, extra) });
  assert.equal((await act()).ok, true); assert.equal(store.pricescanApprovalJob.tabId, 10);
  assert.equal(calls.length, 1); assert.equal(calls[0].kind, 'create');
  observation = { pageUrl: active.url, items: [{ ...offer('naver'), mall: '판매처 A' }] };
  assert.equal((await act({ confirmSorted: true })).ok, true);
  assert.equal((await act({ selected: [0] })).ok, true);
  observation.items[0].price++;
  assert.equal((await act({ confirmDetail: true, review: offer('naver') })).ok, false);
  assert.equal(store.pricescanApprovalJob.items.length, 0);
  observation.items[0].price--;
  assert.equal((await act({ confirmDetail: true, review: offer('naver') })).ok, true);
  assert.equal(calls.length, 1);
  assert.equal(store.pricescanApprovalJob.stage, 'next_source');
  assert.equal((await act()).ok, true);
  assert.equal(calls.length, 2); assert.equal(calls[1].kind, 'update');
  assert.match(calls[1].url, /^https:\/\/search\.danawa\.com/);
  assert.match(active.url, /^https:\/\/search\.danawa\.com/);
});
test('one autorun command completes a normal loaded source and publishes one verified lowest offer', async () => {
  const listeners = [], store = {}, calls = [];
  const appTab = { id: 1, windowId: 2, active: false, status: 'complete', url: 'http://localhost:8300/pricescan/' };
  let workTab = null;
  const lowest = { ...offer('naver', 2), price: 180000, shipping: 0, mall: '최저몰' };
  const expensive = { ...offer('naver', 1), price: 300000, shipping: 0, mall: '비싼몰' };
  const chrome = { runtime: { id: 'test', getURL: p => `chrome-extension://test/${p}`, onMessage: { addListener: fn => listeners.push(fn) } },
    storage: { local: { get: async key => ({ [key]: structuredClone(store[key]) }), set: async values => Object.assign(store, structuredClone(values)) } },
    sidePanel: { open: async () => {} }, tabs: {
      onUpdated: { addListener() {}, removeListener() {} },
      get: async id => id === 1 ? appTab : workTab,
      query: async () => [appTab, workTab].filter(Boolean),
      create: async args => { workTab = { id: 10, windowId: 2, active: true, status: 'complete', url: args.url }; calls.push(args.url); return workTab; },
      update: async (id, args) => { const tab = id === 1 ? appTab : workTab; Object.assign(tab, args); return tab; },
      sendMessage: async () => undefined,
    }, scripting: { executeScript: async args => args.files ? [] : [{ result: { pageUrl: workTab.url, items: [expensive, lowest] } }] } };
  store.pricescanApprovalJob = make({ selectedSources: ['naver'], appTabId: 1, windowId: 2 });
  const fetch = async () => ({ ok: true, json: async () => ({ pageUrl: workTab.url, items: [expensive, lowest] }) });
  const context = { chrome, PriceScanApprovalFlow: Flow, structuredClone, URL, crypto: { randomUUID: () => make().id }, setTimeout, clearTimeout, fetch };
  vm.runInNewContext(fs.readFileSync(`${__dirname}/approval-runtime.js`, 'utf8'), context);
  const send = message => new Promise(resolve => listeners[0](message, { id: 'test', url: 'chrome-extension://test/approval-panel.html' }, resolve));
  const job = store.pricescanApprovalJob;
  const result = await send({ type: 'PRICESCAN_APPROVAL_AUTORUN', id: job.id, revision: job.revision });
  assert.equal(result.ok, true);
  assert.equal(result.job.stage, 'awaiting_import');
  assert.equal(result.job.autoRunning, false);
  assert.equal(store.pricescanPendingCapture.mode, 'supervised_ai');
  assert.equal(store.pricescanPendingCapture.items.length, 1);
  assert.equal(store.pricescanPendingCapture.items[0].mall, '최저몰');
  assert.equal(calls.length, 1, 'the source is opened once without reload retries');
});
