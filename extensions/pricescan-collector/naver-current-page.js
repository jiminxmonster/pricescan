(() => {
  if (globalThis.PriceScanNaverCurrentPage) return;

  globalThis.PriceScanNaverCurrentPage = { capture };

  function capture(maxItems = 10) {
    const clean = (value) => String(value || "").replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
    const absoluteUrl = (value) => {
      try { return new URL(String(value || ""), location.href).href; } catch { return location.href; }
    };
    const parsePrice = (value) => {
      const match = clean(value).match(/([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,9})\s*원?/);
      if (!match) return 0;
      const price = Number(match[1].replace(/,/g, ""));
      return Number.isFinite(price) && price >= 1000 ? price : 0;
    };
    const first = (root, selectors) => {
      for (const selector of selectors) {
        const node = root.querySelector?.(selector);
        if (node) return node;
      }
      return null;
    };
    const firstText = (root, selectors) => clean(first(root, selectors)?.textContent || "");
    const shippingFrom = (text) => {
      const normalized = clean(text);
      if (/무료배송|배송비\s*무료/.test(normalized)) return 0;
      const match = normalized.match(/배송(?:비|료)?[^0-9]{0,12}([0-9]{1,3}(?:,[0-9]{3})+|[0-9]{4,7})\s*원/);
      return match ? Number(match[1].replace(/,/g, "")) : 0;
    };
    const query = (() => {
      const params = new URL(location.href).searchParams;
      return clean(params.get("query") || params.get("q") || params.get("keyword") || "");
    })();
    const bodyText = clean(document.body?.innerText || "");
    const warnings = [];
    if (/captcha|보안문자|비정상적인 접근|자동입력 방지|접근이 제한/i.test(bodyText)) {
      warnings.push("네이버 보안 확인 화면입니다. 사용자가 확인을 마친 뒤 다시 눌러 주세요.");
      return { query, pageUrl: location.href, items: [], warnings };
    }

    const selectors = [
      "li[class*='product_item']",
      "div[class*='product_item']",
      "li[class*='basicList_item']",
      "div[class*='basicList_item']",
      "div[class*='adProduct_item']",
      "div[class*='productCard']",
      "li[class*='productCard']",
    ];
    const cards = [];
    const seenNodes = new Set();
    for (const selector of selectors) {
      for (const node of document.querySelectorAll(selector)) {
        if (!seenNodes.has(node)) {
          seenNodes.add(node);
          cards.push(node);
        }
      }
    }

    if (!cards.length) {
      for (const anchor of document.querySelectorAll("a[href]")) {
        let node = anchor;
        for (let depth = 0; depth < 5 && node; depth += 1, node = node.parentElement) {
          const text = clean(node.innerText || node.textContent || "");
          if (text.length < 1800 && /[0-9][0-9,]*\s*원/.test(text)) {
            if (!seenNodes.has(node)) {
              seenNodes.add(node);
              cards.push(node);
            }
            break;
          }
        }
      }
    }

    const items = [];
    const seenProducts = new Set();
    const titleSelectors = [
      "a[class*='product_title']",
      "a[class*='basicList_link']",
      "a[class*='adProduct_link']",
      "div[class*='product_title'] a",
      "a[title]",
    ];
    const priceSelectors = [
      "[class*='price_num']",
      "[class*='price'] strong",
      "strong[class*='price']",
      "[data-testid*='price']",
    ];
    const mallSelectors = ["[class*='mall_title']", "[class*='mall_name']", "[class*='product_mall']", "a[class*='mall']"];

    for (const card of cards) {
      if (items.length >= maxItems) break;
      const text = clean(card.innerText || card.textContent || "");
      if (!text || !/[0-9][0-9,]*\s*원/.test(text)) continue;
      const titleNode = first(card, titleSelectors);
      const title = clean(titleNode?.getAttribute?.("title") || titleNode?.textContent || "");
      if (title.length < 4 || /^(광고|찜하기|구매하기|무료배송)$/.test(title)) continue;
      const price = parsePrice(firstText(card, priceSelectors)) || parsePrice(text);
      if (!price) continue;
      const productLink = titleNode?.closest?.("a[href]") || first(card, ["a[href]"]);
      const url = absoluteUrl(productLink?.getAttribute?.("href") || productLink?.href || location.href);
      const shipping = shippingFrom(text);
      const mall = firstText(card, mallSelectors) || "네이버 쇼핑";
      const key = `${title.toLowerCase().replace(/\s+/g, "")}|${price}|${url}`;
      if (seenProducts.has(key)) continue;
      seenProducts.add(key);
      items.push({
        source: "naver",
        mall: mall.slice(0, 40),
        name: title.slice(0, 240),
        price,
        registered_price: price,
        shipping,
        total: price + shipping,
        url,
      });
    }

    if (!items.length) warnings.push("현재 화면에서 네이버 상품명과 가격을 찾지 못했습니다.");
    if (items.length && items.length < maxItems) warnings.push(`현재 화면에 로드된 ${items.length}개만 가져왔습니다.`);
    return { query, pageUrl: location.href, items, warnings };
  }
})();
