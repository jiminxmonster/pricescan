const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadContentScript({ runtimeId = "pricescan-test-extension", throwOnSend = true } = {}) {
  const listeners = new Map();
  const postedMessages = [];
  let sendMessageCalls = 0;
  const window = {
    location: { origin: "http://127.0.0.1:8300" },
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    postMessage(message) {
      postedMessages.push(message);
    },
  };
  const chrome = {
    runtime: {
      id: runtimeId,
      lastError: null,
      sendMessage() {
        sendMessageCalls += 1;
        if (throwOnSend) throw new Error("Extension context invalidated.");
      },
      onMessage: { addListener() {} },
    },
  };
  const context = vm.createContext({ chrome, console, window });
  const source = fs.readFileSync(path.join(__dirname, "pricescan-page.js"), "utf8");
  vm.runInContext(source, context, { filename: "pricescan-page.js" });
  return { getSendMessageCalls: () => sendMessageCalls, listeners, postedMessages, window };
}

test("invalidated extension context returns a page-refresh instruction without throwing", () => {
  const { listeners, postedMessages, window } = loadContentScript();
  const listener = listeners.get("message");

  assert.doesNotThrow(() => listener({
    source: window,
    data: {
      type: "PRICESCAN_COLLECTOR_COLLECT_REQUEST",
      requestId: "request-1",
      payload: { query: "16ZB90S-GA5PK" },
    },
  }));
  assert.equal(postedMessages.at(-1).type, "PRICESCAN_COLLECTOR_COLLECT_RESULT");
  assert.equal(postedMessages.at(-1).ok, false);
  assert.match(postedMessages.at(-1).error, /새로고침/);
});

test("missing runtime id blocks the extension API call before Chrome records an error", () => {
  const { getSendMessageCalls, listeners, postedMessages, window } = loadContentScript({ runtimeId: null });
  const listener = listeners.get("message");

  assert.doesNotThrow(() => listener({
    source: window,
    data: {
      type: "PRICESCAN_COLLECTOR_COLLECT_REQUEST",
      requestId: "request-2",
      payload: { query: "16ZB90S-GA5PK" },
    },
  }));
  assert.equal(getSendMessageCalls(), 0);
  assert.equal(postedMessages.at(-1).ok, false);
  assert.match(postedMessages.at(-1).error, /새로고침/);
});
