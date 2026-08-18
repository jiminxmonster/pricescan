const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const test = require("node:test");
const vm = require("node:vm");

function createAnchor({ href, title, cardText = title, className = "" }) {
  return {
    href,
    innerText: title,
    textContent: title,
    className,
    getAttribute(name) {
      if (name === "href") return href;
      if (name === "title") return title;
      return "";
    },
    closest() {
      return { innerText: cardText, textContent: cardText };
    },
  };
}

function loadBackground(anchors) {
  const document = {
    querySelectorAll() {
      return anchors;
    },
  };
  const context = vm.createContext({
    URL,
    URLSearchParams,
    clearTimeout,
    console,
    document,
    fetch: async () => ({ ok: true, json: async () => ({}) }),
    location: { href: "https://search.danawa.com/dsearch.php?query=16ZB90S-GA5PK" },
    setTimeout,
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} },
      },
      storage: { local: { set: async () => {} } },
      scripting: {
        executeScript: async ({ func, args }) => [{ result: func(...args) }],
      },
    },
  });
  const source = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  vm.runInContext(source, context, { filename: "background.js" });
  return context;
}

test("findDanawaExactDetailUrl chooses the exact new-product model detail", async () => {
  const anchors = [
    createAnchor({
      href: "https://prod.danawa.com/info/?pcode=999",
      title: "LG전자 그램 프로 16Z90SP-GA5CK",
    }),
    createAnchor({
      href: "https://prod.danawa.com/info/?pcode=222",
      title: "[중고] LG전자 그램16 16ZB90S-GA5PK",
      cardText: "중고 LG전자 그램16 16ZB90S-GA5PK",
    }),
    createAnchor({
      href: "https://prod.danawa.com/info/?pcode=111",
      title: "LG전자 2024 그램16 16ZB90S-GA5PK",
      className: "prod_name",
    }),
  ];
  const context = loadBackground(anchors);

  const result = await context.findDanawaExactDetailUrl(1, "16ZB90S-GA5PK");

  assert.equal(result, "https://prod.danawa.com/info/?pcode=111");
});
