import test from "node:test";
import assert from "node:assert/strict";
import { calculateFirePlan } from "../js/core/fire-engine.js";
import { evaluateRiskRules, RISK_ENGINE_VERSION } from "../js/core/risk-engine.js";

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

test("默认方案不触发 MVP 风险规则", () => {
  const fireResult = calculateFirePlan(baseInput);
  const risk = evaluateRiskRules({ fireResult });
  assert.equal(risk.triggeredCount, 0);
  assert.equal(risk.riskEngineVersion, RISK_ENGINE_VERSION);
  assert.equal(risk.totalRules > 0, true);
});

test("预期本金不足会触发关键风险", () => {
  const fireResult = calculateFirePlan({ ...baseInput, principal: 100000 });
  const risk = evaluateRiskRules({ fireResult });
  const triggered = risk.results.find((item) => item.ruleId === "principal.below.required");
  assert.equal(triggered.triggered, true);
  assert.equal(triggered.severity, "critical");
});

test("医疗储备覆盖月数偏低会触发储备风险", () => {
  const fireResult = calculateFirePlan({ ...baseInput, medicalReserve: 0 });
  const risk = evaluateRiskRules({ fireResult });
  const triggered = risk.results.find((item) => item.ruleId === "medical.reserve.months.low");
  assert.equal(triggered.triggered, true);
  assert.equal(triggered.severity, "warning");
});

test("高收益率假设会触发收益率风险", () => {
  const fireResult = calculateFirePlan({ ...baseInput, returnRate: 12 });
  const risk = evaluateRiskRules({ fireResult });
  const triggered = risk.results.find((item) => item.ruleId === "return.rate.high");
  assert.equal(triggered.triggered, true);
});

test("风险评估是确定性的", () => {
  const fireResult = calculateFirePlan(baseInput);
  const first = evaluateRiskRules({ fireResult });
  const second = evaluateRiskRules({ fireResult });
  assert.deepEqual(first.results, second.results);
});
