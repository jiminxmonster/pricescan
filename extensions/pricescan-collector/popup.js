const PRODUCTION_URL = 'https://pricescan.d2blue.com/pricescan/';
const openButton = document.getElementById('capture');
const guidedButton = document.getElementById('guidedOpen');
const status = document.getElementById('status');
const statusText = document.getElementById('statusText');
let activeWindowId = null;

async function openPriceScan() {
  const tabs = await chrome.tabs.query({ currentWindow: true });
  const existing = tabs.find(tab => {
    try {
      const url = new URL(tab.url);
      return ['https://pricescan.d2blue.com', 'http://localhost:8300', 'http://127.0.0.1:8300'].includes(url.origin)
        && url.pathname.startsWith('/pricescan/');
    } catch { return false; }
  });
  if (existing) await chrome.tabs.update(existing.id, { active: true });
  else await chrome.tabs.create({ url: PRODUCTION_URL });
  window.close();
}

openButton.addEventListener('click', () => void openPriceScan().catch(error => setStatus(error.message || String(error), 'error')));
guidedButton.addEventListener('click', () => {
  if (activeWindowId == null) return;
  chrome.sidePanel.open({ windowId: activeWindowId }).then(() => window.close())
    .catch(error => setStatus(error.message || String(error), 'error'));
});

async function initialize() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeWindowId = tab?.windowId ?? null;
  const response = await chrome.runtime.sendMessage({ type: 'PRICESCAN_APPROVAL_GET' });
  const ongoing = response?.job && !['completed', 'cancelled'].includes(response.job.stage);
  guidedButton.hidden = !ongoing;
  setStatus(ongoing
    ? 'AI 가격 조사가 진행 중입니다. 필요한 경우에만 화면 확인을 요청합니다.'
    : '시작점은 하나입니다. PriceScan 검색창에 상품명을 입력하세요.', ongoing ? 'ready' : 'idle');
}

function setStatus(message, state) { status.dataset.state = state; statusText.textContent = message; }
initialize().catch(error => setStatus(error.message || String(error), 'error'));
