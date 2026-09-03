import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateSellerMargin, financeToDraft, groupSellerOffers, offerIdentity,
  parseFinance, safeOfferUrl, type Finance, type SellerOffer,
} from "../src/seller-workspace.ts";

const finance: Finance = { sale_price: 900000, cost_price: 750000, fee_rate: 8, shipping_cost: 3000 };
const offer = (id: string, total: number, extra = {}): SellerOffer => ({
  id, source: "naver", mall: "검토 판매자", name: "노트북", price: total, total,
  shipping: 0, url: `https://example.com/product/${id}`, ...extra,
});

test("blank financial fields remain null, not zero or competitor costs", () => {
  const draft = financeToDraft({ sale_price: null, cost_price: null, fee_rate: null, shipping_cost: null });
  assert.deepEqual(Object.values(draft), ["", "", "", ""]);
  const summary = calculateSellerMargin(parseFinance(draft));
  assert.equal(summary.ready, false);
  assert.equal(summary.profit, null);
  assert.equal(summary.missing.length, 4);
});
test("zero fees and delivery are valid explicit inputs", () => {
  const values = { ...finance, fee_rate: 0, shipping_cost: 0 };
  assert.equal(financeToDraft(values).fee_rate, "0");
  assert.equal(calculateSellerMargin(values).profit, 150000);
  assert.equal(calculateSellerMargin({ ...values, shipping_cost: null }).ready, false);
});
test("900,000 KRW scenario and immediate reduced-price margin", () => {
  assert.equal(calculateSellerMargin(finance).profit, 75000);
  assert.equal(calculateSellerMargin(finance).marginRate, 75000 / 900000 * 100);
  assert.equal(calculateSellerMargin({ ...finance, sale_price: 880000 }).profit, 56600);
  assert.ok(calculateSellerMargin({ ...finance, sale_price: 800000 }).profit! < 0);
});
test("fee half-won rounds up consistently with backend", () => {
  assert.equal(calculateSellerMargin({ sale_price: 101, cost_price: 0, shipping_cost: 0, fee_rate: 50 }).fee, 51);
});
test("rejects invalid, negative, fractional KRW and out-of-range fields", () => {
  for (const changes of [{sale_price: 0}, {cost_price: -1}, {sale_price: 1.1}, {sale_price: Infinity}, {fee_rate: NaN}, {fee_rate: 100}, {fee_rate: -1}, {shipping_cost: 1e11}]) {
    assert.equal(calculateSellerMargin({...finance, ...changes}).invalid, true);
  }
});
test("grouping keeps reviewable parser errors but excludes them from lowest summary", () => {
  const rows = [offer("valid", 900000), offer("accessory", 1000, {is_excluded: 1}), offer("abnormal", 2000, {status: "abnormal"})];
  const [group] = groupSellerOffers(rows, ["naver"]);
  assert.equal(group.rows.length, 3);
  assert.equal(group.lowest?.id, "valid");
  assert.equal(rows[0].id, "valid"); // no mutation
});
test("show all genuine candidates, never synthesize five results", () => {
  const groups = groupSellerOffers([offer("one", 900000)], ["naver", "danawa"]);
  assert.equal(groups[0].rows.length, 1);
  assert.equal(groups[1].rows.length, 0);
  assert.equal(groups[1].lowest, undefined);
  assert.equal(groupSellerOffers(Array.from({length: 14}, (_, i) => offer(String(i), 900000 + i)), ["naver"])[0].rows.length, 14);
});
test("stable source/URL identity retains selection when run item IDs change", () => {
  const first = offer("old-run", 900000, {url: "https://EXAMPLE.com/item?a=1#top"});
  const second = offer("new-run", 880000, {url: "https://example.com/item?a=1"});
  assert.equal(offerIdentity(first), offerIdentity(second));
  assert.equal(groupSellerOffers([first, second], ["naver"])[0].rows.length, 1);
  assert.notEqual(offerIdentity(first), offerIdentity({...second, url: "https://example.com/item?a=2"}));
});
test("only http(s) product links without embedded credentials are actionable", () => {
  for (const url of ["javascript:alert(1)", "file:///etc/passwd", "data:text/html,a", "https://user:password@example.com/", "invalid"]) assert.equal(safeOfferUrl(url), undefined);
  assert.equal(safeOfferUrl("https://example.com/product"), "https://example.com/product");
});
