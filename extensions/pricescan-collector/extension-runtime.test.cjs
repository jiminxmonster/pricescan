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

test("only exact HTTPS Naver Shopping hosts are accepted", () => {
  const { context } = loadRuntime();
  assert.equal(context.module.exports.isSupportedNaverShoppingUrl("https://search.shopping.naver.com/ns/search?query=그램"), true);
  assert.equal(context.module.exports.isSupportedNaverShoppingUrl("https://shopping.naver.com/home"), true);
  assert.equal(context.module.exports.isSupportedNaverShoppingUrl("https://search.shopping.naver.com.evil.example/"), false);
  assert.equal(context.module.exports.isSupportedNaverShoppingUrl("http://search.shopping.naver.com/"), false);
});

test("query is read from the visible page URL", () => {
  const { context } = loadRuntime();
  assert.equal(context.module.exports.deriveQuery("https://search.shopping.naver.com/ns/search?query=맥북%20프로"), "맥북 프로");
});

test("legacy automatic collection requests are ignored", () => {
  const { listener } = loadRuntime();
  assert.equal(listener({ type: "PRICESCAN_COLLECT_SEARCH" }, {}, () => {}), false);
});
