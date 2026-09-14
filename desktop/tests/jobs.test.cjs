const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { JobManager, MIN_NAVER_INTERVAL, MAX_NAVER_INTERVAL, NAVER_CACHE_TTL, NAVER_BLOCK_COOLDOWN } = require('../job-manager.cjs');
const tick = () => new Promise(resolve => setImmediate(resolve));
const item = { source: 'naver', name: '노트북 MODEL-1', price: 900000, url: 'https://shopping.naver.com/product/1' };
const result = { items: [item], pageUrl: 'https://search.shopping.naver.com/search/all?query=MODEL-1', warnings: [] };
const input = (sources = ['naver'], extra = {}) => ({ query: 'MODEL-1', sources, token: 'private-test-token', productId: 'product-1', ...extra });
function setup(t, overrides = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pricescan-job-test-'));
  const driver = { collect: async () => result, stop() {}, focus() {}, has: () => true, showScroll() {}, captureAll: () => 1, ...overrides.driver };
  const saved = []; const notices = [];
  const manager = new JobManager({ directory, driver, save: async (...args) => saved.push(args), notify: (...args) => notices.push(args), randomDelay: () => MIN_NAVER_INTERVAL, ...overrides, driver });
  t.after(() => { manager.shutdown(); fs.rmSync(directory, { recursive: true, force: true }); });
  return { manager, directory, saved, notices, driver };
}
test('Naver verification never blocks parser sources or partial saving', async t => {
  let finishNaver;
  const { manager, saved, notices } = setup(t, { driver: { collect: async (_job, source, controls) => {
    if (source !== 'naver') return result;
    controls.progress('needs_verification', '사용자 확인 필요');
    return new Promise(resolve => { finishNaver = resolve; });
  } } });
  manager.start(input(['naver', 'danawa', 'enuri', 'coupang'])); await tick();
  assert.equal(saved.length, 3); assert.equal(notices.length, 1);
  assert.equal(manager.list()[0].tasks.find(task => task.source === 'naver').state, 'needs_verification');
  finishNaver(result); await tick(); assert.equal(saved.length, 4); assert.equal(manager.list()[0].active, false);
});
test('normal results collect and save without a per-search approval prompt', async t => {
  const { manager, saved, notices } = setup(t); manager.start(input()); await tick();
  assert.equal(saved.length, 1); assert.equal(notices.length, 0); assert.equal(manager.list()[0].tasks[0].state, 'completed');
});
test('manual scroll jobs bypass the Naver scheduler and capture all ready screens together', async t => {
  let time = 10000000; let captureCalls = 0; const pending = new Map();
  const { manager, saved } = setup(t, { now: () => time, driver: {
    collect: async (_job, source, controls) => new Promise(resolve => {
      controls.progress('ready_to_capture', `${source} 준비 완료`);
      pending.set(source, resolve);
    }),
    captureAll: () => { captureCalls += 1; for (const resolve of pending.values()) resolve(result); return 4; },
  } });
  manager.state.nextNaverSearchAt = time + MAX_NAVER_INTERVAL;
  const { id } = manager.start(input(['naver', 'danawa', 'enuri', 'coupang'], { captureMode: 'manual_scroll' }));
  await tick();
  assert.equal(saved.length, 0);
  assert.equal(manager.list()[0].captureMode, 'manual_scroll');
  assert.deepEqual(manager.captureAll(id), { count: 4, total: 4 });
  await tick(); await tick();
  assert.equal(captureCalls, 1);
  assert.equal(saved.length, 4);
});
test('manual scroll capture can collect ready marketplaces while Naver is blocked', async t => {
  let captured = 0;
  const { manager } = setup(t, { driver: {
    collect: async (_job, source, controls) => {
      if (source === 'naver') { controls.progress('blocked', '네이버 접근 제한'); return { paused: true }; }
      controls.progress('ready_to_capture', `${source} 준비 완료`);
      return new Promise(() => {});
    },
    captureAll: () => { captured += 1; return 1; },
  } });
  const { id } = manager.start(input(['naver', 'danawa'], { captureMode: 'manual_scroll' }));
  await tick();
  assert.deepEqual(manager.captureAll(id), { count: 1, total: 2 });
  assert.equal(captured, 1);
});
test('manual scroll capture still rejects when no marketplace is ready', async t => {
  const { manager } = setup(t, { driver: {
    collect: async (_job, _source, controls) => { controls.progress('blocked', '접근 제한'); return { paused: true }; },
  } });
  const { id } = manager.start(input(['naver'], { captureMode: 'manual_scroll' }));
  await tick();
  assert.throws(() => manager.captureAll(id), /준비가 끝난 쇼핑몰이 없습니다/);
});
test('embedded collector exposes a same-view back action for restricted detail pages', () => {
  const driverSource = fs.readFileSync(path.join(__dirname, '../browser-driver.cjs'), 'utf8');
  const controlsHtml = fs.readFileSync(path.join(__dirname, '../controls.html'), 'utf8');
  const controlsSource = fs.readFileSync(path.join(__dirname, '../controls.js'), 'utf8');
  assert.match(driverSource, /navigationHistory\.goBack\(\)/);
  assert.match(controlsHtml, /data-action="back"/);
  assert.match(controlsSource, /state\.canGoBack/);
});
test('a new manual scroll search supersedes old waiting screens and starts the latest query', async t => {
  const pending = new Map(); const stopped = [];
  const { manager, saved } = setup(t, { driver: {
    collect: (job, source) => new Promise(resolve => pending.set(`${job.id}:${source}`, resolve)),
    stop: (jobId, source) => {
      stopped.push(`${jobId}:${source}`);
      pending.get(`${jobId}:${source}`)?.({ paused: true });
    },
  } });
  const first = manager.start(input(['naver', 'danawa'], { captureMode: 'manual_scroll' }));
  await tick();
  const second = manager.start(input(['naver', 'danawa'], { query: 'MODEL-2', productId: 'product-2', captureMode: 'manual_scroll' }));
  await tick(); await tick();
  assert.deepEqual(manager.list().find(job => job.id === first.id).tasks.map(task => task.state), ['cancelled', 'cancelled']);
  assert.deepEqual(stopped.sort(), [`${first.id}:danawa`, `${first.id}:naver`].sort());
  assert.equal(pending.has(`${second.id}:naver`), true);
  assert.equal(pending.has(`${second.id}:danawa`), true);
  pending.get(`${second.id}:naver`)(result); pending.get(`${second.id}:danawa`)(result);
  await tick();
  assert.equal(saved.length, 2);
});
test('cancellation ignores a late parser response and never saves it', async t => {
  let finish;
  const { manager, saved } = setup(t, { driver: { collect: () => new Promise(resolve => { finish = resolve; }) } });
  const { id } = manager.start(input()); manager.action(id, 'naver', 'cancel'); finish(result); await tick();
  assert.equal(saved.length, 0); assert.equal(manager.list()[0].tasks[0].state, 'cancelled');
});
test('saved credentials are absent and restart explicitly pauses unfinished work', async t => {
  const { manager, directory, driver } = setup(t, { driver: { collect: async (_job, _source, controls) => { controls.progress('blocked', '접근 제한'); return { paused: true }; } } });
  manager.start(input()); await tick();
  const disk = fs.readFileSync(path.join(directory, 'collection-jobs.json'), 'utf8');
  assert.equal(disk.includes('private-test-token'), false); assert.equal(disk.includes('"token"'), false);
  const restored = new JobManager({ directory, driver, save: async () => {}, notify: () => {} });
  assert.equal(restored.list()[0].tasks[0].state, 'interrupted'); assert.equal(restored.tokens.size, 0);
  assert.throws(() => restored.action(restored.list()[0].id, 'naver', 'resume'), /로그인/);
});
test('failed saving resumes from local items, without another Naver search', async t => {
  let captures = 0; let saves = 0;
  const { manager } = setup(t, { driver: { collect: async () => { captures++; return result; } }, save: async () => { if (++saves === 1) throw new Error('offline'); } });
  const { id } = manager.start(input()); await tick(); assert.equal(manager.list()[0].tasks[0].state, 'save_failed');
  manager.action(id, 'naver', 'resume'); await tick();
  assert.equal(captures, 1); assert.equal(saves, 2); assert.equal(manager.list()[0].tasks[0].state, 'completed');
});
test('search interval is persisted and throttles Naver, not other marketplaces', async t => {
  let time = 10000000;
  const { manager, saved } = setup(t, { now: () => time });
  manager.start(input()); await tick();
  manager.start(input(['naver', 'danawa'], { query: 'MODEL-2', productId: 'product-2' })); await tick();
  assert.equal(saved.length, 2); assert.equal(manager.list()[0].tasks[0].nextAt, 13600000);
  time += MIN_NAVER_INTERVAL; manager.pump(); await tick(); assert.equal(saved.length, 3);
});
test('Naver scheduling spreads starts above the strict minimum while other sources continue', async t => {
  let time = 10000000;
  const { manager, saved } = setup(t, { now: () => time, randomDelay: () => MAX_NAVER_INTERVAL });
  manager.start(input()); await tick();
  manager.start(input(['naver', 'danawa'], { query: 'MODEL-2', productId: 'product-2' })); await tick();
  const queued = manager.list()[0];
  assert.equal(saved.length, 2);
  assert.equal(queued.tasks.find(task => task.source === 'danawa').state, 'completed');
  assert.equal(queued.tasks.find(task => task.source === 'naver').nextAt, 15400000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(manager.file), 'utf8')).nextNaverSearchAt, 15400000);
  time = 15399999; manager.pump(); await tick(); assert.equal(saved.length, 2);
  time = 15400000; manager.pump(); await tick(); assert.equal(saved.length, 3);
});
test('same Naver query reuses a six-hour cache without another search', async t => {
  let time = 10000000; let captures = 0;
  const { manager, saved } = setup(t, { now: () => time, driver: { collect: async () => { captures++; return result; } } });
  manager.start(input()); await tick();
  manager.start(input(['naver'], { productId: 'product-2' })); await tick();
  assert.equal(captures, 1);
  assert.equal(saved.length, 2);
  assert.equal(manager.list()[0].tasks[0].reused, true);
  assert.match(manager.list()[0].tasks[0].message, /새 요청 없음/);
  time += NAVER_CACHE_TTL + 1;
  manager.start(input(['naver'], { productId: 'product-3' })); await tick();
  assert.equal(captures, 2);
  assert.equal(saved.length, 3);
  assert.equal(manager.list()[0].tasks[0].reused, false);
});
test('a detected Naver block starts a persisted 24-hour cooldown without retrying', async t => {
  let time = 10000000; let captures = 0;
  const { manager } = setup(t, { driver: { collect: async (_job, source, controls) => {
    if (source !== 'naver') return result;
    captures++; controls.progress('blocked', '접근 제한'); return { paused: true };
  } }, now: () => time });
  const first = manager.start(input()); await tick();
  assert.equal(captures, 1);
  assert.equal(manager.state.naverBlockedUntil, time + NAVER_BLOCK_COOLDOWN);
  assert.equal(JSON.parse(fs.readFileSync(manager.file, 'utf8')).naverBlockedUntil, time + NAVER_BLOCK_COOLDOWN);
  manager.action(first.id, 'naver', 'cancel');
  manager.start(input(['naver'], { query: 'MODEL-2', productId: 'product-2' })); await tick();
  assert.equal(captures, 1);
  assert.equal(manager.list()[0].tasks[0].nextAt, time + NAVER_BLOCK_COOLDOWN);
  assert.match(manager.list()[0].tasks[0].message, /24시간/);
});
test('blocked Naver is not automatically retried or replaced by another Naver job', async t => {
  let count = 0;
  const { manager } = setup(t, { driver: { collect: async (_job, source, controls) => {
    if (source !== 'naver') return result;
    count++; controls.progress('blocked', '접근 제한'); return { paused: true };
  } } });
  manager.start(input()); await tick();
  manager.start(input(['naver', 'danawa'], { productId: 'product-2' })); manager.pump(); await tick();
  assert.equal(count, 1); assert.equal(manager.list()[0].tasks[1].state, 'completed');
});
test('duplicate active product, unknown actions and arbitrary sources are rejected', t => {
  const { manager } = setup(t, { driver: { collect: () => new Promise(() => {}) } });
  const { id } = manager.start(input());
  assert.throws(() => manager.start(input()), /이미/);
  assert.throws(() => manager.start(input(['filesystem'])), /쇼핑몰/);
  assert.throws(() => manager.action(id, 'naver', 'shell'), /할 수 없는/);
});
test('one failed site cannot fail a successful independent site', async t => {
  const { manager } = setup(t, { driver: { collect: async (_job, source) => { if (source === 'naver') throw new Error('network'); return result; } } });
  manager.start(input(['naver', 'danawa'])); await tick();
  assert.deepEqual(manager.list()[0].tasks.map(task => task.state), ['failed', 'completed']);
});
test('logout pauses tasks and prevents late writes', async t => {
  let finish;
  const { manager, saved } = setup(t, { driver: { collect: () => new Promise(resolve => { finish = resolve; }) } });
  manager.start(input()); manager.logout(); finish(result); await tick();
  assert.equal(saved.length, 0); assert.equal(manager.tokens.size, 0); assert.equal(manager.list()[0].tasks[0].state, 'interrupted');
});

test('cancelling an in-flight save aborts transport and cannot mark the task completed', async t => {
  let signal; let finish;
  const { manager } = setup(t, { save: async (_job, _source, _token, value) => { signal = value; await new Promise(resolve => { finish = resolve; }); } });
  const { id } = manager.start(input()); await tick();
  manager.action(id, 'naver', 'cancel'); assert.equal(signal.aborted, true);
  finish(); await tick(); assert.equal(manager.list()[0].tasks[0].state, 'cancelled');
});
