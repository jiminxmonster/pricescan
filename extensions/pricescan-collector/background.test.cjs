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

function createNode({ text = "", attrs = {}, selectors = {}, selectorLists = {}, closest = {} } = {}) {
  return {
    innerText: text,
    textContent: text,
    href: attrs.href || "",
    parentElement: null,
    getAttribute(name) {
      return attrs[name] ?? "";
    },
    querySelector(selector) {
      return selectors[selector] || null;
    },
    querySelectorAll(selector) {
      return selectorLists[selector] || [];
    },
    matches(selector) {
      return Boolean(selectorLists.__matches?.some((value) => selector.includes(value)));
    },
    closest(selector) {
      return closest[selector] || null;
    },
  };
}

function loadBackground(anchors = [], overrides = {}) {
  const documentElement = { contains: () => true, scrollHeight: 1000 };
  const document = {
    body: createNode(),
    documentElement,
    scrollingElement: documentElement,
    querySelector(selector) {
      return overrides.selectors?.[selector] || null;
    },
    querySelectorAll(selector) {
      if (selector.includes("prod.danawa.com/info/") || selector.includes("/info/?pcode=")) return anchors;
      return overrides.selectorLists?.[selector] || [];
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
    window: {
      innerHeight: 1000,
      scrollY: 0,
      scrollBy() {},
      scrollTo() {},
    },
    chrome: {
      runtime: {
        onInstalled: { addListener() {} },
        onMessage: { addListener() {} },
      },
      storage: { local: { set: async () => {} } },
      scripting: {
        executeScript: async ({ func, args = [] }) => [{ result: func(...args) }],
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

test("Naver collection never performs scripted auto-scroll", () => {
  const context = loadBackground();

  assert.equal(context.shouldAutoScrollSource("naver"), false);
  assert.equal(context.shouldAutoScrollSource("danawa"), true);
  assert.equal(context.shouldAutoScrollSource("enuri"), true);
  assert.equal(context.shouldAutoScrollSource("coupang"), true);
});

test("Naver supervised collection always runs before parser sources", () => {
  const context = loadBackground();

  assert.deepEqual(
    JSON.parse(JSON.stringify(context.orderSourcesForCollection(["danawa", "coupang", "naver", "enuri", "naver"]))),
    ["naver", "danawa", "coupang", "enuri"],
  );
});

test("Naver supervised flow requires a visible user decision before capture", () => {
  const source = fs.readFileSync(path.join(__dirname, "background.js"), "utf8");
  const collectSourceStart = source.indexOf("async function collectSource");
  const approvalIndex = source.indexOf("waitForNaverSupervisedApproval(tab.id", collectSourceStart);
  const captureIndex = source.indexOf("func: captureVisibleShoppingProducts", collectSourceStart);

  assert.ok(approvalIndex > collectSourceStart);
  assert.ok(captureIndex > approvalIndex);
  assert.match(source, /현재 화면 수집/);
  assert.match(source, /네이버 건너뛰기/);
});

test("Naver login is treated as a supervised user-confirmation step", async () => {
  const context = loadBackground();
  context.location.href = "https://nid.naver.com/nidlogin.login";
  context.location.hostname = "nid.naver.com";

  assert.equal(await context.hasNaverSecurityChallenge(1), true);
});

test("captureVisibleShoppingProducts parses current Danawa mall rows", async () => {
  const title = createNode({ text: "LG전자 2026 그램 프로16 16Z95U-GS5WK (SSD 512GB)" });
  const sellPrice = createNode({ attrs: { "data-base-price": "2083180", "data-delivery-price": "2500" } });
  const mallLogo = createNode({ attrs: { alt: "옥션" } });
  const productLink = createNode({ attrs: { href: "/bridge/loadingBridge.html?pcode=103451483&cmpnyc=EE715" } });
  const mallList = createNode();
  const card = createNode({
    text: "옥션 2,083,180원 배송비 2,500원",
    selectors: {
      ".sell-price": sellPrice,
      ".box__logo img[alt], .d_mall img[alt]": mallLogo,
      "a.link__full-cover[href]": productLink,
    },
    closest: { ".list__mall-price": mallList },
  });
  const context = loadBackground([], {
    selectors: { ".top_summary .prod_tit .title": title },
    selectorLists: { ".list__mall-price > .list-item": [card] },
  });
  context.location.href = "https://prod.danawa.com/info/?pcode=103451483";

  const result = await context.captureVisibleShoppingProducts("danawa", 1, "16Z95U-GS5WK");

  assert.deepEqual(JSON.parse(JSON.stringify(result.items)), [{
    source: "danawa",
    mall: "옥션",
    name: "LG전자 2026 그램 프로16 16Z95U-GS5WK (SSD 512GB)",
    price: 2083180,
    registered_price: 2083180,
    shipping: 2500,
    total: 2085680,
    url: "https://prod.danawa.com/bridge/loadingBridge.html?pcode=103451483&cmpnyc=EE715",
  }]);
});

test("captureVisibleShoppingProducts prefers Enuri ItemList structured data", async () => {
  const script = createNode({
    text: JSON.stringify({
      "@type": "ItemList",
      itemListElement: [{
        item: {
          "@type": "Product",
          name: "LG전자 2025 그램15 15ZD80T-GX56K",
          url: "https://www.enuri.com/detail.jsp?modelno=133583093",
          offers: { lowPrice: 1469350, highPrice: 6545290 },
        },
      }],
    }),
  });
  const context = loadBackground([], {
    selectorLists: { "script[type='application/ld+json']": [script] },
  });
  context.location.href = "https://www.enuri.com/search.jsp?keyword=LG%20그램";

  const result = await context.captureVisibleShoppingProducts("enuri", 1, "LG 그램");

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].mall, "에누리 가격비교");
  assert.equal(result.items[0].name, "LG전자 2025 그램15 15ZD80T-GX56K");
  assert.equal(result.items[0].price, 1469350);
  assert.equal(result.items[0].url, "https://www.enuri.com/detail.jsp?modelno=133583093");
});

test("captureVisibleShoppingProducts parses Coupang sale price without monthly-payment noise", async () => {
  const image = createNode({ attrs: { alt: "LG전자 2025 그램 프로16 노트북" } });
  const productLink = createNode({
    attrs: { href: "/vp/products/123456?itemId=777&vendorItemId=888" },
    selectors: { "img[alt]": image },
  });
  const title = createNode({ text: "LG전자 2025 그램 프로16 노트북" });
  const salePrice = createNode({ text: "1,789,000" });
  const originalPrice = createNode({ text: "2,190,000원" });
  const card = createNode({
    text: "LG전자 2025 그램 프로16 노트북 월 149,083원 1,789,000원 로켓배송",
    selectors: {
      "a[href*='/vp/products/'], a[href*='/np/products/']": productLink,
      ".name": title,
      ".sale-price .price-value, .price-value, [class*='priceValue'], [class*='PriceValue'], [data-testid='price']": salePrice,
      "del": originalPrice,
    },
  });
  const context = loadBackground([], { selectorLists: { "li.search-product": [card] } });
  context.location.href = "https://www.coupang.com/np/search?q=LG%20그램";

  const result = await context.captureVisibleShoppingProducts("coupang", 1, "LG 그램");

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].price, 1789000);
  assert.equal(result.items[0].registered_price, 2190000);
  assert.equal(result.items[0].url, "https://www.coupang.com/vp/products/123456?itemId=777&vendorItemId=888");
});
