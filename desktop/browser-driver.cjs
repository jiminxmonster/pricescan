const path = require('node:path');
const { WebContentsView, session } = require('electron');
const { isShopUrl, findVisibleSearchInput, findVisibleNaverLowestSort, inspectShoppingPage } = require('./security.cjs');
const { clickVisibleTarget, submitVisibleSearch, scrollVisiblePage } = require('./native-search.cjs');
const { EmbeddedLayout } = require('./embedded-layout.cjs');
const parser = require('./parser.cjs');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const labels = { naver: '네이버', danawa: '다나와', enuri: '에누리', coupang: '쿠팡' };

function inspectScrollBoundary() {
  const root = document.scrollingElement || document.documentElement;
  const top = Math.max(0, Number(root?.scrollTop || window.scrollY || 0));
  const viewport = Math.max(0, Number(root?.clientHeight || window.innerHeight || 0));
  const height = Math.max(viewport, Number(root?.scrollHeight || document.body?.scrollHeight || 0));
  return { atTop: top <= 2, atBottom: top + viewport >= height - 3 };
}

// Runs in an isolated world. It returns product-card text and same-site links,
// never cookies, storage, input values, form values or screenshots.
function captureVisibleObservation(source, query) {
  const visible = element => {
    const rect = element?.getBoundingClientRect?.();
    const style = element ? getComputedStyle(element) : null;
    return Boolean(rect && rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0
      && rect.top < innerHeight && rect.left < innerWidth && style?.visibility !== 'hidden'
      && style?.display !== 'none' && Number(style?.opacity || 1) !== 0);
  };
  const links = []; const snippets = []; const seenUrls = new Set(); const seenText = new Set();
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (!visible(anchor)) continue;
    let url;
    try { url = new URL(anchor.href, location.href).href; } catch { continue; }
    if (!url.startsWith('https://') || seenUrls.has(url)) continue;
    const label = String(anchor.innerText || anchor.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 500);
    if (!label) continue;
    seenUrls.add(url); links.push({ text: label, url });
    let container = anchor;
    for (let depth = 0; depth < 5 && container?.parentElement; depth += 1) {
      container = container.parentElement;
      const text = String(container.innerText || '').replace(/\s+/g, ' ').trim();
      if (/\d[\d,]*\s*원/.test(text) && text.length >= label.length && text.length <= 1200) {
        if (!seenText.has(text)) { seenText.add(text); snippets.push(text); }
        break;
      }
    }
    if (links.length >= 100) break;
  }
  return {
    source, query, stage: 'results', page_url: location.href,
    page_title: String(document.title || '').slice(0, 500),
    visible_text: snippets.join('\n').slice(0, 14000), links,
  };
}

function decideNaverSort(sortTarget, { manual = false, clickAttempted = false, scrollCount = 0, timedOut = false } = {}) {
  if (sortTarget?.selected) return 'done';
  if (manual) return 'wait_for_user';
  if (sortTarget?.scroll && !clickAttempted && scrollCount < 8 && !timedOut) return `scroll_${sortTarget.scroll}`;
  if (sortTarget && !sortTarget.scroll && !clickAttempted) return 'click';
  if (clickAttempted || timedOut) return 'handoff';
  if (sortTarget?.scroll && scrollCount >= 8) return 'handoff';
  return 'wait';
}

