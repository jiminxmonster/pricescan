const PRODUCTION_URL = "https://pricescan.d2blue.com/pricescan/";
const captureButton = document.getElementById("capture");
const status = document.getElementById("status");
const statusText = document.getElementById("statusText");
let activeTab = null;

initialize().catch((error) => setStatus(error.message || String(error), "error"));

captureButton.addEventListener("click", async () => {
  if (!activeTab?.id) return;
  captureButton.disabled = true;
  captureButton.textContent = "현재 화면을 읽는 중…";
  setStatus("네이버 화면에서 상품명과 가격을 확인하고 있습니다.", "working");
  try {
    const response = await chrome.runtime.sendMessage({
      type: "PRICESCAN_CAPTURE_CURRENT_NAVER_PAGE",
      tabId: activeTab.id,
    });
    if (!response?.ok) throw new Error(response?.error || "화면을 가져오지 못했습니다.");
    const count = response.capture?.items?.length || 0;
    setStatus(`${count}개를 가져왔습니다. PriceScan으로 이동합니다.`, "success");
    captureButton.textContent = `${count}개 가져오기 완료`;
    window.setTimeout(() => chrome.tabs.create({ url: PRODUCTION_URL }), 350);
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
    captureButton.disabled = false;
    captureButton.textContent = "현재 화면 최대 10개 가져오기";
  }
});

document.getElementById("openPriceScan").addEventListener("click", () => {
  chrome.tabs.create({ url: PRODUCTION_URL });
});

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab || null;
  if (!isNaverShoppingUrl(tab?.url || "")) {
    setStatus("네이버 쇼핑 검색 결과를 연 뒤 다시 눌러 주세요.", "idle");
    captureButton.disabled = true;
    return;
  }
  setStatus("현재 네이버 쇼핑 화면을 가져올 수 있습니다.", "ready");
  captureButton.disabled = false;
}

function isNaverShoppingUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:"
      && ["shopping.naver.com", "search.shopping.naver.com"].includes(url.hostname);
  } catch {
    return false;
  }
}

function setStatus(message, state) {
  status.dataset.state = state;
  statusText.textContent = message;
}
