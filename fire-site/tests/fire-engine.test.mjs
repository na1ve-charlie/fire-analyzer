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

test("全盘口径：我的本金驱动现金流与储备计划，反推值仅作对照", () => {
  const target = calculateFirePlan(baseInput);
  const mine = calculateFirePlan({ ...baseInput, principal: 2500000, curveSource: "principal" });
  assert.equal(mine.chartStart, 2500000);
  assert.equal(mine.activePrincipal, 2500000);
  assert.equal(mine.projection.points[0].balance, 2500000);
  assert.notEqual(mine.projection.points[50].balance, target.projection.points[50].balance);
  // 反推值与保守目标是独立对照基准，不随口径切换改变。
  assert.ok(Math.abs(mine.reverse - target.reverse) < 1e-6);
  assert.ok(Math.abs(mine.conservative - target.conservative) < 1e-6);
  // 储备利息与完整目标跟随当前口径的起算本金。
  const expectedPad = 0.1 * (2500000 + mine.medicalReserve + mine.cashReserve);
  assert.ok(Math.abs(mine.reservePlan.safetyPad - expectedPad) < 0.01);
  assert.ok(Math.abs(mine.activeReserveInterest - (mine.medicalReserve + expectedPad) * mine.reserveRate) < 0.01);
  assert.ok(Math.abs(mine.activeFullTarget - (2500000 + mine.medicalReserve + mine.cashReserve) * 1.1) < 0.01);
  assert.ok(Math.abs(mine.principalGap - (2500000 - mine.reverse)) < 0.01);
});

test("全盘口径：反推目标模式下手动本金只影响余量对照", () => {
  const low = calculateFirePlan({ ...baseInput, principal: 1000000, curveSource: "target" });
  const high = calculateFirePlan({ ...baseInput, principal: 3000000, curveSource: "target" });
  assert.equal(low.chartStart, high.chartStart);
  assert.equal(low.projection.points[50].balance, high.projection.points[50].balance);
  assert.equal(low.activeReserveInterest, high.activeReserveInterest);
  assert.ok(high.principalGap > low.principalGap);
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

test("开启定投随通胀后市值、累计投入与股息增大，关闭时保持固定定投", () => {
  const input = { ...baseInput, dcaYears: 10, dcaMonthly: 2000, inflationRate: 2, dividendEnabled: true, dividendMode: "dividendOnly" };
  const fixed = calculateFirePlan(input);
  const growing = calculateFirePlan({ ...input, dcaInflationAdjust: true });
  assert.equal(fixed.dcaInflationAdjust, false);
  assert.equal(growing.dcaInflationAdjust, true);
  // 关闭时每项投入都等于基准月投额
  assert.equal(fixed.dcaTotalContributed, 2000 * 120);
  assert.equal(fixed.dcaFinalMonthly, 2000);
  // 开启后逐年递增
  assert.ok(growing.fundValue > fixed.fundValue);
  assert.ok(growing.dcaTotalContributed > fixed.dcaTotalContributed);
  assert.ok(growing.dcaFinalMonthly > 2000);
  assert.ok(growing.dividendPlan.annualIncome > fixed.dividendPlan.annualIncome);
  assert.ok(growing.reverse < fixed.reverse);
  // 末年每月投入 = 2000 × 1.02^9
  assert.ok(Math.abs(growing.dcaFinalMonthly - 2000 * Math.pow(1.02, 9)) < 0.01);
  assert.equal(growing.fundScenarios.length, 3);
});

test("定投随通胀开启时收益情景也同步递增", () => {
  const base = { ...baseInput, dcaYears: 10, dcaMonthly: 2000, dcaInflationAdjust: true, inflationRate: 2 };
  const result = calculateFirePlan(base);
  const current = result.fundScenarios.find((s) => s.label === "当前设置");
  assert.ok(Math.abs(current.value - result.fundValue) < 0.01);
  const low = result.fundScenarios.find((s) => s.rate === 4);
  const high = result.fundScenarios.find((s) => s.rate === 8);
  assert.ok(low.value < current.value && current.value < high.value);
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

test("细水长流反推本金保证全程不破产且期末归零（含红利中途加入）", () => {
  const cases = [
    { ...baseInput, years: 50, dcaYears: 25, dcaMonthly: 1200, dcaInflationAdjust: true, dividendEnabled: true, dividendMode: "dividendPrincipal", reserveReturnRate: 3.5 },
    { ...baseInput, years: 40, dividendEnabled: true, dividendMode: "dividendOnly", dcaYears: 10 },
    { ...baseInput, years: 30, returnRate: 4, inflationRate: 3, dividendEnabled: false }
  ];
  for (const input of cases) {
    const result = calculateFirePlan(input);
    const points = result.projection.points;
    assert.equal(result.projection.depletionYear, null, "反推本金不应在任何年份破产");
    assert.ok(Math.min(...points.map((point) => point.balance)) >= -0.5, "中途余额不应为负");
    assert.ok(Math.abs(points[points.length - 1].balance) < 1, "期末余额应恰好归零");
    // 曲线起点就是反推本金，验证两者一致（口径统一）
    assert.ok(Math.abs(result.chartStart - result.reverse) < 0.01);
  }
});

test("金鹅永续反推本金保证测算窗内购买力不减", () => {
  const cases = [
    { ...baseInput, scenario: "endowment", returnRate: 5.5 },
    { ...baseInput, scenario: "endowment", returnRate: 4.5, dividendEnabled: true, dividendMode: "dividendOnly", dcaYears: 10 }
  ];
  for (const input of cases) {
    const result = calculateFirePlan(input);
    const finalPoint = result.projection.points[input.years];
    const realEnd = finalPoint.balance / Math.pow(1 + input.inflationRate / 100, input.years);
    assert.equal(result.projection.depletionYear, null);
    assert.ok(realEnd >= result.chartStart - 2, "永续本金实际购买力不应下降");
  }
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
  assert.equal(result.assumptions.returnRate, 5.5);
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
