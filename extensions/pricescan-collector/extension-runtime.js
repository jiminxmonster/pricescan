if (typeof importScripts === 'function') importScripts('approval-flow.js', 'approval-runtime.js');
const VERSION = "0.5.0";
const PENDING_CAPTURE_KEY = "pricescanPendingCapture";

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ pricescanCollectorVersion: VERSION });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== "object") return false;
  const authority = globalThis.PriceScanApprovalRuntime;
  if (authority && !authority.internal(_sender) && !authority.fromApp(_sender)) return false;

  if (message.type === "PRICESCAN_GET_PENDING_CAPTURE") {
    chrome.storage.local.get(PENDING_CAPTURE_KEY)
      .then((values) => {
        const capture = values[PENDING_CAPTURE_KEY] || null;
        const allowed = !capture?.returnUrl || authority?.internal(_sender)
          || globalThis.PriceScanApprovalFlow.appUrl(_sender.url) === capture.returnUrl;
        sendResponse({ ok: true, capture: allowed ? capture : null });
      })
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  if (message.type === "PRICESCAN_ACK_PENDING_CAPTURE") {
    acknowledgePendingCapture(message.captureId, _sender)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true;
  }

  return false;
});

async function acknowledgePendingCapture(captureId, sender) {
  const values = await chrome.storage.local.get(PENDING_CAPTURE_KEY);
  const capture = values[PENDING_CAPTURE_KEY];
  if (capture?.id === captureId && (!capture.returnUrl || globalThis.PriceScanApprovalFlow.appUrl(sender?.url) === capture.returnUrl)) {
    await globalThis.PriceScanApprovalRuntime?.acknowledge(captureId);
    await chrome.storage.local.remove(PENDING_CAPTURE_KEY);
  }
}
