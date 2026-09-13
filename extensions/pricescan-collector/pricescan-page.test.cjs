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
  const document = { hidden: false, addEventListener(type, listener) { listeners.set(type, listener); } };
  const context = vm.createContext({ chrome, console, window, document });
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

test("AI-planned per-market queries reach the extension runtime", async () => {
  const { listeners, sent, window } = loadContentScript();
  const sourceQueries = { naver: "아이패드 프로 12.9", danawa: "아이패드 12.9" };
  listeners.get("message")({
    source: window,
    origin: window.location.origin,
    data: { type: "PRICESCAN_APPROVAL_START", nonce: "n1", query: "아이패드12.9", productId: "p1", sources: ["naver", "danawa"], sourceQueries, token: "pricescan-admin-token" },
  });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(sent.at(-1).sourceQueries, sourceQueries);
  assert.equal(sent.at(-1).token, "pricescan-admin-token");
});
