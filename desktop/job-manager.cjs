const { randomUUID } = require('node:crypto');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const { validateStart } = require('./security.cjs');

const TERMINAL = new Set(['completed', 'failed', 'cancelled']);
const WAITING = new Set(['needs_login', 'needs_verification', 'needs_page', 'blocked', 'interrupted', 'save_failed']);
const labels = { naver: '네이버', danawa: '다나와', enuri: '에누리', coupang: '쿠팡' };
const MIN_NAVER_INTERVAL = 60 * 60000;
const MAX_NAVER_INTERVAL = 90 * 60000;
const NAVER_CACHE_TTL = 6 * 60 * 60000;
const NAVER_BLOCK_COOLDOWN = 24 * 60 * 60000;
const normalizedQuery = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
const isSupervised = job => ['ai_supervised', 'manual_scroll', 'manual_grid'].includes(job?.captureMode);
class JobManager extends EventEmitter {
  constructor({ directory, driver, save, notify, now = Date.now, interval = MIN_NAVER_INTERVAL,
    randomDelay = () => MIN_NAVER_INTERVAL + Math.floor(Math.random() * (MAX_NAVER_INTERVAL - MIN_NAVER_INTERVAL + 1)) }) {
    super();
    this.driver = driver; this.saveResult = save; this.notify = notify; this.now = now; this.interval = Math.max(MIN_NAVER_INTERVAL, interval); this.randomDelay = randomDelay;
    this.file = path.join(directory, 'collection-jobs.json'); this.tokens = new Map(); this.running = new Set(); this.controllers = new Map(); this.accepting = true;
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.state = { version: 1, lastNaverSearch: 0, nextNaverSearchAt: 0, naverBlockedUntil: 0, jobs: [] };
    if (fs.existsSync(this.file)) {
      this.state = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (this.state.version !== 1 || !Array.isArray(this.state.jobs)) throw new Error('작업 기록을 읽을 수 없습니다. 기존 기록은 보존했습니다.');
      if (!Number.isFinite(this.state.nextNaverSearchAt)) this.state.nextNaverSearchAt = 0;
      if (!Number.isFinite(this.state.naverBlockedUntil)) this.state.naverBlockedUntil = 0;
      delete this.state.naverNextLimit;
      for (const job of this.state.jobs) for (const task of Object.values(job.tasks)) {
        if (!TERMINAL.has(task.state)) { task.state = 'interrupted'; task.message = '앱 재시작으로 일시정지 · 이어서 진행을 눌러 주세요.'; }
      }
      this.persist();
    }
  }
  persist() {
    const temp = `${this.file}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(temp, this.file);
    this.emit('change', this.list());
  }
  list() {
    return this.state.jobs.map(job => ({ id: job.id, query: job.query, productId: job.productId, captureMode: job.captureMode || 'automatic', createdAt: job.createdAt, updatedAt: job.updatedAt,
      active: Object.values(job.tasks).some(task => !TERMINAL.has(task.state)),
      tasks: Object.entries(job.tasks).map(([source, task]) => ({ source, state: task.state, message: task.message, count: task.items?.length || 0,
        nextAt: task.nextAt || null, reused: Boolean(task.cacheReused), hasScreen: this.driver.has(job.id, source) })),
    }));
  }
  showScroll(jobId, source) {
    const job = this.state.jobs.find(entry => entry.id === jobId);
    if (!job) throw new Error('수집 작업을 찾지 못했습니다.');
    return this.driver.showScroll(job.id, Object.keys(job.tasks), source);
  }
  captureAll(jobId) {
    const job = this.state.jobs.find(entry => entry.id === jobId);
    if (!job) throw new Error('수집 작업을 찾지 못했습니다.');
    const ready = Object.entries(job.tasks).filter(([, task]) => task.state === 'ready_to_capture');
    if (!ready.length) throw new Error('현재 수집 준비가 끝난 쇼핑몰이 없습니다. 각 화면을 먼저 확인해 주세요.');
    const count = this.driver.captureAll(job.id);
    if (count !== ready.length) throw new Error('수집 준비 상태가 변경되었습니다. 각 쇼핑몰 화면을 다시 확인해 주세요.');
    return { count, total: Object.keys(job.tasks).length };
  }
  cachedNaver(job) {
    return this.state.jobs.find(candidate => {
      const task = candidate.tasks?.naver;
      const completedAt = Number(task?.completedAt || candidate.updatedAt || 0);
      return candidate.id !== job.id && candidate.sortMode === job.sortMode
        && normalizedQuery(candidate.query) === normalizedQuery(job.query)
        && task?.state === 'completed' && Array.isArray(task.items) && task.items.length
        && this.now() - completedAt >= 0 && this.now() - completedAt <= NAVER_CACHE_TTL;
    });
  }
  reuseCachedNaver(job, task) {
    const cached = this.cachedNaver(job); const source = cached?.tasks?.naver;
    if (!source) return false;
    task.items = source.items.map(item => ({ ...item }));
    task.pageUrl = source.pageUrl;
    task.warnings = [...(source.warnings || [])];
    task.cacheReused = true;
    task.message = `네이버 동일 검색 결과 ${task.items.length}개 재사용 · 새 요청 없음`;
    task.nextAt = null;
    this.persist();
    return true;
  }
  start(input) {
    if (!this.accepting) throw new Error('앱이 종료 중입니다.');
    const values = validateStart(input);
    if (isSupervised(values)) this.supersedeActiveJobs();
    if (this.state.jobs.some(job => job.productId === values.productId && Object.values(job.tasks).some(task => !TERMINAL.has(task.state)))) throw new Error('이 상품은 이미 조사 중입니다. 진행 중인 작업을 확인하세요.');
    if (this.state.jobs.filter(job => Object.values(job.tasks).some(task => !TERMINAL.has(task.state))).length >= 10) throw new Error('진행 중인 작업을 먼저 완료하거나 중지하세요.');
    const job = { ...values, id: randomUUID(), createdAt: this.now(), updatedAt: this.now(), tasks: Object.fromEntries(values.sources.map(source => [source, { state: 'queued', items: [], message: '검색 대기' }])) };
    this.tokens.set(job.id, input.token); this.state.jobs.unshift(job); this.persist(); this.pump(); return { id: job.id };
  }
  supersedeActiveJobs() {
    let changed = false;
    for (const job of this.state.jobs) for (const [source, task] of Object.entries(job.tasks)) {
      if (TERMINAL.has(task.state)) continue;
      this.controllers.get(`${job.id}:${source}`)?.abort();
      this.driver.stop(job.id, source);
      task.state = 'cancelled';
      task.message = '새 검색으로 종료되었습니다.';
      task.nextAt = null;
      job.updatedAt = this.now();
      changed = true;
    }
    if (changed) this.persist();
  }
  get(jobId, source) {
    const job = this.state.jobs.find(entry => entry.id === jobId); const task = job?.tasks[source];
    if (!job || !task) throw new Error('수집 작업을 찾지 못했습니다.');
    return { job, task };
  }
  change(job, task, state, message) {
    task.state = state; task.message = message; job.updatedAt = this.now(); this.persist();
  }
  authorize(token) {
    if (typeof token !== 'string' || !token || token.length > 4096 || /[\r\n]/.test(token)) throw new Error('로그인을 확인하세요.');
    for (const job of this.state.jobs) this.tokens.set(job.id, token);
  }
  logout() {
    this.tokens.clear();
    for (const job of this.state.jobs) for (const [source, task] of Object.entries(job.tasks)) if (!TERMINAL.has(task.state)) {
      this.controllers.get(`${job.id}:${source}`)?.abort();
      this.driver.stop(job.id, source); this.change(job, task, 'interrupted', 'PriceScan 로그아웃으로 일시정지');
    }
  }
  action(jobId, source, action) {
    const { job, task } = this.get(jobId, source);
    if (action === 'focus') return isSupervised(job) ? this.showScroll(job.id, source) : this.driver.focus(job.id, source);
    if (action === 'back') return this.driver.back(job.id, source);
    if (action === 'cancel') {
      if (TERMINAL.has(task.state)) return;
      this.controllers.get(`${job.id}:${source}`)?.abort();
      this.driver.stop(job.id, source); this.change(job, task, 'cancelled', '사용자가 중지했습니다.'); this.pump(); return;
    }
    if (action !== 'resume' || !WAITING.has(task.state)) throw new Error('현재 상태에서 할 수 없는 작업입니다.');
    if (!this.tokens.has(job.id)) throw new Error('PriceScan에 다시 로그인하세요.');
    if (this.running.has(source)) throw new Error('현재 동작이 멈추는 중입니다. 잠시 후 다시 시도하세요.');
    // A blocked page is never blindly reloaded: resume inspects the same human-operated page.
    task.resumeExisting = !task.items.length && this.driver.has(job.id, source);
    this.change(job, task, 'queued', task.items.length ? '저장 재시도 대기' : '이어가기 대기'); this.pump();
  }
  pump() {
    if (!this.accepting) return;
    for (const source of Object.keys(labels)) {
      if (this.running.has(source)) continue;
      const job = [...this.state.jobs].reverse().find(entry => entry.tasks[source]?.state === 'queued' && this.tokens.has(entry.id));
      if (!job) continue;
      const task = job.tasks[source];
      if (source === 'naver' && !isSupervised(job) && !task.items.length && !task.resumeExisting) this.reuseCachedNaver(job, task);
      // Keep a paused site's window/session untouched; unrelated sites are independent.
      if (!task.items.length && this.state.jobs.some(entry => entry.id !== job.id && entry.tasks[source] && WAITING.has(entry.tasks[source].state))) continue;
      const intervalAt = this.state.nextNaverSearchAt || this.state.lastNaverSearch + this.interval;
      const nextAt = source === 'naver' ? Math.max(intervalAt, this.state.naverBlockedUntil || 0) : intervalAt;
      if (source === 'naver' && !isSupervised(job) && !task.items.length && !task.resumeExisting && this.now() < nextAt) {
        if (task.nextAt !== nextAt) {
          task.nextAt = nextAt;
          task.message = nextAt === this.state.naverBlockedUntil ? '네이버 접근 제한 후 24시간 휴식' : '네이버 신규 검색 최소 1시간 대기';
          this.persist();
        }
        continue;
      }
      this.running.add(source);
      void this.run(job, source).catch(error => {
        if (!TERMINAL.has(task.state)) this.change(job, task, 'failed', error.message || '수집 오류');
      }).finally(() => { this.controllers.delete(`${job.id}:${source}`); this.running.delete(source); this.pump(); });
    }
  }
  async run(job, source) {
    const task = job.tasks[source]; task.nextAt = null;
    const controller = new AbortController(); this.controllers.set(`${job.id}:${source}`, controller);
    const interrupted = () => !this.accepting || TERMINAL.has(task.state) || task.state === 'interrupted';
    if (!task.items.length) {
      if (source === 'naver' && !isSupervised(job) && !task.resumeExisting) {
        const maximum = Math.max(this.interval, MAX_NAVER_INTERVAL);
        const scheduledDelay = Math.min(maximum, Math.max(this.interval, Number(this.randomDelay()) || this.interval));
        this.state.lastNaverSearch = this.now();
        this.state.nextNaverSearchAt = this.state.lastNaverSearch + scheduledDelay;
      }
      this.change(job, task, 'loading', isSupervised(job)
        ? `${labels[source]} 화면에서 “${job.query}” 검색을 준비합니다.`
        : source === 'naver' ? '네이버 신규 검색 1회를 준비합니다.' : `${labels[source]} 검색 화면을 준비합니다.`);
      const result = await this.driver.collect(job, source, {
        resume: Boolean(task.resumeExisting), cancelled: interrupted, token: this.tokens.get(job.id), signal: controller.signal,
        progress: (state, message) => {
          if (interrupted()) return;
          if (source === 'naver' && state === 'blocked') this.state.naverBlockedUntil = this.now() + NAVER_BLOCK_COOLDOWN;
          const notify = WAITING.has(state) && task.state !== state;
          this.change(job, task, state, message);
          if (notify) this.notify(job, source, message);
        },
      });
      if (interrupted() || result?.paused) return;
      task.resumeExisting = false;
      if (!result?.items?.length) { this.change(job, task, 'failed', '유효한 상품명·가격을 찾지 못했습니다. 원본 화면을 확인하세요.'); return; }
      task.items = result.items; task.pageUrl = result.pageUrl; task.warnings = result.warnings || [];
      this.persist(); // Checkpoint before any server write. Never store the app token.
    }
    this.change(job, task, 'saving', `${task.items.length}개 결과 저장 중`);
    try {
      await this.saveResult(job, source, this.tokens.get(job.id), controller.signal);
      if (interrupted()) return;
      task.completedAt = this.now();
      this.change(job, task, 'completed', task.cacheReused
        ? `${task.items.length}개 저장 결과 재사용 완료 · 새 요청 없음`
        : `${task.items.length}개 수집·저장 완료`);
    } catch {
      if (interrupted()) return;
      this.change(job, task, 'save_failed', '수집 결과는 보관했습니다. 연결·로그인을 확인하고 저장을 재시도하세요.');
      this.notify(job, source, task.message);
    }
  }
  shutdown() {
    this.accepting = false;
    for (const job of this.state.jobs) for (const [source, task] of Object.entries(job.tasks)) if (!TERMINAL.has(task.state)) {
      this.controllers.get(`${job.id}:${source}`)?.abort();
      this.driver.stop(job.id, source); task.state = 'interrupted'; task.message = '앱 종료로 일시정지 · 이어서 진행 가능';
    }
    this.tokens.clear(); this.persist();
  }
}
module.exports = { JobManager, TERMINAL, WAITING, MIN_NAVER_INTERVAL, MAX_NAVER_INTERVAL, NAVER_CACHE_TTL, NAVER_BLOCK_COOLDOWN };
