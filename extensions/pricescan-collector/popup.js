document.getElementById("openLocal")?.addEventListener("click", () => {
  chrome.tabs.create({ url: "http://127.0.0.1:8300/pricescan/" });
});

document.getElementById("openProd")?.addEventListener("click", () => {
  chrome.tabs.create({ url: "https://pricescan.d2blue.com/pricescan/" });
});

chrome.storage.local.get(["pricescanCollectorVersion", "lastQuery"], (values) => {
  const title = document.getElementById("statusTitle");
  const body = document.getElementById("statusBody");
  if (title && values.pricescanCollectorVersion) {
    title.textContent = `설치됨 v${values.pricescanCollectorVersion}`;
  }
  if (body && values.lastQuery) {
    body.textContent = `최근 수집 검색어: ${values.lastQuery}`;
  }
});
