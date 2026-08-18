const MAX_CANDIDATES_PER_SOURCE = 50;
const VERSION = "0.1.4";
const DEFAULT_NAVER_INTERVAL_MS = 60_000;
const MIN_NAVER_INTERVAL_MS = 30_000;
const MAX_NAVER_INTERVAL_MS = 120_000;
const NAVER_SECURITY_WAIT_TIMEOUT_MS = 10 * 60_000;
const NAVER_COLLECTOR_TAB_KEY = "naverCollectorTabId";
const NAVER_LAST_SEARCH_KEY = "naverLastSearchStartedAt";

const SOURCE_DEFINITIONS = {
  naver: {
    label: "네이버",
    searchUrl: (query, sortMode) => {
      const params = new URLSearchParams({
        query,
        sort: sortMode === "lowest" ? "price_asc" : "rel",
      });
      return `https://search.shopping.naver.com/search/all?${params.toString()}`;
    },
    waitMs: 4000,
  },
  danawa: {
    label: "다나와",
    searchUrl: (query) => {
      const params = new URLSearchParams({ query });
      return `https://search.danawa.com/dsearch.php?${params.toString()}`;
    },
    waitMs: 2600,
  },
  enuri: {
    label: "에누리",
    searchUrl: (query) => {
      const params = new URLSearchParams({ keyword: query });
      return `https://www.enuri.com/search.jsp?${params.toString()}`;
    },
    waitMs: 3000,
  },
  coupang: {
    label: "쿠팡",
    searchUrl: (query, sortMode) => {
      const params = new URLSearchParams({
        component: "",
        q: query,
        channel: "user",
        listSize: "40",
        sorter: sortMode === "lowest" ? "salePriceAsc" : "scoreDesc",
      });
      return `https://www.coupang.com/np/search?${params.toString()}`;
    },
    waitMs: 3500,
  },
};

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    pricescanCollectorVersion: VERSION,
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.type !== "PRICESCAN_COLLECT_SEARCH") return false;

  collectSearch(message.payload, {
    requestId: message.requestId,
    originTabId: sender.tab?.id,
  })
    .then((payload) => sendResponse({ ok: true, payload }))
    .catch((error) => sendResponse({ ok: false, error: error instanceof Error ? error.message : String(error) }));

  return true;
});

async function collectSearch(payload, context) {
  const query = String(payload?.query || "").trim();
  const sortMode = String(payload?.sortMode || "lowest");
  const token = String(payload?.token || "");
  const apiBaseUrl = String(payload?.apiBaseUrl || "").replace(/\/$/, "");
  const sources = Array.isArray(payload?.sources) ? payload.sources.filter((source) => SOURCE_DEFINITIONS[source]) : [];
  const closeTabsAfterCapture = Boolean(payload?.closeTabsAfterCapture);
  const naverIntervalMs = clampNumber(
    Number(payload?.naverIntervalSeconds) * 1000,
    MIN_NAVER_INTERVAL_MS,
    MAX_NAVER_INTERVAL_MS,
    DEFAULT_NAVER_INTERVAL_MS,
  );

  if (!query) throw new Error("검색어가 없습니다.");
  if (!token) throw new Error("PriceScan 로그인 토큰이 없습니다. PriceScan에서 다시 로그인하세요.");
  if (!apiBaseUrl) throw new Error("PriceScan API 주소가 없습니다.");
  if (sources.length === 0) throw new Error("수집할 쇼핑몰이 선택되지 않았습니다.");

  await chrome.storage.local.set({
    lastApiBaseUrl: apiBaseUrl,
    lastQuery: query,
    lastSortMode: sortMode,
  });

  const allItems = [];
  const pageUrls = {};
  const warnings = [];

  for (const source of sources) {
    const definition = SOURCE_DEFINITIONS[source];
    await sendProgress(context, `${definition.label} 검색 화면을 여는 중...`);
    try {
      if (source === "naver") {
        await waitForNaverSearchInterval(naverIntervalMs, context);
      }
      const result = await collectSource(source, query, sortMode, closeTabsAfterCapture, context);
      pageUrls[source] = result.pageUrl;
      allItems.push(...result.items);
      warnings.push(...result.warnings);
      await sendProgress(context, `${definition.label} ${result.items.length}건 수집 완료`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`${definition.label}: ${message}`);
      await sendProgress(context, `${definition.label} 수집 실패 · ${message}`);
    }
    await sleep(650);
  }

  if (allItems.length === 0) {
    throw new Error(warnings.length ? warnings.join("\n") : "익스텐션 수집 결과가 없습니다.");
  }

  await sendProgress(context, `PriceScan에 ${allItems.length}건 저장 중...`);
  const response = await fetch(`${apiBaseUrl}/price-search/extension-results`, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      query,
      sort_mode: sortMode,
      approval_scope: "chrome_extension",
      page_urls: pageUrls,
      warnings,
      items: allItems,
    }),
  });

  if (!response.ok) {
    let detail = "";
    try {
      const errorPayload = await response.json();
      detail = errorPayload.detail || JSON.stringify(errorPayload);
    } catch {
      detail = await response.text();
    }
    throw new Error(detail || `PriceScan 저장 실패: HTTP ${response.status}`);
  }

  return response.json();
}

