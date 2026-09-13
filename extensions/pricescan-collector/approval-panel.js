const Flow = globalThis.PriceScanApprovalFlow;
const $ = id => document.getElementById(id);
const preview = !globalThis.chrome?.runtime?.id && new URLSearchParams(location.search).get('preview') === '1';
let job = null, busy = false, requestingPermission = false;
const money = n => `${Number(n).toLocaleString('ko-KR')}원`;
const el = (tag, text, className) => { const node = document.createElement(tag); if (text != null) node.textContent = text; if (className) node.className = className; return node; };
function field(id, label, value, kind = 'number') {
  const row = el('label', label, 'field'), input = el(kind === 'text' ? 'textarea' : 'input');
  input.id = id; if (kind !== 'text') { input.type = 'number'; input.min = '0'; input.step = '1'; }
  input.value = value ?? ''; input.placeholder = '화면에서 직접 확인 후 입력'; row.append(input); return row;
}
function render() {
  $('content').replaceChildren(); $('sources').replaceChildren(); $('message').textContent = job?.message || '';
  const active = job && !['completed', 'cancelled'].includes(job.stage);
  $('cancel').hidden = !active || job.stage === 'awaiting_import';
  $('skipSource').hidden = !job?.attention || !['open_search', 'results', 'candidates', 'detail', 'detail_review'].includes(job.stage);
  $('skipDetail').hidden = !job?.attention || !['detail', 'detail_review'].includes(job.stage);
  $('approve').disabled = !active || busy || job?.busy || job?.autoRunning;
  $('approve').textContent = busy || job?.busy || job?.autoRunning ? 'AI 조사 중…' : job?.attention ? '해결했어요 · AI 조사 계속' : 'AI 자동 조사 시작';
  $('saved').textContent = busy || job?.busy || job?.autoRunning ? '자동 진행' : job?.attention ? '확인 필요' : '준비';
  if (!job) return;
  const source = Flow.current(job), item = job.queue[job.detailIndex];
  job.sources.forEach((id, index) => $('sources').append(el('span', Flow.sources.find(s => s.id === id).label, `source ${index === job.sourceIndex ? 'active' : index < job.sourceIndex ? 'done' : ''}`)));
  $('eyebrow').textContent = `${job.query} · ${job.sourceIndex + 1}/${job.sources.length} 쇼핑몰 · ${job.items.length}건 보관`;
  const content = $('content');
  const copy = {
    open_search: [`${source.label} 검색을 시작합니다`, '큰 버튼을 누르면 사전 로그인된 현재 Chrome에서 검색 화면을 엽니다. 로그인 만료나 보안 확인이 나오면 직접 처리한 뒤 계속하세요.', `다음: ${source.label} 검색 열기`],
    results: ['낮은 가격순을 확인하세요', '쇼핑몰 화면에서 정렬과 모델·용량·옵션을 맞춰 주세요. 승인하면 현재 로드된 결과를 최대 10개 읽습니다.', '다음: 현재 검색결과 읽기 · 추가 페이지 요청 없음'],
    candidates: ['가져올 상품만 체크하세요', '처음 5개가 선택되어 있습니다. 체크한 상품만 큰 버튼으로 하나씩 확인합니다.', '다음: 선택한 첫 상품 화면 열기'],
    detail: [`상품 확인 ${job.detailIndex + 1}/${job.queue.length}`, '화면의 모델·용량이 맞는지만 보세요. 큰 버튼을 누르면 가격을 자동으로 채웁니다.', '다음: 현재 화면에서 가격 자동 채우기'],
    detail_review: ['자동으로 채운 값이 맞나요?', '원본 화면과 다른 값만 고쳐 주세요. 그대로 맞으면 입력할 필요 없이 큰 버튼만 누르면 됩니다.', job.queue[job.detailIndex + 1] ? `다음: 저장 후 다음 상품 열기` : '다음: 저장 후 다음 쇼핑몰로'],
    next_source: [`${source.label} 확인 완료`, '확인한 상품은 저장됐습니다. 큰 버튼 한 번으로 다음 쇼핑몰 검색을 이어갑니다.', `다음: ${Flow.sources.find(s => s.id === job.sources[job.sourceIndex + 1])?.label || ''} 검색`],
    final: ['확인한 상품을 한 번에 반영', '최종 승인하면 아래 선택 결과만 PriceScan의 내 판매상품에 연결합니다. 제외한 쇼핑몰·상품은 수집되지 않은 상태로 남습니다.', `다음: ${job.items.length}건 PriceScan 전송`],
    awaiting_import: ['PriceScan 반영 확인 중', 'PriceScan 탭에서 로그인이 필요하면 로그인해 주세요. 저장 성공 응답을 받아야 완료로 표시됩니다. 이 창을 닫아도 결과는 보관됩니다.', '다음: PriceScan 탭으로 돌아가 반영 재확인'],
    completed: ['PriceScan에 반영했습니다', `${job.items.length}건이 연결됐습니다. 내 판매상품에서 비교하고 마진을 계산하세요. 새 검색은 PriceScan에서 시작하세요.`, '새 수집은 PriceScan 검색창에서 시작하세요'],
    cancelled: ['수집을 중단했습니다', '다음 화면을 열거나 결과를 전송하지 않습니다. 새 검색은 PriceScan에서 시작해 주세요.', '새 수집은 PriceScan 검색창에서 시작하세요'],
  }[job.stage];
  if (source.id === 'naver') {
    if (job.stage === 'open_search') copy.splice(0, 3, '로그인된 네이버에서 검색합니다', '큰 버튼을 누르면 같은 Chrome 로그인 상태로 네이버 쇼핑 검색을 엽니다. 보안 확인이 나오면 직접 완료한 뒤 다시 계속하세요.', '다음: 네이버 검색 시작');
    if (job.stage === 'results') copy.splice(0, 3, '열어 둔 상품·판매처를 가져옵니다', '검색어와 모델·용량·최저가순을 직접 확인하세요. 가격비교 페이지라면 판매처 목록을 펼쳐 주세요. 승인할 때 선택되어 있는 네이버 탭만 읽습니다.', '다음: 현재 네이버 화면 읽기 · 검색/새로고침 없음');
    if (job.stage === 'candidates') copy.splice(0, 3, '가져올 항목을 선택하세요', '선택한 항목의 상품명·옵션·가격·배송비를 하나씩 검토합니다. 판매처 상세 페이지로 자동 이동하지 않습니다.', '다음: 선택 항목 검토 · 원본 탭 유지');
    if (job.stage === 'detail_review') copy.splice(0, 3, '자동으로 채운 값이 맞나요?', '현재 네이버 화면에서 읽은 값입니다. 다른 값만 고치고, 맞으면 큰 버튼만 누르세요. 판매처 상세 페이지로 이동하지 않습니다.', '다음: 현재 항목 저장 · 페이지 이동 없음');
  }
  if (job.autoRunning) copy.splice(0, 3, `${source.label}에서 AI가 조사 중입니다`, '현재 화면에 표시된 상품명·가격·배송비를 확인하고, 가장 낮은 유효 후보 한 개를 검토한 뒤 다음 쇼핑몰로 이동합니다.', '지금은 기다려 주세요 · 필요한 경우에만 멈추고 알려드립니다.');
  else if (job.attention) copy.splice(0, 3, '사용자 확인이 필요합니다', job.message || '로그인·보안 확인 또는 불확실한 값을 현재 화면에서 해결해 주세요.', '해결한 뒤 큰 버튼 한 번으로 AI 조사를 계속합니다.');
  else if (job.stage === 'open_search') copy.splice(0, 3, '한 번만 누르면 AI가 전부 조사합니다', '처음 사용할 때만 선택한 쇼핑몰 화면 읽기 권한을 한 번 허용합니다. 이후에는 PriceScan 검색 버튼 한 번으로 자동 진행합니다.', `다음: ${job.sources.length}개 쇼핑몰 접근 허용 · AI 조사 시작`);
  if (copy) { $('heading').textContent = copy[0]; $('description').textContent = copy[1]; $('next').textContent = copy[2]; }
  if (job.stage === 'results' && !job.autoRunning) content.append(el('p', 'AI는 현재 화면에 로드된 후보만 배송비 포함 가격으로 비교합니다. 전체 시장의 절대 최저가는 보장하지 않습니다.', 'confirmation'));
  if (job.stage === 'candidates') job.candidates.forEach((offer, index) => {
    const row = el('label', null, 'offer'), check = el('input'); check.type = 'checkbox'; check.dataset.index = String(index); check.checked = index < 5;
    const info = el('span', offer.name); info.append(el('b', money(offer.price)), el('small', `${offer.mall} · 배송비 ${offer.shipping == null ? '미확인' : money(offer.shipping)}`));
    row.append(check, info); content.append(row);
  });
  if (['detail', 'detail_review'].includes(job.stage)) {
    content.append(el('p', item.name, 'product-name'), el('p', item.url, 'source-link'));
    if (job.stage === 'detail_review') {
      const review = Flow.reviewValues(job);
      const detected = el('div', null, 'detected');
      const priceSource = review.priceEvidence === 'detail' ? '현재 상품 화면' : review.priceEvidence === 'search' ? '검색 결과' : '감지 못함';
      const shippingSource = review.shippingEvidence === 'detail' ? '현재 상품 화면' : review.shippingEvidence === 'search' ? '검색 결과' : '확인 필요';
      detected.append(el('strong', '자동 입력 완료'), el('span', review.price > 0 ? `${money(review.price)} · ${priceSource}` : '상품가를 직접 입력해 주세요'), el('span', review.shipping == null ? `배송비 · ${shippingSource}` : `배송비 ${money(review.shipping)} · ${shippingSource}`));
      content.append(detected, field('name', '상품명·옵션 · 다르면 수정', review.name, 'text'), field('price', '상품가 (원) · 다르면 수정', review.price), field('shipping', '배송비 (원) · 다르면 수정', review.shipping), el('p', '화면과 값이 같다면 아래 큰 버튼만 누르세요. 배송비 0원은 무료배송을 확인한 경우에만 사용합니다.', 'confirmation'));
    }
  }
  if (['next_source', 'final', 'awaiting_import', 'completed'].includes(job.stage)) {
    job.sources.forEach(id => {
      const rows = job.items.filter(row => row.source === id), line = el('div', null, 'summary');
      line.append(el('span', Flow.sources.find(s => s.id === id).label), el('strong', rows.length ? `${rows.length}건 · ${money(Math.min(...rows.map(r => r.total)))}` : '수집 없음', rows.length ? '' : 'empty')); content.append(line);
    });
    for (const warning of job.warnings) content.append(el('p', warning, 'source-link'));
  }
}
function demoObservation() {
  const source = Flow.current(job);
  if (job.stage === 'results') return { pageUrl: source.search(job.query), items: Array.from({ length: 5 }, (_, i) => ({ source: source.id, name: `삼성 SSD 2TB · 예시 상품 ${i + 1}`, mall: '예시 판매점', price: 185000 + i * 3000, shipping: 0, url: `https://${source.hosts[0]}/products/${i + 1}` })) };
  const item = job.queue[job.detailIndex];
  return { pageUrl: item?.url, item };
}
async function act(action) {
  if (busy || !job) return;
  const input = { type: 'PRICESCAN_APPROVAL_ACT', action, id: job.id, revision: job.revision,
    selected: [...document.querySelectorAll('input[data-index]:checked')].map(node => Number(node.dataset.index)),
    confirmSorted: job.stage === 'results', confirmDetail: job.stage === 'detail_review',
    review: { name: $('name')?.value.trim(), price: $('price')?.value === '' ? null : Number($('price')?.value), shipping: $('shipping')?.value === '' ? null : Number($('shipping')?.value) } };
  if (action === 'cancel' && !confirm('중단할까요? 보관한 결과는 PriceScan에 전송되지 않습니다.')) return;
  busy = true; $('approve').disabled = true; $('approve').textContent = '처리 중…';
  try {
    if (preview) {
      const result = Flow.transition(job, input, demoObservation()); job = result.job;
      // Preview ends in awaiting_import, never fakes a server acknowledgement.
    } else {
      const response = await chrome.runtime.sendMessage(input);
      if (!response?.ok) throw new Error(response?.error || '연결을 확인해 주세요.');
      job = response.job;
    }
    busy = false; render();
  } catch (error) {
    busy = false; $('message').textContent = error.message || String(error); $('approve').disabled = false; $('approve').textContent = Flow.button(job);
  }
}
$('approve').addEventListener('click', async () => {
  if (busy || requestingPermission) return;
  requestingPermission = true;
  const expected = job && { id: job.id, revision: job.revision };
  try {
  if (job && !preview) {
    const origins = [...new Set(job.sources.flatMap(id => Flow.sources.find(source => source.id === id).hosts).map(host => `https://${host}/*`))];
    // Optional host access is requested once, directly from this user gesture.
    try { if (!await chrome.permissions.request({ origins })) { $('message').textContent = '선택한 쇼핑몰을 한 번에 조사하려면 화면 읽기 권한이 필요합니다.'; return; } }
    catch (error) { $('message').textContent = error.message; return; }
  }
  if (expected && (job?.id !== expected.id || job.revision !== expected.revision)) return;
  if (preview) { await act('approve'); return; }
  const manualReview = job.attention && job.stage === 'detail_review' ? {
    name: $('name')?.value.trim(), price: $('price')?.value === '' ? null : Number($('price')?.value),
    shipping: $('shipping')?.value === '' ? null : Number($('shipping')?.value),
  } : null;
  busy = true; render();
  if (job.attention && job.stage === 'detail_review') {
    const manual = { type: 'PRICESCAN_APPROVAL_ACT', action: 'approve', id: job.id, revision: job.revision,
      confirmDetail: true, review: manualReview };
    const fixed = await chrome.runtime.sendMessage(manual);
    if (!fixed?.ok) throw new Error(fixed?.error || '확인한 값을 저장하지 못했습니다.');
    job = fixed.job;
  }
  const response = await chrome.runtime.sendMessage({ type: 'PRICESCAN_APPROVAL_AUTORUN', id: job.id, revision: job.revision });
  if (!response?.ok) throw new Error(response?.error || 'AI 조사를 계속하지 못했습니다.');
  job = response.job; busy = false; render();
  } catch (error) {
    busy = false; render(); $('message').textContent = error.message || String(error);
  } finally { requestingPermission = false; }
});
$('skipSource').addEventListener('click', () => { if (!requestingPermission) void act('skip_source'); });
$('skipDetail').addEventListener('click', () => { if (!requestingPermission) void act('skip_detail'); });
$('cancel').addEventListener('click', () => { if (!requestingPermission) void act('cancel'); });
async function initialize() {
  $('preview').hidden = !preview;
  if (preview) job = Flow.create({ id: 'preview', query: '삼성 SSD 2TB', returnUrl: 'http://localhost:8300/pricescan/' });
  else {
    const response = await chrome.runtime.sendMessage({ type: 'PRICESCAN_APPROVAL_GET' });
    if (!response?.ok) throw new Error(response?.error || '확장 프로그램을 다시 열어 주세요.');
    job = response.job;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !changes.pricescanApprovalJob || busy) return;
      job = changes.pricescanApprovalJob.newValue || null; render();
    });
  }
  render();
}
initialize().catch(error => { $('message').textContent = error.message || 'PriceScan 확장 프로그램에서 열어 주세요.'; });
