/* Persistent supervised autopilot. It advances once per loaded page and never
   reloads, retries a blocked page, solves verification, or reads credentials. */
(() => {
  const Flow = globalThis.PriceScanApprovalFlow;
  const KEY = 'pricescanApprovalJob';
  let locked = false;
  const autoRuns = new Set();
  let idleWaiters = [];
  const internal = sender => sender.id === chrome.runtime.id && String(sender.url || '').startsWith(chrome.runtime.getURL(''));
  const fromApp = sender => sender.id === chrome.runtime.id && Boolean(Flow.appUrl(sender.url));
  const originsFor = sourceIds => [...new Set(sourceIds.flatMap(id => Flow.sources.find(source => source.id === id)?.hosts || [])
    .map(host => `https://${host}/*`))];
  const readJob = async () => (await chrome.storage.local.get(KEY))[KEY] || null;
  const save = async job => { await chrome.storage.local.set({ [KEY]: job }); return job; };
  function apiBase(returnUrl) {
    const app = Flow.appUrl(returnUrl);
    if (!app) throw new Error('PriceScan 서버 주소를 확인하지 못했습니다.');
    return `${app.replace(/\/$/, '')}/api/seller-products`;
  }
  async function serverRequest(job, path, body) {
    if (!job.apiToken) throw new Error('PriceScan 로그인이 만료되었습니다. 다시 로그인한 뒤 검색해 주세요.');
    const response = await fetch(`${job.apiBase}${path}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${job.apiToken}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw new Error(typeof data.detail === 'string' ? data.detail : 'PriceScan AI 서버에 연결하지 못했습니다.');
    }
    return response.json();
  }
  async function exclusive(fn) {
    if (locked) throw new Error('현재 승인을 처리 중입니다. 잠시 기다려 주세요.');
    locked = true;
    try { return await fn(); } finally {
      locked = false;
      const waiters = idleWaiters; idleWaiters = []; waiters.forEach(resolve => resolve());
    }
  }
  async function getJob() {
    const job = await readJob();
    // A terminated service worker must never replay a half-finished navigation.
    if (job?.busy && !locked) { job.busy = false; job.message = '중단된 작업을 복원했습니다. 현재 탭을 확인한 뒤 승인해 주세요.'; await save(job); }
    return job;
  }
  async function start(message, sender) {
    return exclusive(async () => {
      const existing = await readJob();
      if (existing && !['completed', 'cancelled'].includes(existing.stage)) throw new Error('진행 중인 승인 수집이 있습니다. 확장 프로그램에서 이어서 진행하거나 중단해 주세요.');
      const pending = (await chrome.storage.local.get('pricescanPendingCapture')).pricescanPendingCapture;
      if (pending?.mode === 'supervised_ai') throw new Error('아직 PriceScan에 반영하지 않은 AI 검색 결과가 있습니다. 먼저 반영해 주세요.');
      if (pending) await chrome.storage.local.remove('pricescanPendingCapture');
      const base = apiBase(sender.url);
      const config = await serverRequest({ apiBase: base, apiToken: String(message.token || '') }, '/assistant/collection-config');
      if (!config?.configured || config?.legacy_parser_fallback !== false) throw new Error('서버 AI 검색 연결이 필요합니다. 관리자설정에서 AI API 키와 모델을 확인해 주세요.');
      return save(Flow.create({ id: crypto.randomUUID(), query: message.query, returnUrl: sender.url,
        productId: String(message.productId || ''), selectedSources: message.sources, sourceQueries: message.sourceQueries,
        appTabId: sender.tab.id, windowId: sender.tab.windowId, recipes: config.sources,
        apiBase: base, apiToken: String(message.token || ''), protocolVersion: config.protocol_version,
        mergeRunId: String(message.mergeRunId || '') }));
    });
  }
  function sameProduct(actual, expected) {
    try {
      const a = new URL(actual), b = new URL(expected);
      if (a.hostname !== b.hostname || a.pathname.replace(/\/$/, '') !== b.pathname.replace(/\/$/, '')) return false;
      return ['pcode', 'modelno', 'itemId', 'vendorItemId', 'productId', 'nvMid'].every(key => !b.searchParams.has(key) || a.searchParams.get(key) === b.searchParams.get(key));
    } catch { return false; }
  }
  async function inspect(job) {
    const tab = await chrome.tabs.get(job.tabId).catch(() => null);
    if (!tab) throw new Error('작업 탭이 닫혔습니다. 이 쇼핑몰을 건너뛰거나 새 수집을 시작하세요.');
    if (!tab.active || tab.status === 'loading') throw new Error('작업 탭을 열고 화면 로딩이 끝난 뒤 승인해 주세요.');
    const source = Flow.current(job).id;
    if (!Flow.safeUrl(tab.url, source)) throw new Error('해당 쇼핑몰의 검색·상품 화면으로 돌아온 뒤 승인하세요. 로그인·결제 화면은 읽지 않습니다.');
    if (source === 'naver' && job.stage === 'detail_review' && tab.url !== job.pageUrls.naver) {
      throw new Error('읽어 둔 네이버 화면과 주소가 다릅니다. 원래 탭으로 돌아온 뒤 승인하세요.');
    }
    if (source !== 'naver' && ['detail', 'detail_review'].includes(job.stage) && !sameProduct(tab.url, job.queue[job.detailIndex].url)) {
      throw new Error('선택한 상품과 다른 주소입니다. 뒤로 가기로 선택 상품에 돌아오거나 이 상품을 건너뛰세요.');
    }
    await chrome.scripting.executeScript({ target: { tabId: job.tabId }, files: ['agent-observer.js'] });
    const [result] = await chrome.scripting.executeScript({ target: { tabId: job.tabId },
      func: () => globalThis.PriceScanAgentObserver.observe() });
    const raw = result?.result || {};
    if (raw.local_blocked) return { blocked: true, needs_user: true, message: '보안 확인 화면입니다. 사용자가 직접 완료한 뒤 이어서 진행해 주세요.', items: [] };
    const observation = await serverRequest(job, '/assistant/observe', {
      source, query: job.sourceQueries?.[source] || job.query,
      stage: source === 'naver' || job.stage === 'results' ? 'results' : job.stage,
      page_url: raw.page_url, page_title: raw.page_title,
      visible_text: raw.visible_text, links: raw.links,
    });
    if (source === 'naver' && job.stage === 'detail_review' && !observation.blocked) {
      const selected = job.queue[job.detailIndex];
      const found = observation.items?.find(item => item.url === selected.url && item.mall === selected.mall && item.name === selected.name);
      if (!found || found.price !== selected.price || found.shipping !== selected.shipping) throw new Error('선택한 판매처·옵션·가격이 화면에서 달라졌습니다. 잘못 저장하지 않도록 멈췄습니다. 이 항목을 제외하거나 새 수집을 시작하세요.');
    }
    return observation;
  }
  async function waitForReady(tabId, timeoutMs = 30000) {
    const current = await chrome.tabs.get(tabId).catch(() => null);
    if (!current) throw new Error('조사 탭이 닫혔습니다.');
    if (current.status === 'complete') return current;
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { cleanup(); reject(new Error('페이지 로딩이 오래 걸립니다. 화면을 확인해 주세요.')); }, timeoutMs);
      const listener = (changedId, info) => {
        if (changedId === tabId && info.status === 'complete') { cleanup(); resolve(); }
      };
      const cleanup = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(listener); };
      chrome.tabs.onUpdated.addListener(listener);
    });
    return chrome.tabs.get(tabId);
  }
  async function markAttention(id, reason) {
    return exclusive(async () => {
      const job = await readJob();
      if (!job || job.id !== id || ['completed', 'cancelled', 'awaiting_import'].includes(job.stage)) return job;
      job.autoRunning = false;
      job.attention = true;
      job.message = reason || '현재 화면을 직접 확인한 뒤 다시 시작해 주세요.';
      await save(job);
      return job;
    });
  }
  async function returnToApp(job) {
    const tab = job.appTabId ? await chrome.tabs.get(job.appTabId).catch(() => null) :
      (await chrome.tabs.query({ windowId: job.windowId })).find(tab => Flow.appUrl(tab.url) === job.returnUrl);
    if (tab && Flow.appUrl(tab.url) === job.returnUrl) {
      job.appTabId = tab.id;
      await chrome.tabs.update(tab.id, { active: true });
      await chrome.tabs.sendMessage(tab.id, { type: 'PRICESCAN_CAPTURE_AVAILABLE' }).catch(() => undefined);
    } else {
      const created = await chrome.tabs.create({ url: job.returnUrl, windowId: job.windowId });
      job.appTabId = created.id;
    }
  }
  async function approve(message) {
    return exclusive(async () => {
      const previous = await getJob();
      if (!previous || previous.id !== message.id || previous.revision !== message.revision || previous.busy) throw new Error('현재 단계를 다시 확인해 주세요. 중복 승인은 실행하지 않았습니다.');
      // Validate gesture revision before any DOM reads or external side effects.
      let observation = {};
      if (message.action === 'approve' && ['results', 'detail', 'detail_review'].includes(previous.stage)) observation = await inspect(previous);
      const { job, effect } = Flow.transition(previous, message, observation);
      job.busy = true;
      await save(job); // checkpoint precedes every navigation / publish
      try {
        if (effect.navigate) {
          const url = Flow.safeUrl(effect.navigate, Flow.current(job).id);
          if (!url) throw new Error('지원하지 않는 상품 링크입니다.');
          const existing = job.tabId && !job.borrowedTab ? await chrome.tabs.get(job.tabId).catch(() => null) : null;
          const tab = existing ? await chrome.tabs.update(job.tabId, { url, active: true })
            : await chrome.tabs.create({ url, windowId: job.windowId, active: true });
          job.tabId = tab.id;
          job.borrowedTab = false;
        }
        if (effect.publish) {
          job.apiToken = '';
          await chrome.storage.local.set({ pricescanPendingCapture: effect.publish });
          await returnToApp(job);
        } else if (effect.returnToApp) await returnToApp(job);
      } catch (error) {
        job.message = `${error.message || error} 자동으로 재시도하지 않습니다.`;
      } finally { job.busy = false; await save(job); }
      return job;
    });
  }
  function automaticInput(job) {
    const base = { id: job.id, revision: job.revision, action: 'approve' };
    if (job.stage === 'results') return { ...base, acceptVisibleLowest: true };
    if (job.stage === 'candidates') return { ...base, selected: [0] };
    if (job.stage === 'detail_review') {
      const review = Flow.reviewValues(job);
      if (!Number.isSafeInteger(review.price) || review.price <= 0 || !Number.isSafeInteger(review.shipping) || review.shipping < 0) {
        throw new Error('가격 또는 배송비를 확실히 읽지 못했습니다. 원본에서 확인한 값을 입력해 주세요.');
      }
      return { ...base, confirmDetail: true, review };
    }
    return base;
  }
  async function autorun(message) {
    const initial = await getJob();
    if (!initial || initial.id !== message.id || initial.revision !== message.revision) throw new Error('현재 AI 조사 단계를 다시 확인해 주세요.');
    if (autoRuns.has(initial.id)) return initial;
    autoRuns.add(initial.id);
    try {
      await exclusive(async () => {
        const job = await readJob();
        if (!job || job.id !== initial.id) throw new Error('진행 중인 조사를 찾지 못했습니다.');
        job.autoRunning = true; job.attention = false; job.message = 'AI가 현재 화면에서 확인 가능한 최저가 후보를 조사하고 있습니다.';
        await save(job);
      });
      for (let step = 0; step < 48; step++) {
        let job = await getJob();
        if (!job || job.id !== initial.id || ['completed', 'cancelled'].includes(job.stage)) return job;
        if (job.stage === 'awaiting_import') {
          job = await approve(automaticInput(job));
          job.autoRunning = false; await save(job); return job;
        }
        if (['results', 'detail'].includes(job.stage)) await waitForReady(job.tabId);
        job = await approve(automaticInput(job));
        if (job.message) throw new Error(job.message);
        if (['results', 'detail'].includes(job.stage) && job.tabId) await waitForReady(job.tabId);
      }
      throw new Error('안전 진행 횟수를 초과했습니다. 현재 화면을 확인해 주세요.');
    } catch (error) {
      return markAttention(initial.id, error.message || String(error));
    } finally { autoRuns.delete(initial.id); }
  }
  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (!message?.type?.startsWith('PRICESCAN_APPROVAL_')) return false;
    let promise;
    if (message.type === 'PRICESCAN_APPROVAL_START' && fromApp(sender) && sender.tab) {
      if (!Array.isArray(message.sources) || !message.sources.length) {
        respond({ ok: false, error: '가격을 조사할 쇼핑몰을 하나 이상 선택해 주세요.' });
        return false;
      }
      // Opening a side panel needs an actual browser user gesture. If the web-page
      // gesture has expired, preparation still succeeds; the toolbar icon opens it.
      const opened = chrome.sidePanel.open({ windowId: sender.tab.windowId }).then(() => true).catch(() => false);
      promise = start(message, sender).then(async job => {
        const panelOpened = await opened;
        const autoStarted = chrome.permissions?.contains
          ? await chrome.permissions.contains({ origins: originsFor(job.sources) }).catch(() => false)
          : false;
        if (autoStarted) void autorun({ id: job.id, revision: job.revision });
        return { job, panelOpened, autoStarted };
      });
    } else if (message.type === 'PRICESCAN_APPROVAL_GET' && internal(sender)) promise = getJob().then(job => ({ job }));
    else if (message.type === 'PRICESCAN_APPROVAL_ACT' && internal(sender)) promise = approve(message).then(job => ({ job }));
    else if (message.type === 'PRICESCAN_APPROVAL_AUTORUN' && internal(sender)) promise = autorun(message).then(job => ({ job }));
    else return false;
    promise.then(value => respond({ ok: true, ...value })).catch(error => respond({ ok: false, error: error.message || String(error) }));
    return true;
  });
  globalThis.PriceScanApprovalRuntime = { fromApp, internal, sameProduct, automaticInput, acknowledge: async id => {
    while (locked) await new Promise(resolve => idleWaiters.push(resolve));
    const job = await readJob();
    if (job?.id === id && job.stage === 'awaiting_import') { job.stage = 'completed'; job.revision++; await save(job); }
  } };
})();