async function collectSource(source, query, sortMode, closeTabsAfterCapture, context) {
  const definition = SOURCE_DEFINITIONS[source];
  const url = definition.searchUrl(query, sortMode);
  const [originTab] = await chrome.tabs.query({ active: true, currentWindow: true });
  const tab = await openCollectorTab(source, url);
  if (!tab.id) throw new Error("수집 탭을 열지 못했습니다.");

  try {
    await waitForTabComplete(tab.id, 20000);
    await sleep(definition.waitMs);
    if (source === "naver") {
      await waitForNaverSecurityConfirmation(tab.id, context);
    }
    if (source === "danawa") {
      const detailUrl = await findDanawaExactDetailUrl(tab.id, query);
      if (detailUrl) {
        await sendProgress(context, "다나와 동일 모델의 판매몰 가격을 확인하는 중...");
        await chrome.tabs.update(tab.id, { url: detailUrl, active: true });
        await waitForTabComplete(tab.id, 20000);
        await sleep(definition.waitMs);
      }
    }
    const injection = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: captureVisibleShoppingProducts,
      args: [source, MAX_CANDIDATES_PER_SOURCE, query],
    });
    const result = injection?.[0]?.result || {};
    const items = Array.isArray(result.items) ? result.items : [];
    const warnings = Array.isArray(result.warnings) ? result.warnings : [];
    return {
      pageUrl: result.pageUrl || url,
      items,
      warnings,
    };
  } finally {
    if (closeTabsAfterCapture) {
      chrome.tabs.remove(tab.id).catch(() => undefined);
      if (source === "naver") chrome.storage.local.remove(NAVER_COLLECTOR_TAB_KEY).catch(() => undefined);
    } else if (originTab?.id) {
      chrome.tabs.update(originTab.id, { active: true }).catch(() => undefined);
    }
  }
}

async function findDanawaExactDetailUrl(tabId, query) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    func: (modelQuery) => {
      const cleanText = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      const normalizeModel = (value) => cleanText(value).toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
      const normalizedQuery = normalizeModel(modelQuery);
      if (normalizedQuery.length < 4) return "";

      const anchors = Array.from(document.querySelectorAll(
        "a[href*='prod.danawa.com/info/'], a[href*='/info/?pcode=']",
      ));
      const matches = anchors.map((anchor) => {
        const href = anchor.getAttribute("href") || anchor.href || "";
        if (!/pcode=/i.test(href)) return null;
        const title = cleanText(anchor.innerText || anchor.textContent || anchor.getAttribute("title") || "");
        if (!normalizeModel(title).includes(normalizedQuery)) return null;
        const card = anchor.closest("li.prod_item, div.prod_main_info, li[class*='prod_item'], div[class*='prod_main_info']");
        const cardText = cleanText(card?.innerText || card?.textContent || title);
        const isConditional = /중고|리퍼|렌탈|대여/i.test(`${title} ${cardText}`);
        const score = (isConditional ? -100 : 0)
          + (normalizeModel(title) === normalizedQuery ? 100 : 80)
          + (/prod_name|productName/i.test(String(anchor.className || "")) ? 10 : 0);
        try {
          return { url: new URL(href, location.href).href, score };
        } catch {
          return null;
        }
      }).filter(Boolean).sort((a, b) => b.score - a.score);

      return matches[0]?.url || "";
    },
    args: [query],
  });
  return String(injection?.[0]?.result || "");
}

