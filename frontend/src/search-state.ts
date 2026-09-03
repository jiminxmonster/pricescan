export type RestorableSearchPayload = {
  run: { status: string } | null;
};

export type MonitorableProduct = {
  source_item_id: string;
  monitoring_enabled: number | boolean;
};

export type SourceSearchResult = {
  source: string;
  price: number;
  total: number;
  is_excluded?: number | boolean;
  status?: string;
};

export function shouldRestoreSimpleSearch(payload: RestorableSearchPayload): boolean {
  return payload.run?.status === "completed";
}

export function isSourceItemMonitored(sourceItemId: string, products: readonly MonitorableProduct[]): boolean {
  return products.some((product) => product.source_item_id === sourceItemId && Boolean(product.monitoring_enabled));
}

export function visibleResultsBySource<T extends SourceSearchResult>(
  items: readonly T[],
  sources: readonly string[],
  limit = 10,
): T[] {
  return sources.flatMap((source) => items
    .filter((item) => item.source === source && !item.is_excluded && item.status !== "abnormal")
    .sort((left, right) => left.total - right.total || left.price - right.price)
    .slice(0, Math.max(0, limit)));
}

export function nextMonitoringRefreshAt(lastRunAt: number, intervalHours: number): number {
  const safeLastRunAt = Number.isFinite(lastRunAt) && lastRunAt > 0 ? lastRunAt : 0;
  const safeHours = Number.isFinite(intervalHours) && intervalHours > 0 ? intervalHours : 6;
  return safeLastRunAt ? safeLastRunAt + safeHours * 60 * 60 * 1000 : 0;
}

export function isMonitoringRefreshDue(now: number, lastRunAt: number, intervalHours: number): boolean {
  const nextRefreshAt = nextMonitoringRefreshAt(lastRunAt, intervalHours);
  return nextRefreshAt === 0 || now >= nextRefreshAt;
}
