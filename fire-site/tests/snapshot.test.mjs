import test from "node:test";
import assert from "node:assert/strict";
import { calculateFirePlan } from "../js/core/fire-engine.js";
import { evaluateRiskRules } from "../js/core/risk-engine.js";
import {
  createSnapshotPayload,
  parseSnapshotPayload,
  SNAPSHOT_SCHEMA,
  SNAPSHOT_SCHEMA_VERSION
} from "../js/core/snapshot.js";

const baseInput = {
  scenario: "drawdown",
  curveSource: "target",
  returnRate: 4.5,
  inflationRate: 2,
  years: 50,
  principal: 1885510,
  sideIncomeMonthly: 2000,
  reserveReturnRate: 2.25,
  medicalReserve: 150000,
  dcaYears: 10,
  dcaMonthly: 2000,
  dcaReturnRate: 6,
  dividendYield: 4,
  expenses: [
    { id: "property", amount: 300, max: 2000 },
    { id: "maintenance", amount: 250, max: 2000 },
    { id: "utilities", amount: 300, max: 2000 },
    { id: "food", amount: 1500, max: 5000 },
    { id: "medical", amount: 400, max: 3000 },
    { id: "daily", amount: 350, max: 3000 },
    { id: "appliance", amount: 125, max: 2000 }
  ]
};

function buildSnapshot() {
  const result = calculateFirePlan(baseInput);
  const risk = evaluateRiskRules({ fireResult: result });
  const state = { ...baseInput, expenses: baseInput.expenses.map((item) => ({ ...item })) };
  return createSnapshotPayload({ state, result, risk, exportedAt: "2026-11-17T00:00:00.000Z" });
}

test("方案快照包含完整引擎版本与审计信息", () => {
  const payload = buildSnapshot();
  assert.equal(payload.schema, SNAPSHOT_SCHEMA);
  assert.equal(payload.schemaVersion, SNAPSHOT_SCHEMA_VERSION);
  assert.equal(payload.exportedAt, "2026-11-17T00:00:00.000Z");
  assert.equal(payload.engineVersions.fire, "fire-engine.2.0.0-alpha.1");
  assert.equal(payload.engineVersions.risk, "risk-engine.v0.1.0");
  assert.ok(payload.result.audit.formulas.requiredCapital.includes("净支出现值"));
});

test("合法方案快照可以解析恢复", () => {
  const payload = buildSnapshot();
  const parsed = parseSnapshotPayload(JSON.stringify(payload));
  assert.equal(parsed.valid, true);
  assert.equal(parsed.errors.length, 0);
  assert.equal(parsed.value.state.principal, 1885510);
  assert.equal(parsed.value.state.expenses.length, 7);
});

test("非法 JSON 会被拒绝", () => {
  const parsed = parseSnapshotPayload("{bad-json");
  assert.equal(parsed.valid, false);
  assert.equal(parsed.errors.length, 1);
});

test("错误 schema 的快照会被拒绝", () => {
  const parsed = parseSnapshotPayload(JSON.stringify({ schema: "bad", schemaVersion: 1 }));
  assert.equal(parsed.valid, false);
  assert.ok(parsed.errors.some((error) => error.includes(SNAPSHOT_SCHEMA)));
});
