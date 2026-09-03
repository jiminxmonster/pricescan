(() => {
  const VERSION = "0.2.0";
  const PING = "PRICESCAN_COLLECTOR_PING";
  const PONG = "PRICESCAN_COLLECTOR_PONG";
  const CAPTURED = "PRICESCAN_CURRENT_PAGE_CAPTURED";
  const ACK = "PRICESCAN_CURRENT_PAGE_CAPTURE_ACK";

  window.PriceScanCollector = { installed: true, version: VERSION, mode: "current-page" };
  requestPendingCapture();
  window.addEventListener("load", requestPendingCapture, { once: true });

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;
    if (message.type === PING && hasRuntimeContext()) {
      window.postMessage({ type: PONG, nonce: message.nonce, version: VERSION }, window.location.origin);
      return;
    }
    if (message.type === ACK && message.captureId && hasRuntimeContext()) {
      chrome.runtime.sendMessage({ type: "PRICESCAN_ACK_PENDING_CAPTURE", captureId: message.captureId }).catch(() => undefined);
    }
  });

  function requestPendingCapture() {
    if (!hasRuntimeContext() || typeof chrome.runtime.sendMessage !== "function") return;
    chrome.runtime.sendMessage({ type: "PRICESCAN_GET_PENDING_CAPTURE" }, (response) => {
      if (chrome.runtime.lastError || !response?.capture) return;
      window.postMessage({ type: CAPTURED, capture: response.capture }, window.location.origin);
    });
  }

  function hasRuntimeContext() {
    try { return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id); } catch { return false; }
  }
})();