function secureSession(source) {
  const ses = session.fromPartition(`persist:pricescan-${source}`);
  ses.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  ses.setPermissionCheckHandler(() => false);
  ses.on('will-download', event => event.preventDefault());
  return ses;
}
class BrowserDriver {
  constructor(mainWindow, { interpret } = {}) { this.windows = new Map(); this.sessions = new Map(); this.captureWaiters = new Map(); this.desiredScroll = null; this.quitting = false; this.layout = new EmbeddedLayout(mainWindow); this.interpret = interpret; }
  key(jobId, source) { return `${jobId}:${source}`; }
  has(jobId, source) { const entry = this.windows.get(this.key(jobId, source)); return Boolean(entry && !entry.stopped && !entry.controls.webContents.isDestroyed() && !entry.view.webContents.isDestroyed() && !entry.view.webContents.isCrashed()); }
  create(job, source) {
    if (this.has(job.id, source)) return this.windows.get(this.key(job.id, source));
    this.stop(job.id, source);
    if (!this.sessions.has(source)) this.sessions.set(source, secureSession(source));
    const controls = new WebContentsView({ webPreferences: {
      preload: path.join(__dirname, 'controls-preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
    } });
    const view = new WebContentsView({ webPreferences: {
      session: this.sessions.get(source), contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false,
    } });
    const entry = { controls, view, jobId: job.id, source, query: job.query, stopped: false, visible: false,
      captureReady: false, state: 'loading', title: `${labels[source]} · ${job.query}`, message: '전용 브라우저 준비 중', url: '' };
    this.windows.set(this.key(job.id, source), entry);
    if (this.desiredScroll?.jobId === job.id) this.showScroll(job.id, this.desiredScroll.sources, this.desiredScroll.sources[this.desiredScroll.index]);
    this.protect(view.webContents, source);
    view.webContents.on('did-navigate', (_event, url) => this.handleNavigation(entry, url));
    view.webContents.on('did-navigate-in-page', (_event, url) => this.handleNavigation(entry, url));
    view.webContents.on('render-process-gone', () => { entry.stopped = true; entry.message = '브라우저가 중단되었습니다. 작업 목록에서 다시 진행해 주세요.'; this.render(entry); });
    view.webContents.on('before-mouse-event', (_event, input) => {
      const delta = Number(input?.deltaY || input?.wheelTicksY || 0);
      if (input?.type !== 'mouseWheel' || Math.abs(delta) < 1 || Date.now() - Number(entry.lastEdgeScrollAt || 0) < 600) return;
      void this.evaluate(entry, inspectScrollBoundary, []).then(boundary => {
        if ((delta > 0 && boundary.atBottom) || (delta < 0 && boundary.atTop)) {
          entry.lastEdgeScrollAt = Date.now();
          try { this.scroll(entry.jobId, delta > 0 ? 'down' : 'up'); } catch { /* the adjacent worker may still be loading */ }
        }
      }).catch(() => {});
    });
    controls.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    controls.webContents.on('will-navigate', event => event.preventDefault());
    controls.webContents.on('did-finish-load', () => this.render(entry));
    void controls.webContents.loadFile(path.join(__dirname, 'controls.html'));
    return entry;
  }
  protect(contents, source) {
    for (const name of ['will-navigate', 'will-redirect']) contents.on(name, (event, url) => {
      if (!isShopUrl(source, url || event.url)) event.preventDefault();
    });
    // Marketplace popups stay in the same embedded shopping view.
    contents.setWindowOpenHandler(({ url }) => {
      if (isShopUrl(source, url)) void contents.loadURL(url).catch(() => {});
      return { action: 'deny' };
    });
  }
  handleNavigation(entry, url) {
    const changed = Boolean(entry.url && entry.url !== url);
    entry.url = url;
    if (changed && entry.captureReady) {
      entry.state = 'loading';
      entry.message = '페이지 변경 확인 중 · 최저가 정렬과 검색 결과를 다시 확인합니다.';
      const key = this.key(entry.jobId, entry.source);
      const waiter = this.captureWaiters.get(key);
      if (waiter) { this.captureWaiters.delete(key); waiter('changed'); }
    }
    this.renderJob(entry.jobId);
  }
  controlState(entry) {
    const navigation = this.desiredScroll?.jobId === entry.jobId ? this.desiredScroll : null;
    const sources = navigation?.sources || [entry.source];
    const index = Math.max(0, sources.indexOf(entry.source));
    const sourceStates = sources.map(source => {
      const candidate = this.windows.get(this.key(entry.jobId, source));
      return { source, label: labels[source], state: candidate?.state || 'loading', ready: Boolean(candidate?.captureReady) };
    });
    const collectingCount = sourceStates.filter(item => item.state === 'reading').length;
    return {
      title: entry.title, message: entry.message, url: entry.url, jobId: entry.jobId, source: entry.source, state: entry.state,
      canGoBack: !entry.view.webContents.isDestroyed() && entry.view.webContents.navigationHistory.canGoBack(),
      scroll: { index, total: sources.length, isFirst: index === 0, isLast: index === sources.length - 1,
        readyCount: sourceStates.filter(item => item.ready).length, allReady: sourceStates.every(item => item.ready),
        collectingCount, collecting: collectingCount > 0, sources: sourceStates },
    };
  }
  back(jobId, source) {
    const entry = this.windows.get(this.key(jobId, source));
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error('열린 쇼핑몰 화면이 없습니다.');
    if (!entry.view.webContents.navigationHistory.canGoBack()) throw new Error('돌아갈 검색결과 화면이 없습니다.');
    entry.state = 'loading';
    entry.message = '이전 검색결과 화면으로 돌아가는 중입니다.';
    entry.captureReady = false;
    entry.view.webContents.navigationHistory.goBack();
    this.renderJob(jobId);
    return { ok: true };
  }
  render(entry) {
    if (!entry.controls.webContents.isDestroyed()) entry.controls.webContents.send('desktop:controls', this.controlState(entry));
  }
  renderJob(jobId) {
    for (const entry of this.windows.values()) if (entry.jobId === jobId) this.render(entry);
  }
  senderContext(sender) { return [...this.windows.values()].find(entry => entry.controls.webContents === sender); }
  focus(jobId, source) {
    const entry = this.windows.get(this.key(jobId, source));
    if (!entry || entry.view.webContents.isDestroyed()) throw new Error('열린 화면이 없습니다. 이어서 진행을 눌러 주세요.');
    this.layout.show(entry);
  }
  showScroll(jobId, sources = Object.keys(labels), source) {
    const ordered = [...sources];
    const previous = this.desiredScroll?.jobId === jobId ? this.desiredScroll : null;
    const requestedIndex = source ? ordered.indexOf(source) : previous?.index ?? 0;
    const index = Math.max(0, Math.min(ordered.length - 1, requestedIndex < 0 ? 0 : requestedIndex));
    this.desiredScroll = { jobId, sources: ordered, index };
    const entry = this.windows.get(this.key(jobId, ordered[index])) || ordered.map(candidate => this.windows.get(this.key(jobId, candidate))).find(Boolean);
    if (entry) this.layout.show(entry);
    this.renderJob(jobId);
    return { source: entry?.source || ordered[index], index, total: ordered.length };
  }
  scroll(jobId, direction) {
    const navigation = this.desiredScroll;
    if (!navigation || navigation.jobId !== jobId) throw new Error('스크롤 수집 화면을 다시 열어 주세요.');
    const step = direction === 'up' ? -1 : direction === 'down' ? 1 : 0;
    if (!step) throw new Error('스크롤 방향이 올바르지 않습니다.');
    const index = Math.max(0, Math.min(navigation.sources.length - 1, navigation.index + step));
    const source = navigation.sources[index];
    const entry = this.windows.get(this.key(jobId, source));
    if (!entry) throw new Error(`${labels[source]} 화면을 준비하고 있습니다. 잠시 후 다시 스크롤해 주세요.`);
    navigation.index = index;
    this.layout.show(entry);
    this.renderJob(jobId);
    return { source, index, total: navigation.sources.length };
  }
  hideScroll(jobId) {
    const visible = this.layout.active && (!jobId || this.layout.active.jobId === jobId);
    if (!jobId || this.desiredScroll?.jobId === jobId) this.desiredScroll = null;
    if (visible) this.layout.hide();
  }
  captureAll(jobId) {
    let ready = 0;
    for (const entry of this.windows.values()) {
      if (entry.jobId !== jobId || entry.stopped || !entry.captureReady) continue;
      ready += 1;
      entry.state = 'reading';
      entry.message = '현재 화면의 상품명과 가격을 읽기 시작합니다.';
      const waiter = this.captureWaiters.get(this.key(jobId, entry.source));
      if (waiter) { this.captureWaiters.delete(this.key(jobId, entry.source)); waiter(true); }
    }
    this.renderJob(jobId);
    return ready;
  }
  waitForCapture(entry, stopped) {
    if (stopped()) return Promise.resolve(false);
    entry.captureReady = true;
    this.renderJob(entry.jobId);
    return new Promise(resolve => {
      this.captureWaiters.set(this.key(entry.jobId, entry.source), value => {
        entry.captureReady = false;
        this.renderJob(entry.jobId);
        resolve(value);
      });
    });
  }
  hide(jobId, source) {
    const entry = this.windows.get(this.key(jobId, source));
    if (entry) this.layout.hide(entry);
  }
  hideActive() { this.desiredScroll = null; this.layout.hide(); }
  minimize() { this.layout.minimize(); }
  stop(jobId, source) {
    const entry = this.windows.get(this.key(jobId, source));
    if (!entry) return;
    const waiter = this.captureWaiters.get(this.key(jobId, source));
    if (waiter) { this.captureWaiters.delete(this.key(jobId, source)); waiter(false); }
    entry.stopped = true;
    if (this.desiredScroll?.jobId === jobId && this.desiredScroll.sources.length === 1) this.desiredScroll = null;
    this.layout.hide(entry);
    if (!entry.view.webContents.isDestroyed()) entry.view.webContents.close();
    if (!entry.controls.webContents.isDestroyed()) entry.controls.webContents.close();
    this.windows.delete(this.key(jobId, source));
  }
  async evaluate(entry, fn, args) {
    if (entry.view.webContents.isDestroyed()) throw new Error('수집 창이 닫혔습니다.');
    let timer;
    try {
      return await Promise.race([
        entry.view.webContents.executeJavaScriptInIsolatedWorld(1004, [{ code: `(${fn.toString()})(...${JSON.stringify(args)})` }]),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('화면 읽기 제한시간을 초과했습니다.')), 25000); }),
      ]);
    } finally { clearTimeout(timer); }
  }
  async collect(job, source, controls) {
    const entry = this.create(job, source); entry.stopped = false;
    const captureLimit = 10;
    const progress = (state, message) => { entry.state = state; entry.message = message; this.render(entry); controls.progress(state, message); };
    const stopped = () => controls.cancelled() || entry.stopped || entry.view.webContents.isDestroyed();
    if (!controls.resume) {
      entry.checkedDanawaDetail = false;
      entry.naverSearchSubmitted = false;
      entry.naverLowestSortApplied = false;
      entry.naverLowestSortClickAttempted = false;
      entry.naverLowestSortScrollCount = 0;
      entry.naverLowestSortStartedAt = 0;
      const definition = parser.SOURCE_DEFINITIONS[source];
      const url = source === 'naver' ? definition.landingUrl : definition.searchUrl(job.query, job.sortMode);
      if (!isShopUrl(source, url)) throw new Error('허용되지 않은 검색 주소입니다.');
      // Do not await a potentially stalled network navigation forever; readiness has its own deadline.
      entry.loadError = '';
      void entry.view.webContents.loadURL(url).catch(error => { if (error.code !== 'ERR_ABORTED') entry.loadError = '검색 화면을 열지 못했습니다. 연결을 확인하세요.'; });
    }
    const started = Date.now(); let stableSince = 0; let readyCount = 0; let lastHumanState = ''; let lastMessage = '';
    while (!stopped()) {
      if (entry.loadError) throw new Error(entry.loadError);
      let inspection;
      try {
        if (!isShopUrl(source, entry.view.webContents.getURL())) { await delay(1000); if (Date.now() - started > 45000) throw new Error('검색 페이지 준비 시간이 초과되었습니다.'); continue; }
        inspection = await this.evaluate(entry, inspectShoppingPage, [source, job.query]);
      } catch (error) {
        if (stopped()) return { paused: true };
        if (Date.now() - started > 45000) throw error;
        await delay(1000); continue;
      }
      const state = inspection.state;
      if (state === 'blocked') { progress('blocked', `${labels[source]} 접속 제한 · 현재 화면을 확인한 뒤 이어서 진행하거나, 준비된 다른 쇼핑몰을 먼저 완료하세요.`); return { paused: true }; }
      if (source === 'naver' && state === 'needs_page' && !entry.naverSearchSubmitted) {
        const target = await this.evaluate(entry, findVisibleSearchInput, []);
        if (target) {
          progress('loading', '보이는 네이버 쇼핑 검색창에 검색어를 입력하고 있습니다.');
          await submitVisibleSearch(entry.view.webContents, target, job.query);
          entry.naverSearchSubmitted = true;
          entry.naverLowestSortStartedAt = 0;
          stableSince = 0; readyCount = 0; lastHumanState = ''; lastMessage = '';
          await delay(1200); continue;
        }
      }
      if (['needs_login', 'needs_verification', 'needs_page'].includes(state)) {
        stableSince = 0; readyCount = 0;
        const message = state === 'needs_login' ? `${labels[source]} 로그인이 필요합니다. 프로그램 안의 수집 화면에서 직접 로그인하세요.`
          : state === 'needs_verification' ? '보안확인이 필요합니다. 프로그램 안의 수집 화면에서 직접 처리하면 자동으로 이어갑니다.'
            : `검색 화면 확인 필요 · 프로그램 안에서 “${job.query}” 쇼핑 검색 결과를 열어 주세요.`;
        if (lastHumanState !== state) { progress(state, message); lastHumanState = state; lastMessage = message; }
        if (Date.now() - started > 30 * 60000) { progress('interrupted', '사용자 확인 대기로 일시정지했습니다. 이어서 진행할 수 있습니다.'); return { paused: true }; }
        await delay(2500); continue;
      }
      if (state !== 'ready') { if (!lastHumanState && Date.now() - started > 45000) throw new Error('검색 화면 로딩 시간이 초과되었습니다.'); await delay(1500); continue; }
      if (source === 'naver' && job.sortMode === 'lowest' && !entry.naverLowestSortApplied) {
        if (!entry.naverLowestSortStartedAt) entry.naverLowestSortStartedAt = Date.now();
        const sortTarget = await this.evaluate(entry, findVisibleNaverLowestSort, []);
        const sortAction = decideNaverSort(sortTarget, {
          manual: job.captureMode === 'manual_scroll',
          clickAttempted: entry.naverLowestSortClickAttempted,
          scrollCount: entry.naverLowestSortScrollCount,
          timedOut: Date.now() - entry.naverLowestSortStartedAt > 60000,
        });
        if (sortAction === 'done') {
          entry.naverLowestSortApplied = true;
        } else if (sortAction === 'wait_for_user') {
          progress('needs_sort', '네이버 화면에서 “낮은 가격순”을 눌러 주세요. 적용되면 자동으로 준비 완료됩니다.');
          stableSince = 0; readyCount = 0;
          await delay(1500); continue;
        } else if (sortAction === 'click') {
          progress('loading', '네이버 낮은 가격순을 한 번 선택하고 있습니다.');
          await clickVisibleTarget(entry.view.webContents, sortTarget);
          entry.naverLowestSortClickAttempted = true;
          stableSince = 0; readyCount = 0; lastHumanState = ''; lastMessage = '';
          await delay(1200); continue;
        } else if (sortAction === 'scroll_down' || sortAction === 'scroll_up') {
          const direction = sortAction === 'scroll_up' ? 'up' : 'down';
          progress('loading', '네이버 낮은 가격순 버튼이 보이도록 결과 화면을 이동하고 있습니다.');
          await scrollVisiblePage(entry.view.webContents, direction);
          entry.naverLowestSortScrollCount += 1;
          stableSince = 0; readyCount = 0; lastHumanState = ''; lastMessage = '';
          await delay(700); continue;
        } else if (sortAction === 'handoff') {
          progress('needs_page', '낮은 가격순 버튼을 찾지 못했습니다. 화면에서 한 번 선택한 뒤 이어서 진행해 주세요.');
          return { paused: true };
        } else {
          await delay(1500); continue;
        }
      }
      if (!stableSince) stableSince = Date.now();
      readyCount += 1;
      if (readyCount < 2 || Date.now() - stableSince < parser.SOURCE_DEFINITIONS[source].waitMs) { await delay(1500); continue; }
      if (source === 'danawa' && !entry.checkedDanawaDetail) {
        entry.checkedDanawaDetail = true;
        const detailUrl = await this.evaluate(entry, parser.selectDanawaDetailUrl, [job.query]);
        if (detailUrl && isShopUrl(source, detailUrl)) {
          await entry.view.webContents.loadURL(detailUrl);
          stableSince = 0; readyCount = 0; continue;
        }
      }
      const manualCapture = ['manual_scroll', 'manual_grid'].includes(job.captureMode);
      if (manualCapture) {
        progress('ready_to_capture', source === 'naver'
          ? '현재 검색결과 수집 준비 완료 · “가격비교 더 보기”로 들어가지 않아도 됩니다.'
          : '현재 화면 준비 완료 · 상단 작업바를 스크롤해 다음 쇼핑몰을 확인하세요.');
        const captureSignal = await this.waitForCapture(entry, stopped);
        if (captureSignal === 'changed') {
          stableSince = 0; readyCount = 0; lastHumanState = ''; lastMessage = '';
          continue;
        }
        if (!captureSignal) return { paused: true };
      }
      if (stopped()) return { paused: true };
      const readingMessage = source === 'naver' ? `상품명과 가격을 최대 ${captureLimit}개 읽는 중` : '상품명과 가격을 읽는 중';
      if (lastMessage !== readingMessage) { progress('reading', readingMessage); lastMessage = readingMessage; }
      if (job.captureMode === 'ai_supervised') {
        if (typeof this.interpret !== 'function') throw new Error('AI 화면 판독 연결이 준비되지 않았습니다.');
        progress('reading', `AI가 현재 ${labels[source]} 상품 목록의 가격 순위와 링크를 판독하고 있습니다.`);
        const observation = await this.evaluate(entry, captureVisibleObservation, [source, job.query]);
        const interpreted = await this.interpret(controls.token, observation, controls.signal);
        if (stopped()) return { paused: true };
        const after = await this.evaluate(entry, inspectShoppingPage, [source, job.query]);
        if (after.state !== 'ready') { lastHumanState = ''; stableSince = 0; continue; }
        if (interpreted?.needs_user) {
          progress('needs_page', interpreted.message || 'AI가 확실한 가격을 판독하지 못했습니다. 현재 화면을 확인해 주세요.');
          return { paused: true };
        }
        const items = (interpreted?.items || []).slice(0, captureLimit).map(item => {
          const shippingKnown = Number.isInteger(item.shipping) && item.shipping >= 0;
          const shipping = shippingKnown ? item.shipping : 0;
          return { ...item, source, shipping, total: Number(item.price || 0) + shipping,
            extraction_methods: ['ai_visible_page', ...(shippingKnown ? [] : ['shipping_unknown'])] };
        });
        return { items, pageUrl: observation.page_url, warnings: [] };
      }
      const result = await this.evaluate(entry, parser.captureVisibleShoppingProducts, [source, captureLimit, job.query]);
      if (stopped()) return { paused: true };
      // Challenge can appear between readiness and capture. Never accept those results.
      const after = await this.evaluate(entry, inspectShoppingPage, [source, job.query]);
      if (after.state !== 'ready') { lastHumanState = ''; stableSince = 0; continue; }
      if (result.items?.length) return result;
      if (Date.now() - stableSince > 30000) return result;
      await delay(2500);
    }
    return { paused: true };
  }
  openLogin() {
    const entry = this.create({ id: 'login', query: '로그인 유지 설정' }, 'naver');
    entry.message = '프로그램 안에서 네이버에 직접 로그인하세요. 로그인 정보는 이 앱의 전용 세션에만 보관됩니다.';
    void entry.view.webContents.loadURL('https://nid.naver.com/nidlogin.login').catch(() => {});
    this.focus('login', 'naver'); this.render(entry);
  }
}
module.exports = { BrowserDriver, captureVisibleObservation, decideNaverSort };
