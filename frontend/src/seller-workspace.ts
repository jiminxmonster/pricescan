export const sellerSources = ["naver", "danawa", "enuri", "coupang"];
export const sellerSourceLabels: Record<string, string> = { naver: "네이버 쇼핑", danawa: "다나와", enuri: "에누리", coupang: "쿠팡" };

export type SellerOffer = {
  id: string; source: string; mall: string; name: string; price: number;
  registered_price?: number; shipping: number; total: number; url: string;
  is_excluded?: number | boolean; status?: string; exclusion_reason?: string;
  extraction_methods?: string[]; collected_at?: string;
  benefit_status?: "not_checked" | "confirmed" | "conditional" | "none" | "failed";
  benefit_summary?: string; benefit_condition?: string; detail_methods?: string[];
};
export type SellerSearchResult = {
  run: { id: string; query: string; status: string; created_at: string } | null;
  items: SellerOffer[]; warnings?: string[];
};
export type WatchedOffer = SellerOffer & {
  offer_key: string; seen_in_latest: boolean;
  history: Array<{total: number; collected_at: string}>;
};
export type Finance = { sale_price: number | null; cost_price: number | null; fee_rate: number | null; shipping_cost: number | null };
export type FinanceDraft = Record<keyof Finance, string>;
export type SellerProduct = Finance & {
  id: string; title: string; query_key: string; last_search_run_id: string | null;
  created_at: string; updated_at: string; monitored_count: number;
  financials: { ready: boolean; missing: string[]; profit: number | null; margin_rate: number | null };
  monitored?: WatchedOffer[]; search?: SellerSearchResult | null;
};
export const financeLabels: Record<keyof Finance, string> = {
  sale_price: "판매가", cost_price: "매입 원가", fee_rate: "수수료율", shipping_cost: "배송비",
};
export function financeToDraft(product: Finance): FinanceDraft {
  return Object.fromEntries(Object.keys(financeLabels).map((key) => [key, product[key as keyof Finance] == null ? "" : String(product[key as keyof Finance])])) as FinanceDraft;
}
export function parseFinance(draft: FinanceDraft): Finance {
  return Object.fromEntries(Object.entries(draft).map(([key, value]) => [key, value.trim() === "" ? null : Number(value)])) as Finance;
}
export function calculateSellerMargin(finance: Finance) {
  const missing = (Object.keys(financeLabels) as (keyof Finance)[]).filter((key) => finance[key] === null);
  const invalid = Object.entries(finance).some(([key, value]) => value !== null && (
    !Number.isFinite(value) || value < 0 || (key === "fee_rate" ? value >= 100 : !Number.isInteger(value) || value > 10_000_000_000)
  )) || finance.sale_price === 0;
  if (missing.length || invalid) return { ready: false as const, missing, invalid, profit: null, marginRate: null, fee: null };
  const sale = finance.sale_price!;
  const fee = Math.round(sale * finance.fee_rate! / 100);
  const profit = sale - finance.cost_price! - finance.shipping_cost! - fee;
  return { ready: true as const, missing, invalid: false, profit, marginRate: profit / sale * 100, fee };
}
export function safeOfferUrl(url: string): string | undefined {
  try {
    const parsed = new URL(url);
    return ["http:", "https:"].includes(parsed.protocol) && !parsed.username && !parsed.password ? parsed.href : undefined;
  } catch { return undefined; }
}
export function offerIdentity(offer: Pick<SellerOffer, "source" | "url">): string {
  const url = safeOfferUrl(offer.url);
  return `${offer.source}|${url ? url.split("#")[0] : offer.url}`;
}
export function isReviewRequired(item: SellerOffer): boolean {
  return Boolean(item.is_excluded || item.status === "abnormal" || item.price <= 0 || !safeOfferUrl(item.url));
}
export function importedSearchRequest(productId: string, runId: string) {
  if (!productId) return null;
  return runId
    ? { path: `/${productId}/search-results`, body: { run_id: runId } }
    : { path: `/${productId}`, body: undefined };
}
export function groupSellerOffers(items: readonly SellerOffer[], sources: readonly string[]) {
  return sources.map((source) => {
    const seen = new Set<string>();
    const rows = items.filter((item) => item.source === source).sort((a, b) => a.total - b.total).filter((item) => {
      const key = offerIdentity(item);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { source, rows, lowest: rows.find((row) => !isReviewRequired(row)) };
  });
}
