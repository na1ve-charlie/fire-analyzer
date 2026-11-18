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
  assert.equal(result.dividendPlan.enabled, false);
  assert.equal(result.projection.points.every((point) => point.dividendOffset === 0), true);
});

test("启用红利后按定投年限开始领取并降低反推本金", () => {
  const input = { ...baseInput, years: 60, dcaYears: 25, dividendEnabled: true, dividendMode: "dividendOnly" };
  const disabled = calculateFirePlan({ ...input, dividendEnabled: false });
  const enabled = calculateFirePlan(input);
  assert.equal(enabled.dividendPlan.startYear, 25);
  assert.equal(enabled.projection.points[24].dividendIncome, 0);
  assert.ok(enabled.projection.points[25].dividendIncome > 0);
  assert.ok(enabled.reverse < disabled.reverse);
  assert.ok(enabled.dividendReverseSaving > 0);
});

test("股息+本金模式按年金领取并在测算期末归零", () => {
  const input = { ...baseInput, years: 60, dcaYears: 25, dividendEnabled: true, dividendMode: "dividendPrincipal" };
  const dividendOnly = calculateFirePlan({ ...input, dividendMode: "dividendOnly" });
  const result = calculateFirePlan(input);
  assert.equal(result.dividendPlan.remainingYears, 36);
  assert.ok(result.dividendPlan.annualPayment > 0);
  assert.equal(result.projection.points[25].dividendIncome, result.dividendPlan.annualPayment);
  assert.ok(result.reverse < dividendOnly.reverse);
});

test("领取金额按通胀折算回 FIRE 起点的购买力", () => {
  const input = { ...baseInput, years: 60, dcaYears: 25, inflationRate: 3, dividendEnabled: true, dividendMode: "dividendOnly" };
  const result = calculateFirePlan(input);
  const plan = result.dividendPlan;
  assert.ok(plan.annualIncome > 0);
  assert.ok(plan.annualIncomeReal > 0);
  assert.ok(plan.annualIncomeReal < plan.annualIncome);
  // 折算因子 = 1 / (1.03 ^ 25)
  assert.ok(Math.abs(plan.purchasingPowerFactor - 1 / Math.pow(1.03, 25)) < 1e-9);
  assert.ok(Math.abs(plan.annualIncomeReal - plan.annualIncome / Math.pow(1.03, 25)) < 0.01);
  assert.ok(Math.abs(plan.monthlyIncomeReal - plan.annualIncomeReal / 12) < 0.01);
});

test("未启用红利时不计算购买力折算", () => {
  const result = calculateFirePlan(baseInput);
  assert.equal(result.dividendPlan.purchasingPowerFactor, 1);
  assert.equal(result.dividendPlan.annualIncome, 0);
  assert.equal(result.dividendPlan.annualIncomeReal, 0);
});

test("现金流曲线会定位拐点", () => {
  const result = calculateFirePlan(baseInput);
  assert.ok(result.projection.turningPoint);
  assert.equal(typeof result.projection.turningPoint.year, "number");
  assert.ok(["peak", "decline"].includes(result.projection.turningPoint.type));
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
