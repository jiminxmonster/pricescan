const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function loadRuntime() {
  let listener = null;
  const context = vm.createContext({
    URL,
    console,
    crypto: { randomUUID: () => "capture-test" },
    Date,
    module: { exports: {} },
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener(value) { listener = value; } },
      },
      storage: { local: { set: async () => {}, get: async () => ({}), remove: async () => {} } },
      tabs: { get: async () => ({}) },
      scripting: { executeScript: async () => [] },
    },
  });
  const source = fs.readFileSync(path.join(__dirname, "extension-runtime.js"), "utf8");
  vm.runInContext(source, context, { filename: "extension-runtime.js" });
  return { context, listener };
}

test("legacy automatic and manual Naver-first requests are ignored", () => {
  const { listener } = loadRuntime();
  assert.equal(listener({ type: "PRICESCAN_COLLECT_SEARCH" }, {}, () => {}), false);
  assert.equal(listener({ type: "PRICESCAN_CAPTURE_CURRENT_NAVER_PAGE", tabId: 1 }, {}, () => {}), false);
});
