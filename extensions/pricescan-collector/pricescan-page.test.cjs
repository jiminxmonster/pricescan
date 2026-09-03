const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadContentScript(capture = null) {
  const listeners = new Map();
  const posted = [];
  const sent = [];
  const window = {
    location: { origin: "https://pricescan.d2blue.com" },
    addEventListener(type, listener) { listeners.set(type, listener); },
    postMessage(message) { posted.push(message); },
  };
  const chrome = {
    runtime: {
      id: "test-extension",
      lastError: null,
      sendMessage(message, callback) {
        sent.push(message);
        if (callback) callback({ ok: true, capture });
        return Promise.resolve({ ok: true });
      },
      onMessage: { addListener() {} },
    },
  };
  const context = vm.createContext({ chrome, console, window });
  vm.runInContext(fs.readFileSync(path.join(__dirname, "pricescan-page.js"), "utf8"), context);
  return { listeners, posted, sent, window };
}

test("pending current-page capture is delivered to PriceScan", () => {
  const capture = { id: "capture-1", items: [{ name: "상품" }] };
  const { posted } = loadContentScript(capture);
  assert.equal(posted.at(-1).type, "PRICESCAN_CURRENT_PAGE_CAPTURED");
  assert.equal(posted.at(-1).capture.id, "capture-1");
});

test("PriceScan acknowledgement clears the matching pending capture", () => {
  const { listeners, sent, window } = loadContentScript();
  listeners.get("message")({
    source: window,
    origin: window.location.origin,
    data: { type: "PRICESCAN_CURRENT_PAGE_CAPTURE_ACK", captureId: "capture-2" },
  });
  assert.equal(sent.at(-1).type, "PRICESCAN_ACK_PENDING_CAPTURE");
  assert.equal(sent.at(-1).captureId, "capture-2");
});
