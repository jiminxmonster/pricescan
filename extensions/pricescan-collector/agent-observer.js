/* Generic, source-agnostic observation for the server-managed AI reader.
   It reads only visible text and public links. Form values, cookies, storage,
   credentials and screenshots are deliberately excluded. */
(() => {
  const visible = element => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return style.visibility !== 'hidden' && style.display !== 'none' && rect.width > 0 && rect.height > 0;
  };
  const clean = (value, limit) => String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
  function observe() {
    const contentRoot = ['main', '[role="main"]', '#content', '#container']
      .map(selector => document.querySelector(selector)).find(Boolean) || document.body;
    const text = clean(contentRoot?.innerText, 14000);
    const links = [];
    const seen = new Set();
    for (const anchor of contentRoot?.querySelectorAll?.('a[href]') || []) {
      if (links.length >= 100 || !visible(anchor)) continue;
      let url;
      try { url = new URL(anchor.href, location.href); } catch { continue; }
      if (url.protocol !== 'https:' || url.username || url.password || seen.has(url.href)) continue;
      const label = clean(anchor.innerText || anchor.getAttribute('aria-label') || anchor.title, 500);
      if (!label) continue;
      seen.add(url.href);
      links.push({ text: label, url: url.href });
    }
    return {
      page_url: location.href,
      page_title: clean(document.title, 500),
      visible_text: text,
      links,
      local_blocked: /(captcha|캡차|보안\s*확인|비정상적인\s*접근|접속이\s*(?:일시적으로\s*)?제한|로봇이\s*아닙니다)/i.test(text),
    };
  }
  globalThis.PriceScanAgentObserver = { observe };
  if (typeof module !== 'undefined') module.exports = { clean };
})();
