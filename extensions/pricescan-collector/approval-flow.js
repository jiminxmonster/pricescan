/* Shared, side-effect-free approval state machine. No timers or network requests. */
(() => {
  const sources = [
    { id: 'naver', label: '네이버', hosts: ['shopping.naver.com', 'search.shopping.naver.com', 'smartstore.naver.com', 'brand.naver.com'], search: q => `https://search.shopping.naver.com/ns/search?query=${encodeURIComponent(q)}` },
    { id: 'danawa', label: '다나와', hosts: ['search.danawa.com', 'prod.danawa.com'], search: q => `https://search.danawa.com/dsearch.php?query=${encodeURIComponent(q)}` },
    { id: 'enuri', label: '에누리', hosts: ['www.enuri.com', 'enuri.com'], search: q => `https://www.enuri.com/search.jsp?keyword=${encodeURIComponent(q)}` },
    { id: 'coupang', label: '쿠팡', hosts: ['www.coupang.com'], search: q => `https://www.coupang.com/np/search?q=${encodeURIComponent(q)}` },
  ];
  function safeUrl(value, source) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password
        && sources.find(s => s.id === source)?.hosts.includes(url.hostname)
        && !/(?:login|signin|checkout|order|payment)/i.test(url.pathname) ? url.href : '';
    } catch { return ''; }
  }
  function appUrl(value) {
    try {
      const url = new URL(value);
      return ((url.origin === 'https://pricescan.d2blue.com')
        || ['http://localhost:8300', 'http://127.0.0.1:8300'].includes(url.origin))
        && url.pathname.startsWith('/pricescan/') ? `${url.origin}/pricescan/` : '';
    } catch { return ''; }
  }
  // Seller redirects are saved as links only, never visited or granted script access.
  function offerUrl(value, source) {
    const ordinary = safeUrl(value, source);
    if (ordinary || source !== 'naver') return ordinary;
    try {
      const url = new URL(value);
      return url.protocol === 'https:' && !url.username && !url.password
        && url.hostname === 'cr.shopping.naver.com' && /^\/adcr\/?$/.test(url.pathname) ? url.href : '';
    } catch { return ''; }
  }
  const current = job => {
    const source = sources.find(s => s.id === job.sources[job.sourceIndex]);
    const recipe = job.recipes?.find(entry => entry.id === source?.id);
    if (!source || !recipe?.search_url) return source;
    return { ...source, search: q => recipe.search_url.replace('{query}', encodeURIComponent(q)) };
  };
  function reviewValues(job, observed = job.review || {}) {
    const candidate = job.queue[job.detailIndex] || {};
    const sourceId = current(job)?.id;
    const observedPrice = Number.isSafeInteger(observed.price) && observed.price > 0;
    const observedShipping = Number.isSafeInteger(observed.shipping) && observed.shipping >= 0;
    const candidatePrice = Number.isSafeInteger(candidate.price) && candidate.price > 0;
    const candidateShipping = Number.isSafeInteger(candidate.shipping) && candidate.shipping >= 0;
    return {
      ...candidate,
      ...observed,
      name: String(observed.name || '').trim() || candidate.name,
      price: observedPrice ? observed.price : candidate.price,
      shipping: observedShipping ? observed.shipping : candidate.shipping,
      url: candidate.url,
      priceEvidence: observed.priceEvidence || (sourceId === 'naver' && (observedPrice || candidatePrice) ? 'search' : observedPrice ? 'detail' : candidatePrice ? 'search' : 'missing'),
      shippingEvidence: observed.shippingEvidence || (sourceId === 'naver' && (observedShipping || candidateShipping) ? 'search' : observedShipping ? 'detail' : candidateShipping ? 'search' : 'missing'),
    };
  }
  function create({ id, query, returnUrl, productId = '', selectedSources, sourceQueries, appTabId, windowId, recipes = [], apiBase = '', apiToken = '', protocolVersion = '', mergeRunId = '' }) {
    if (!String(query || '').trim() || !appUrl(returnUrl)) throw new Error('PriceScan 검색창에서 승인 수집을 시작해 주세요.');
    const enabled = sources.filter(s => !selectedSources || selectedSources.includes(s.id)).map(s => s.id);
    if (!enabled.length) throw new Error('쇼핑몰을 선택하세요.');
    const plannedQueries = Object.fromEntries(enabled.map(id => [id, String(sourceQueries?.[id] || query).trim().slice(0, 200)]));
    return { id, query: query.trim().slice(0, 200), sourceQueries: plannedQueries, productId, returnUrl: appUrl(returnUrl), appTabId, windowId,
      recipes, apiBase, apiToken, protocolVersion, mergeRunId,
      sources: enabled, sourceIndex: 0, stage: 'open_search', revision: 0, items: [], candidates: [],
      queue: [], detailIndex: 0, pageUrls: {}, warnings: [], history: [], message: '', tabId: null,
      busy: false, autoRunning: false, attention: false };
  }
  function finishSource(job) {
    job.candidates = []; job.queue = []; job.detailIndex = 0;
    job.stage = job.sourceIndex + 1 < job.sources.length ? 'next_source' : 'final';
  }
  function transition(original, input, observation = {}) {
    if (input.id !== original.id || input.revision !== original.revision) throw new Error('이미 처리한 승인입니다. 현재 단계를 확인해 주세요.');
    if (original.busy) throw new Error('현재 승인을 처리 중입니다.');
    const job = structuredClone(original);
    job.revision++; job.message = '';
    const source = current(job);
    const effect = {};
    if (input.action === 'cancel') {
      job.stage = 'cancelled'; job.message = '중단했습니다. 자동으로 다시 시작하지 않습니다.';
    } else if (input.action === 'skip_source' && ['open_search', 'results', 'candidates', 'detail', 'detail_review'].includes(job.stage)) {
      job.warnings.push(`${source.label}: 사용자가 건너뛰었습니다. 일부 또는 전체 결과가 없습니다.`);
      finishSource(job);
    } else if (input.action === 'skip_detail' && ['detail', 'detail_review'].includes(job.stage)) {
      job.warnings.push(`${source.label}: ${job.queue[job.detailIndex].name.slice(0, 70)} 상세 확인 제외`);
      // A skipped detail never masquerades as a successfully reviewed offer.
      advanceDetail(job, effect);
    } else if (input.action === 'approve') {
      if (job.stage === 'open_search' || job.stage === 'next_source') {
        if (job.stage === 'next_source') job.sourceIndex++;
        effect.navigate = current(job).search(job.sourceQueries?.[current(job).id] || job.query);
        job.stage = 'results';
      } else if (job.stage === 'results') {
        if (observation.blocked || !observation.items?.length) throw new Error(observation.message || '상품을 읽지 못했습니다. 원본 화면을 확인하거나 이 쇼핑몰을 건너뛰세요.');
        if (!input.confirmSorted && !input.acceptVisibleLowest) throw new Error('원본에서 낮은 가격순과 검색 조건을 확인한 뒤 체크해 주세요.');
        job.candidates = observation.items.filter(item => item.source === source.id && offerUrl(item.url, source.id) && item.price > 0)
          .sort((a, b) => (a.price + (a.shipping || 0)) - (b.price + (b.shipping || 0))).slice(0, 10);
        if (!job.candidates.length) throw new Error('상세 페이지로 이동할 수 있는 상품 링크를 찾지 못했습니다.');
        if (input.acceptVisibleLowest) job.warnings.push(`${source.label}: 현재 화면에 로드된 후보를 배송비 포함 가격순으로 비교했습니다.`);
        job.pageUrls[source.id] = observation.pageUrl;
        job.stage = 'candidates';
      } else if (job.stage === 'candidates') {
        job.queue = job.candidates.filter((_, index) => input.selected?.includes(index));
        if (!job.queue.length) throw new Error('상세 확인할 상품을 하나 이상 선택하세요.');
        job.detailIndex = 0;
        prepareDetail(job, effect);
      } else if (job.stage === 'detail') {
        if (observation.blocked) throw new Error(observation.message || '접근 제한 화면입니다. 직접 처리하거나 건너뛰세요.');
        job.review = reviewValues(job, observation.item || {});
        job.stage = 'detail_review';
      } else if (job.stage === 'detail_review') {
        if (observation.blocked) throw new Error(observation.message || '접근 제한 화면입니다. 직접 처리하거나 건너뛰세요.');
        const item = { ...job.queue[job.detailIndex], ...input.review,
          url: source.id === 'naver' ? job.queue[job.detailIndex].url : observation.pageUrl };
        if (!input.confirmDetail || !String(item.name || '').trim() || !offerUrl(item.url, source.id)
          || !Number.isSafeInteger(item.price) || item.price <= 0 || !Number.isSafeInteger(item.shipping) || item.shipping < 0) throw new Error('상품·옵션·가격·배송비를 확인하고 체크해 주세요. 미확인 배송비는 무료로 처리하지 않습니다.');
        job.items.push({ ...item, source: source.id, total: item.price + item.shipping, capturedAt: new Date().toISOString() });
        advanceDetail(job, effect);
      } else if (job.stage === 'final') {
        if (!job.items.length) throw new Error('반영할 상품이 없습니다. 새 수집을 시작해 주세요.');
        effect.publish = {
          id: job.id, mode: 'supervised_ai', query: job.query, productId: job.productId,
          mergeRunId: job.mergeRunId,
          returnUrl: job.returnUrl, sortMode: 'lowest', pageUrls: job.pageUrls,
          capturedAt: new Date().toISOString(), items: job.items,
          warnings: [...job.warnings.slice(-38), '사용자가 확인한 화면의 선택 상품입니다. 전체 쇼핑몰의 절대 최저가를 보장하지 않습니다.'],
        };
        job.stage = 'awaiting_import';
      } else if (job.stage === 'awaiting_import') {
        effect.returnToApp = true;
      } else throw new Error('진행할 수 없는 단계입니다.');
    } else throw new Error('지원하지 않는 승인입니다.');
    job.history = [...job.history, { action: input.action, stage: original.stage, at: new Date().toISOString() }].slice(-120);
    return { job, effect };
  }
  function advanceDetail(job, effect) {
    job.review = null;
    job.detailIndex++;
    if (job.detailIndex < job.queue.length) prepareDetail(job, effect);
    else finishSource(job);
  }
  function prepareDetail(job, effect) {
    if (current(job).id === 'naver') {
      job.stage = 'detail_review'; job.review = { ...job.queue[job.detailIndex] };
    } else { effect.navigate = job.queue[job.detailIndex].url; job.stage = 'detail'; }
  }
  function button(job) {
    if (!job) return '승인 수집 시작';
    const source = current(job)?.label;
    const next = job.queue[job.detailIndex + 1];
    return ({ open_search: `${source} 검색 시작`, results: '확인 · 현재 화면 읽기', candidates: '확인 · 선택 상품 저장',
      detail: '이 화면의 가격 자동 채우기', detail_review: next ? '맞아요 · 저장하고 다음 상품' : '맞아요 · 이 상품 저장',
      next_source: `계속 · ${sources.find(s => s.id === job.sources[job.sourceIndex + 1])?.label} 검색`,
      final: '완료 · PriceScan에 반영', awaiting_import: 'PriceScan에서 결과 확인', completed: '검색 완료', cancelled: '검색 중단됨' })[job.stage];
  }
  const api = { sources, current, safeUrl, offerUrl, appUrl, create, transition, button, reviewValues };
  globalThis.PriceScanApprovalFlow = api;
  if (typeof module !== 'undefined') module.exports = api;
})();