async function openCollectorTab(source, url) {
  if (source !== "naver") return chrome.tabs.create({ url, active: true });

  const stored = await chrome.storage.local.get(NAVER_COLLECTOR_TAB_KEY);
  const storedTabId = Number(stored[NAVER_COLLECTOR_TAB_KEY]);
  if (Number.isInteger(storedTabId) && storedTabId > 0) {
    try {
      const existing = await chrome.tabs.get(storedTabId);
      const host = new URL(existing.url || "https://search.shopping.naver.com/").hostname;
      if (host === "search.shopping.naver.com" || host === "shopping.naver.com") {
        return chrome.tabs.update(storedTabId, { url, active: true });
      }
    } catch {
      // The dedicated Naver tab was closed. A new dedicated tab is created below.
    }
  }

  const tab = await chrome.tabs.create({ url, active: true });
  if (tab.id) await chrome.storage.local.set({ [NAVER_COLLECTOR_TAB_KEY]: tab.id });
  return tab;
}

async function waitForNaverSearchInterval(intervalMs, context) {
  const stored = await chrome.storage.local.get(NAVER_LAST_SEARCH_KEY);
  const lastStartedAt = Number(stored[NAVER_LAST_SEARCH_KEY] || 0);
  let remainingMs = Math.max(0, intervalMs - (Date.now() - lastStartedAt));

  while (remainingMs > 0) {
    const remainingSeconds = Math.ceil(remainingMs / 1000);
    await sendProgress(context, `네이버 검색 간격 조절 중 · ${remainingSeconds}초 후 자동으로 검색합니다.`);
    await sleep(Math.min(5000, remainingMs));
    remainingMs = Math.max(0, intervalMs - (Date.now() - lastStartedAt));
  }

  await chrome.storage.local.set({ [NAVER_LAST_SEARCH_KEY]: Date.now() });
}

async function waitForNaverSecurityConfirmation(tabId, context) {
  if (!(await hasNaverSecurityChallenge(tabId))) return;

  await chrome.tabs.update(tabId, { active: true }).catch(() => undefined);
  await showNaverSecurityWaitingBanner(tabId).catch(() => undefined);
  await sendProgress(
    context,
    "네이버 보안 확인이 필요합니다. 열린 네이버 탭에서 보안 질문을 완료해 주세요. 완료되면 자동으로 수집을 계속합니다.",
  );

  const startedAt = Date.now();
  let nextReminderAt = startedAt + 15_000;
  while (Date.now() - startedAt < NAVER_SECURITY_WAIT_TIMEOUT_MS) {
    await sleep(2000);
    let challengeVisible = true;
    try {
      challengeVisible = await hasNaverSecurityChallenge(tabId);
    } catch {
      challengeVisible = true;
    }
    if (!challengeVisible) {
      await waitForTabComplete(tabId, 20000).catch(() => undefined);
      await sleep(SOURCE_DEFINITIONS.naver.waitMs);
      await removeNaverSecurityWaitingBanner(tabId).catch(() => undefined);
      await sendProgress(context, "네이버 보안 확인 완료 · 가격수집을 자동으로 계속합니다.");
      return;
    }
    if (Date.now() >= nextReminderAt) {
      const elapsedSeconds = Math.floor((Date.now() - startedAt) / 1000);
      await sendProgress(context, `네이버 보안 확인을 기다리는 중입니다 · ${elapsedSeconds}초 경과`);
      nextReminderAt = Date.now() + 15_000;
    }
  }

  throw new Error("네이버 보안 확인 대기시간이 초과되었습니다. 같은 네이버 탭에서 확인을 완료한 뒤 다시 실행하세요.");
}

async function showNaverSecurityWaitingBanner(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const bannerId = "pricescan-security-waiting-banner";
      if (document.getElementById(bannerId)) return;
      const banner = document.createElement("div");
      banner.id = bannerId;
      banner.textContent = "PriceScan이 기다리고 있습니다. 네이버 보안 확인을 완료하면 가격수집이 자동으로 계속됩니다.";
      Object.assign(banner.style, {
        position: "fixed",
        right: "20px",
        bottom: "20px",
        zIndex: "2147483647",
        maxWidth: "360px",
        padding: "14px 16px",
        border: "1px solid #03c75a",
        borderRadius: "10px",
        background: "#ffffff",
        color: "#12351f",
        boxShadow: "0 8px 24px rgba(0, 0, 0, 0.16)",
        fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
        fontSize: "14px",
        fontWeight: "700",
        lineHeight: "1.5",
        pointerEvents: "none",
      });
      document.documentElement.appendChild(banner);
    },
  });
}

