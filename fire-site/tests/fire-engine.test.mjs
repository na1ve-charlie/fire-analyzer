import test from "node:test";
import assert from "node:assert/strict";
import { calculateFirePlan, FIRE_ENGINE_VERSION } from "../js/core/fire-engine.js";

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

test("FIRE 引擎输出默认月支出与年支出", () => {
  const result = calculateFirePlan(baseInput);
  assert.equal(result.monthly, 3225);
  assert.equal(result.annual, 38700);
  assert.equal(result.engineVersion, FIRE_ENGINE_VERSION);
});

test("细水长流目标曲线期末归零", () => {
  const result = calculateFirePlan(baseInput);
  assert.ok(result.reverse > 0);
  assert.equal(result.chartStart, result.reverse);
  assert.equal(result.projection.points[50].balance, 0);
});

test("FIRE 后储备利息计入反推模型", () => {
  const result = calculateFirePlan(baseInput);
  assert.ok(result.reservePlan.annualReserveInterest > 0);
  assert.ok(result.reverse > 0);
});

test("储备利率为 0 时回到无储备利息口径", () => {
  const result = calculateFirePlan({ ...baseInput, reserveReturnRate: 0 });
  assert.equal(result.reservePlan.annualReserveInterest, 0);
  assert.ok(Math.abs(result.reverse - 1086719.57828386) < 0.01);
});

test("金鹅永续模式保持购买力", () => {
  const result = calculateFirePlan({ ...baseInput, scenario: "endowment" });
  assert.ok(result.reverse > 0);
  assert.ok(result.realEndBalance >= result.chartStart - 1);
});

test("红利低波定投输出市值与股息", () => {
  const result = calculateFirePlan(baseInput);
  assert.ok(result.fundValue > 0);
  assert.ok(result.fundAnnualDividend > 0);
  assert.ok(result.fundMonthlyDividend > 0);
  assert.equal(result.fundScenarios.length, 3);
});

test("异常输入会被安全收敛", () => {
  const result = calculateFirePlan({
    ...baseInput,
    returnRate: "not-a-number",
    inflationRate: 99,
    years: -5,
    principal: -100,
    expenses: [{ id: "food", amount: 999999, max: 5000 }]
  });
  assert.equal(result.assumptions.returnRate, 4.5);
  assert.equal(result.assumptions.inflationRate, 8);
  assert.equal(result.assumptions.years, 10);
  assert.equal(result.assumptions.principal, 0);
  assert.equal(result.monthly, 5000);
});

test("审计信息包含引擎版本与公式口径", () => {
  const result = calculateFirePlan(baseInput);
  assert.equal(result.audit.engineVersion, FIRE_ENGINE_VERSION);
  assert.ok(result.audit.formulas.requiredCapital.includes("净支出现值"));
});
