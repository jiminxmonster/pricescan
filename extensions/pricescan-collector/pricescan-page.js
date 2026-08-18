(() => {
  const VERSION = "0.1.4";
  const PING = "PRICESCAN_COLLECTOR_PING";
  const PONG = "PRICESCAN_COLLECTOR_PONG";
  const COLLECT_REQUEST = "PRICESCAN_COLLECTOR_COLLECT_REQUEST";
  const COLLECT_PROGRESS = "PRICESCAN_COLLECTOR_COLLECT_PROGRESS";
  const COLLECT_RESULT = "PRICESCAN_COLLECTOR_COLLECT_RESULT";

  window.PriceScanCollector = {
    installed: true,
    version: VERSION,
  };

  window.addEventListener("message", (event) => {
    if (event.source !== window) return;
    const message = event.data;
    if (!message || typeof message !== "object") return;

    if (message.type === PING) {
      window.postMessage({ type: PONG, nonce: message.nonce, version: VERSION }, window.location.origin);
      return;
    }

    if (message.type !== COLLECT_REQUEST) return;

    if (!hasRuntimeContext()) {
      postCollectionFailure(message.requestId, "Extension context invalidated.");
      return;
    }

    try {
      chrome.runtime.sendMessage(
        {
          type: "PRICESCAN_COLLECT_SEARCH",
          requestId: message.requestId,
          payload: message.payload,
        },
        (response) => {
          try {
            if (chrome.runtime.lastError) {
              postCollectionFailure(
                message.requestId,
                chrome.runtime.lastError.message || "익스텐션 백그라운드 연결 실패",
              );
              return;
            }
            window.postMessage({
              type: COLLECT_RESULT,
              requestId: message.requestId,
              ok: Boolean(response?.ok),
              payload: response?.payload,
              error: response?.error,
            }, window.location.origin);
          } catch (error) {
            postCollectionFailure(message.requestId, error);
          }
        },
      );
    } catch (error) {
      postCollectionFailure(message.requestId, error);
    }
  });

  function hasRuntimeContext() {
    try {
      return typeof chrome !== "undefined" && Boolean(chrome.runtime?.id);
    } catch {
      return false;
    }
  }

  function postCollectionFailure(requestId, error) {
    const rawMessage = error instanceof Error ? error.message : String(error || "");
    const contextInvalidated = /Extension context invalidated|context invalidated/i.test(rawMessage);
    window.postMessage({
      type: COLLECT_RESULT,
      requestId,
      ok: false,
      error: contextInvalidated
        ? "가격수집기가 업데이트되어 현재 탭의 연결이 만료되었습니다. PriceScan 페이지를 한 번 새로고침한 뒤 다시 스캔하세요."
        : rawMessage || "익스텐션 백그라운드 연결 실패",
    }, window.location.origin);
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.type !== "PRICESCAN_COLLECT_PROGRESS") return;
    window.postMessage({
      type: COLLECT_PROGRESS,
      requestId: message.requestId,
      message: message.message,
    }, window.location.origin);
  });
})();
