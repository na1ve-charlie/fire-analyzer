import test from "node:test";
import assert from "node:assert/strict";
import { normalizeManualSnapshot, buildMetricIndex } from "../js/core/data/manual-snapshot.js";

test("合法手动快照会被规范化", () => {
  const snapshot = normalizeManualSnapshot({
    name: "CPI 快照",
    metrics: [
      {
        metricId: "macro.cn.cpi.yoy",
        sourceId: "nbs.manual",
        sourceUrl: "https://data.stats.gov.cn",
        date: "2026-09-01",
        publishedAt: "2026-10-09",
        fetchedAt: "2026-11-17",
        value: 0.9,
        unit: "%",
        frequency: "monthly"
      }
    ]
  });

  assert.equal(snapshot.valid, true);
  assert.equal(snapshot.errors.length, 0);
  assert.equal(snapshot.snapshot.metrics[0].metricId, "macro.cn.cpi.yoy");
  assert.equal(snapshot.snapshot.metrics[0].adapterVersion, "manual-snapshot.v0.1.0");
});

test("缺少来源或日期的快照会被拒绝", () => {
  const snapshot = normalizeManualSnapshot({
    metrics: [
      {
        metricId: "macro.cn.cpi.yoy",
        sourceId: "",
        sourceUrl: "",
        date: "202609",
        fetchedAt: "not-a-date",
        value: "bad",
        unit: "%"
      }
    ]
  });

  assert.equal(snapshot.valid, false);
  assert.ok(snapshot.errors.some((item) => item.includes("sourceId")));
  assert.ok(snapshot.errors.some((item) => item.includes("sourceUrl")));
  assert.ok(snapshot.errors.some((item) => item.includes("date")));
  assert.ok(snapshot.errors.some((item) => item.includes("fetchedAt")));
  assert.ok(snapshot.errors.some((item) => item.includes("value")));
});

test("快照可建立指标索引", () => {
  const snapshot = normalizeManualSnapshot({
    name: "测试快照",
    metrics: [
      {
        metricId: "macro.cn.cpi.yoy",
        sourceId: "nbs.manual",
        sourceUrl: "https://data.stats.gov.cn",
        date: "2026-09-01",
        fetchedAt: "2026-11-17",
        value: 0.9,
        unit: "%"
      }
    ]
  });

  const index = buildMetricIndex(snapshot.snapshot);
  assert.equal(index.get("macro.cn.cpi.yoy").value, 0.9);
});
