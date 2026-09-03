import assert from "node:assert/strict";
import test from "node:test";

import {
  isMonitoringRefreshDue,
  isSourceItemMonitored,
  nextMonitoringRefreshAt,
  shouldRestoreSimpleSearch,
  visibleResultsBySource,
} from "../src/search-state.ts";

test("restores the result panel for a persisted completed search", () => {
  assert.equal(shouldRestoreSimpleSearch({ run: { status: "completed" } }), true);
});

test("keeps the result panel collapsed when no completed search exists", () => {
  assert.equal(shouldRestoreSimpleSearch({ run: null }), false);
  assert.equal(shouldRestoreSimpleSearch({ run: { status: "failed" } }), false);
});

test("marks only active prepared products as monitored", () => {
  const products = [
    { source_item_id: "price-on", monitoring_enabled: 1 },
    { source_item_id: "price-off", monitoring_enabled: 0 },
  ];

  assert.equal(isSourceItemMonitored("price-on", products), true);
  assert.equal(isSourceItemMonitored("price-off", products), false);
  assert.equal(isSourceItemMonitored("missing", products), false);
});

test("keeps up to ten valid rows for every selected shopping source", () => {
  const items = [
    ...Array.from({ length: 12 }, (_, index) => ({ source: "danawa", price: 12000 - index, total: 12000 - index })),
    ...Array.from({ length: 11 }, (_, index) => ({ source: "enuri", price: 22000 - index, total: 22000 - index })),
    { source: "coupang", price: 9000, total: 9000, is_excluded: 1 },
    { source: "coupang", price: 9500, total: 9500 },
  ];

  const visible = visibleResultsBySource(items, ["danawa", "enuri", "coupang"]);

  assert.equal(visible.filter((item) => item.source === "danawa").length, 10);
  assert.equal(visible.filter((item) => item.source === "enuri").length, 10);
  assert.equal(visible.filter((item) => item.source === "coupang").length, 1);
  assert.equal(visible[0].price, 11989);
});

test("calculates the next monitored-product refresh in hours", () => {
  const lastRunAt = Date.UTC(2026, 7, 19, 3, 0, 0);
  const nextRunAt = Date.UTC(2026, 7, 19, 9, 0, 0);

  assert.equal(nextMonitoringRefreshAt(lastRunAt, 6), nextRunAt);
  assert.equal(isMonitoringRefreshDue(nextRunAt - 1, lastRunAt, 6), false);
  assert.equal(isMonitoringRefreshDue(nextRunAt, lastRunAt, 6), true);
  assert.equal(isMonitoringRefreshDue(nextRunAt, 0, 6), true);
});
