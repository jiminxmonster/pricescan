const VERSION = "0.2.0";
const PENDING_CAPTURE_KEY = "pricescanPendingCapture";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ pricescanCollectorVersion: VERSION });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;

  if (message.type === "PRICESCAN_CAPTURE_CURRENT_NAVER_PAGE") {
    captureCurrentNaverPage(message.tabId)
      .then((capture) => sendResponse({ ok: true, capture }))
      .catch((error) => sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      }));
    return true;
  }

  if (message.type === "PRICESCAN_GET_PENDING_CAPTURE") {
    chrome.storage.local.get(PENDING_CAPTURE_KEY)
      .then((values) => sendResponse({ ok: true, capture: values[PENDING_CAPTURE_KEY] || null }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "PRICESCAN_ACK_PENDING_CAPTURE") {
    acknowledgePendingCapture(message.captureId)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});

async function captureCurrentNaverPage(tabId) {
  const numericTabId = Number(tabId);
  if (!Number.isInteger(numericTabId) || numericTabId <= 0) {
    throw new Error("현재 탭을 확인하지 못했습니다.");
  }

  const tab = await chrome.tabs.get(numericTabId);
  const pageUrl = String(tab.url || "");
  if (!isSupportedNaverShoppingUrl(pageUrl)) {
    throw new Error("네이버 쇼핑 검색 결과 탭에서 실행해 주세요.");
  }

  await chrome.scripting.executeScript({
    target: { tabId: numericTabId },
    files: ["naver-current-page.js"],
  });
  const injection = await chrome.scripting.executeScript({
    target: { tabId: numericTabId },
    func: (limit) => globalThis.PriceScanNaverCurrentPage.capture(limit),
    args: [10],
  });
  const result = injection?.[0]?.result || {};
  const items = Array.isArray(result.items) ? result.items.slice(0, 10) : [];
  if (!items.length) {
    const warning = Array.isArray(result.warnings) ? result.warnings[0] : "";
    throw new Error(warning || "현재 화면에서 상품명과 가격을 찾지 못했습니다.");
  }

  const capture = {
    id: crypto.randomUUID(),
    query: String(result.query || deriveQuery(pageUrl) || tab.title || "네이버 쇼핑").slice(0, 200),
    sortMode: "lowest",
    capturedAt: new Date().toISOString(),
    pageUrl: String(result.pageUrl || pageUrl),
    warnings: Array.isArray(result.warnings) ? result.warnings.slice(0, 10) : [],
    items,
  };
  await chrome.storage.local.set({
    [PENDING_CAPTURE_KEY]: capture,
    pricescanCollectorVersion: VERSION,
    lastQuery: capture.query,
    lastCapturedAt: capture.capturedAt,
  });
  return capture;
}

async function acknowledgePendingCapture(captureId) {
  const values = await chrome.storage.local.get(PENDING_CAPTURE_KEY);
  if (values[PENDING_CAPTURE_KEY]?.id === captureId) {
    await chrome.storage.local.remove(PENDING_CAPTURE_KEY);
  }
}

function isSupportedNaverShoppingUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && ["shopping.naver.com", "search.shopping.naver.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

function deriveQuery(value) {
  try {
    const url = new URL(value);
    return url.searchParams.get("query")
      || url.searchParams.get("q")
      || url.searchParams.get("keyword")
      || "";
  } catch {
    return "";
  }
}

if (typeof module !== "undefined") {
  module.exports = { isSupportedNaverShoppingUrl, deriveQuery };
}