async function removeNaverSecurityWaitingBanner(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId },
    func: () => document.getElementById("pricescan-security-waiting-banner")?.remove(),
  });
}

async function hasNaverSecurityChallenge(tabId) {
  const injection = await chrome.scripting.executeScript({
    target: { tabId },
    func: () => {
      const bodyText = String(document.body?.innerText || "").replace(/\s+/g, " ");
      const hasChallengeElement = Boolean(document.querySelector(".captcha_wrap, .captcha_form, [class*='captcha']"));
      const hasChallengeText = /보안\s*확인을\s*완료|실제\s*사용자임을\s*확인|보안문자|자동입력\s*방지|CAPTCHA/i.test(bodyText);
      return hasChallengeElement || hasChallengeText;
    },
  });
  return Boolean(injection?.[0]?.result);
}

function clampNumber(value, min, max, fallback) {
  if (!Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, value));
}

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => finish(new Error("쇼핑몰 페이지 로딩 시간이 초과되었습니다.")), timeoutMs);
    const listener = (updatedTabId, changeInfo) => {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish();
    }).catch((error) => finish(error));
  });
}

async function sendProgress(context, message) {
  if (!context.originTabId) return;
  try {
    await chrome.tabs.sendMessage(context.originTabId, {
      type: "PRICESCAN_COLLECT_PROGRESS",
      requestId: context.requestId,
      message,
    });
  } catch {
    // PriceScan page may have been reloaded. Progress updates are optional.
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function captureVisibleShoppingProducts(source, maxItems, query = "") {
  const sourceLabels = {
    naver: "네이버",
    danawa: "다나와",
    enuri: "에누리",
    coupang: "쿠팡",
  };

  const cardSelectors = {
    naver: [
      "li[class*='product_item']",
      "div[class*='product_item']",
      "li[class*='basicList_item']",
      "div[class*='basicList_item']",
      "div[class*='adProduct_item']",
    ],
    danawa: [
      "#OpenMarketMallListDiv .diff_item",
      "#StandardMallListDiv .diff_item",
      ".diff_list .diff_item",
      "div.diff_item",
      "li.prod_item",
      "div.prod_main_info",
      "li[class*='prod_item']",
      "div[class*='prod_main_info']",
      "div[class*='main_prodlist'] li",
    ],
    enuri: [
      "li[class*='prod']",
      "div[class*='prod']",
      "li[class*='item']",
      "div[class*='item']",
    ],
    coupang: [
      "li.search-product",
      "li[class*='search-product']",
      "li[class*='ProductUnit']",
      "div[class*='ProductUnit']",
      "li[data-sentry-component]",
    ],
  };

  const titleSelectors = {
    naver: [
      "a[class*='product_title']",
      "a[class*='basicList_link']",
      "a[class*='adProduct_link']",
      "div[class*='product_title'] a",
    ],
    danawa: [
      ".info_line a",
      ".info_line",
      ".prod_name a",
      "p.prod_name a",
      "a[name='productName']",
    ],
    enuri: [
      "h1",
      "h2",
      "a[class*='name']",
      "a[class*='title']",
      ".prodName a",
      ".prod_name a",
    ],
    coupang: [
      "h1",
      "[class*='prod-buy-header__title']",
      "[class*='ProductTitle']",
      ".name",
      "div.name",
      "[class*='name']",
      "[class*='title']",
    ],
  };

  const mallSelectors = {
    naver: [
      "[class*='mall_title']",
      "[class*='mall_name']",
      "[class*='product_mall']",
      "a[class*='mall']",
    ],
    danawa: [
      ".d_mall a",
      ".d_mall",
      ".prod_maker",
      ".mall",
      ".seller",
    ],
    enuri: [
      "[class*='mall']",
      "[class*='seller']",
    ],
    coupang: [
      "[class*='seller']",
      "[class*='vendor']",
    ],
  };

  const warnings = [];
  const bodyText = cleanText(document.body?.innerText || "");
  if (/Access Denied|접근\s*거부|권한이\s*없|captcha|보안문자/i.test(bodyText)) {
    warnings.push(`${sourceLabels[source] || source}: 현재 페이지가 접근 제한/보안확인 상태입니다.`);
  }

  const items = [];
  const seen = new Set();
  const normalizedQuery = normalizeModelText(query);
  const initialScrollTop = window.scrollY;
  let stablePasses = 0;

  collectCurrentCards();
  for (let pass = 0; pass < 12 && items.length < maxItems; pass += 1) {
    const beforeCount = items.length;
    const beforeScrollTop = window.scrollY;
    const scrollStep = Math.max(Math.floor(window.innerHeight * 0.85), 650);
    window.scrollBy({ top: scrollStep, left: 0, behavior: "auto" });
    await new Promise((resolve) => setTimeout(resolve, 850));
    collectCurrentCards();

    stablePasses = items.length === beforeCount ? stablePasses + 1 : 0;
    const scrollingElement = document.scrollingElement || document.documentElement;
    const reachedBottom = window.scrollY === beforeScrollTop
      || window.scrollY + window.innerHeight >= scrollingElement.scrollHeight - 8;
    if (reachedBottom && stablePasses >= 2) break;
  }
  window.scrollTo({ top: initialScrollTop, left: 0, behavior: "auto" });

  if (items.length === 0) {
    const detailProduct = parseProductCard(document.body);
    if (detailProduct) items.push(detailProduct);
  }

  if (items.length === 0 && !warnings.length) {
    warnings.push(`${sourceLabels[source] || source}: 상품카드/가격을 찾지 못했습니다.`);
  }

  return {
    pageUrl: location.href,
    items,
    warnings,
  };

  function collectCurrentCards() {
    const candidates = uniqueElements([
      ...queryAll(cardSelectors[source] || []),
      ...anchorFallbackCards(),
    ]).sort((left, right) => scoreCard(right) - scoreCard(left));
    for (const card of candidates) {
      if (items.length >= maxItems) break;
      if (!card || !document.documentElement.contains(card)) continue;
      const product = parseProductCard(card);
      if (!product) continue;
      const key = `${product.name}|${product.price}|${product.url}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(product);
    }
  }

  function scoreCard(card) {
    if (!normalizedQuery) return 0;
    const cardText = cleanText(card?.innerText || card?.textContent || "");
    return normalizeModelText(cardText).includes(normalizedQuery) ? 1 : 0;
  }

  function parseProductCard(card) {
    const text = cleanText(card.innerText || card.textContent || "");
    if (!text || !/[0-9][0-9,]*\s*원/.test(text)) return null;

    const prices = extractWonPrices(text);
    const salePrices = prices.filter((value) => value >= 1000);
    if (!salePrices.length) return null;

    const title = extractTitle(card, text);
    if (!title || isNoiseTitle(title)) return null;

    const url = extractUrl(card);
    const mall = extractMall(card);
    const shipping = extractShipping(text);
    const exposurePrice = Math.min(...salePrices);
    const registeredPrice = salePrices.length >= 2 ? Math.max(...salePrices) : exposurePrice;

    return {
      source,
      mall,
      name: title.slice(0, 240),
      price: exposurePrice,
      registered_price: Math.max(registeredPrice, exposurePrice),
      shipping,
      total: exposurePrice + shipping,
      url,
    };
  }

  function extractTitle(card, text) {
    if (source === "coupang") {
      const productAnchor = card.matches?.("a[href*='/vp/products/']")
        ? card
        : card.querySelector("a[href*='/vp/products/']");
      const imageAlt = cleanText(productAnchor?.querySelector("img[alt]")?.getAttribute("alt") || "");
      if (imageAlt.length >= 8 && !isNoiseTitle(imageAlt)) return imageAlt;
    }

    const selectorTitle = firstText(card, titleSelectors[source] || []);
    if (selectorTitle) return selectorTitle;

    const anchors = Array.from(card.querySelectorAll("a"))
      .map((anchor) => cleanText(anchor.innerText || anchor.textContent || ""))
      .filter((value) => value.length >= 8 && !isNoiseTitle(value))
      .sort((a, b) => b.length - a.length);
    if (anchors[0]) return anchors[0];

    const lines = text.split("\n")
      .map(cleanText)
      .filter((line) => line.length >= 8 && !/[0-9][0-9,]*\s*원/.test(line) && !isNoiseTitle(line));
    return lines[0] || "";
  }

  function extractUrl(card) {
    const preferredAnchor = source === "coupang"
      ? (card.matches?.("a[href*='/vp/products/']") ? card : card.querySelector("a[href*='/vp/products/']"))
      : source === "danawa"
        ? card.querySelector("a.priceCompareBuyLink[href], a[href*='loadingBridge.html']")
        : null;
    if (preferredAnchor) {
      try {
        return new URL(preferredAnchor.getAttribute("href"), location.href).href;
      } catch {
        // Fall through to the generic link chooser.
      }
    }
    const anchors = [
      ...(card.matches?.("a[href]") ? [card] : []),
      ...Array.from(card.querySelectorAll("a[href]")),
    ];
    const selected = anchors.find((anchor) => {
      const text = cleanText(anchor.innerText || anchor.textContent || "");
      return text.length >= 4 && !/^#|javascript:/i.test(anchor.getAttribute("href") || "");
    }) || anchors.find((anchor) => !/^#|javascript:/i.test(anchor.getAttribute("href") || ""));
    if (!selected) return location.href;
    try {
      return new URL(selected.getAttribute("href"), location.href).href;
    } catch {
      return location.href;
    }
  }

  function extractMall(card) {
    const selectorMall = firstText(card, mallSelectors[source] || []);
    if (selectorMall && selectorMall.length <= 40) return selectorMall;
    if (source === "danawa") {
      const mallImageAlt = cleanText(card.querySelector(".d_mall img[alt]")?.getAttribute("alt") || "");
      if (mallImageAlt && mallImageAlt.length <= 40) return mallImageAlt;
    }
    return sourceLabels[source] || source;
  }

  function extractShipping(text) {
    const normalized = text.replace(/\s+/g, "");
    if (/무료배송|배송비무료|무료/.test(normalized)) return 0;
    const match = text.match(/배송(?:비|료)?[^0-9]{0,12}([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})\s*원/);
    return match ? parseInt(match[1].replace(/,/g, ""), 10) : 0;
  }

  function extractWonPrices(text) {
    const values = [];
    const matches = text.matchAll(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,9})\s*원/g);
    for (const match of matches) {
      const before = text.slice(Math.max(0, match.index - 24), match.index);
      const after = text.slice(match.index + match[0].length, Math.min(text.length, match.index + match[0].length + 24));
      if (/배송|적립|캐시|개월|월\s*[0-9]|리뷰|평점|카드\s*혜택/.test(before + after)) continue;
      values.push(parseInt(match[1].replace(/,/g, ""), 10));
    }
    const validValues = values.filter((value) => Number.isFinite(value) && value > 0);
    const maxValue = validValues.length ? Math.max(...validValues) : 0;
    return validValues.filter((value) => maxValue < 100000 || value >= maxValue * 0.5);
  }

  function anchorFallbackCards() {
    const cards = [];
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    for (const anchor of anchors) {
      const anchorText = cleanText(anchor.innerText || anchor.textContent || "");
      if (anchorText.length < 8 || isNoiseTitle(anchorText)) continue;
      let node = anchor;
      for (let depth = 0; depth < 5 && node; depth += 1) {
        const text = cleanText(node.innerText || node.textContent || "");
        if (/[0-9][0-9,]*\s*원/.test(text) && text.length < 2500) {
          cards.push(node);
          break;
        }
        node = node.parentElement;
      }
    }
    return cards;
  }

  function queryAll(selectors) {
    const elements = [];
    for (const selector of selectors) {
      try {
        elements.push(...document.querySelectorAll(selector));
      } catch {
        // Ignore invalid selectors from future experiments.
      }
    }
    return elements;
  }

  function firstText(root, selectors) {
    for (const selector of selectors) {
      const element = root.querySelector(selector);
      const value = cleanText(element?.innerText || element?.textContent || "");
      if (value) return value;
    }
    return "";
  }

  function uniqueElements(elements) {
    const unique = [];
    const seen = new Set();
    for (const element of elements) {
      if (!element || seen.has(element)) continue;
      seen.add(element);
      unique.push(element);
    }
    return unique;
  }

  function cleanText(value) {
    return String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
  }

  function normalizeModelText(value) {
    return cleanText(value).toLowerCase().replace(/[^a-z0-9가-힣]/g, "");
  }

  function isNoiseTitle(value) {
    const normalized = cleanText(value).replace(/\s+/g, "");
    if (normalized.length < 4) return true;
    return /^(광고|찜하기|장바구니|구매하기|바로구매|무료배송|로켓배송|검색결과|정렬|필터|로그인|회원가입|쿠팡홈|카테고리)$/i.test(normalized);
  }
}
