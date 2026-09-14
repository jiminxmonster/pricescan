const SHOP_DOMAINS = {
  naver: ['naver.com'], danawa: ['danawa.com'], enuri: ['enuri.com'], coupang: ['coupang.com'],
};
const DEFAULT_APP_URL = 'http://127.0.0.1:8300/pricescan/';

function normalizeAppUrl(value = DEFAULT_APP_URL) {
  const url = new URL(value);
  const loopback = ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username || url.password || url.search || url.hash) {
    throw new Error('PriceScan 앱 주소는 HTTPS 또는 로컬 주소여야 합니다.');
  }
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/`;
  return url.toString();
}

const APP_URL = normalizeAppUrl(process.env.PRICESCAN_APP_URL || DEFAULT_APP_URL);
const API_URL = new URL('api', APP_URL).toString().replace(/\/$/, '');

function isShopUrl(source, value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password && !url.port
      && (SHOP_DOMAINS[source] || []).some(domain => url.hostname === domain || url.hostname.endsWith(`.${domain}`));
  } catch { return false; }
}
function isAppUrl(value) {
  try {
    const url = new URL(value);
    return url.origin === new URL(APP_URL).origin && url.pathname.startsWith('/pricescan/') && !url.username && !url.password;
  } catch { return false; }
}
function validateStart(input) {
  if (!input || typeof input !== 'object') throw new Error('검색 요청이 올바르지 않습니다.');
  const query = typeof input.query === 'string' ? input.query.normalize('NFKC').replace(/\s+/g, ' ').trim() : '';
  const sources = [...new Set(Array.isArray(input.sources) ? input.sources : [])];
  if (!query || query.length > 300 || !sources.length || sources.some(source => !SHOP_DOMAINS[source])) throw new Error('검색어와 쇼핑몰을 확인하세요.');
  if (typeof input.productId !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.productId)) throw new Error('내 판매상품을 먼저 등록하세요.');
  if (typeof input.token !== 'string' || !input.token || input.token.length > 4096 || /[\r\n]/.test(input.token)) throw new Error('PriceScan에 다시 로그인하세요.');
  const captureModes = new Set(['automatic', 'ai_supervised', 'manual_scroll', 'manual_grid']);
  return { query, sources, productId: input.productId, sortMode: input.sortMode === 'relevance' ? 'relevance' : 'lowest',
    captureMode: captureModes.has(input.captureMode) ? input.captureMode : 'automatic' };
}

// Runs in an isolated world. Returns geometry only; it never reads or returns field contents.
function findVisibleSearchInput() {
  const selectors = [
    "input[name='query']",
    "input[type='search']",
    "input[placeholder*='검색']",
    "input[title*='검색']",
    "form[role='search'] input:not([type='hidden'])",
    "input[type='text']",
  ];
  const roots = [document];
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
  }
  const candidates = [];
  for (const root of roots) for (const selector of selectors) {
    for (const element of root.querySelectorAll(selector)) if (!candidates.includes(element)) candidates.push(element);
  }
  for (const element of candidates) {
    if (element.disabled || element.readOnly) continue;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!rect || rect.width < 80 || rect.height < 20 || rect.bottom <= 0 || rect.right <= 0
      || rect.top >= innerHeight || rect.left >= innerWidth || style.visibility === 'hidden'
      || style.display === 'none' || Number(style.opacity || 1) === 0) continue;
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y, width: rect.width, height: rect.height };
  }
  return null;
}

// Runs in an isolated world. Locates only the visible Naver low-price sort control.
function findVisibleNaverLowestSort() {
  const url = new URL(location.href);
  const sort = String(url.searchParams.get('sort') || '').toLowerCase();
  if (sort === 'price_asc' || sort === 'priceasc' || sort === 'low_price') return { selected: true };
  const selectors = ['a', 'button', "[role='button']", "[role='tab']"];
  const roots = [document];
  for (let index = 0; index < roots.length; index += 1) {
    const root = roots[index];
    for (const element of root.querySelectorAll('*')) if (element.shadowRoot) roots.push(element.shadowRoot);
  }
  const candidates = [];
  for (const root of roots) for (const selector of selectors) {
    for (const element of root.querySelectorAll(selector)) if (!candidates.includes(element)) candidates.push(element);
  }
  for (const element of candidates) {
    const label = String(element.innerText || element.textContent || '').replace(/\s+/g, '');
    if (!label.startsWith('낮은가격순')) continue;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    if (!rect || rect.width < 40 || rect.height < 20 || rect.bottom <= 0 || rect.right <= 0
      || rect.top >= innerHeight || rect.left >= innerWidth || style.visibility === 'hidden'
      || style.display === 'none' || Number(style.opacity || 1) === 0) continue;
    const className = String(element.className?.baseVal || element.className || '');
    const selected = label.includes('선택됨') || element.getAttribute('aria-selected') === 'true'
      || ['true', 'page'].includes(String(element.getAttribute('aria-current') || ''))
      || element.getAttribute('data-selected') === 'true'
      || /(^|[_\s-])(active|selected|on)([_\s-]|$)/i.test(className);
    if (selected) return { selected: true };
    const x = Math.max(0, Math.min(innerWidth - 1, rect.left + rect.width / 2));
    const y = Math.max(0, Math.min(innerHeight - 1, rect.top + rect.height / 2));
    if (Number.isFinite(x) && Number.isFinite(y)) return { selected: false, x, y, width: rect.width, height: rect.height };
  }
  return null;
}

// Runs in an isolated world. Returns only challenge state / search identity, never form values.
function inspectShoppingPage(source, expectedQuery) {
  const text = String(document.body?.innerText || '').replace(/\s+/g, ' ').slice(0, 100000);
  const visible = element => Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden' && getComputedStyle(element).display !== 'none');
  if (source === 'naver' && location.hostname === 'nid.naver.com') return { state: 'needs_login' };
  const captcha = [...document.querySelectorAll("[class*='captcha'], [id*='captcha'], iframe[src*='captcha']")].some(visible);
  if (captcha || /보안문자|자동입력\s*방지|실제\s*사용자임을\s*확인|보안\s*확인을\s*완료|CAPTCHA/i.test(text)) return { state: 'needs_verification' };
  if (/Access Denied|접근[이\s]*제한|비정상적인\s*접근|서비스\s*접속[이\s]*차단|쇼핑 서비스 이용이 제한|일시적으로\s*접속이\s*제한/i.test(text)) return { state: 'blocked' };
  if (document.readyState !== 'complete') return { state: 'loading' };
  if (source === 'naver') {
    const url = new URL(location.href);
    const normalize = value => String(value || '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
    const searchPath = url.pathname.startsWith('/search/') || url.pathname === '/ns/search' || url.pathname.startsWith('/ns/search/');
    if (url.hostname !== 'search.shopping.naver.com' || !searchPath || normalize(url.searchParams.get('query')) !== normalize(expectedQuery)) return { state: 'needs_page' };
  }
  return { state: 'ready' };
}
module.exports = { APP_URL, API_URL, normalizeAppUrl, isShopUrl, isAppUrl, validateStart, findVisibleSearchInput, findVisibleNaverLowestSort, inspectShoppingPage };
