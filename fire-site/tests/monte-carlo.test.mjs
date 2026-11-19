import test from "node:test";
import assert from "node:assert/strict";
import { calculateFirePlan, simulateCustomProjection } from "../js/core/fire-engine.js";
import { runMonteCarlo, MC_PROFILES, MC_ENGINE_VERSION, computePortfolioStats } from "../js/core/monte-carlo.js";

const baseInput = {
  scenario: "drawdown",
  curveSource: "principal",
  returnRate: 5.5,
  inflationRate: 2,
  years: 50,
  principal: 1885510,
  sideIncomeMonthly: 1200,
  reserveReturnRate: 3,
  medicalReserve: 150000,
  dcaYears: 10,
  dcaMonthly: 1200,
  dcaReturnRate: 6,
  dividendYield: 4,
  dividendEnabled: false,
  dividendMode: "dividendOnly",
  expenses: [
    { id: "property", name: "物业费", amount: 300, max: 2000 },
    { id: "maintenance", name: "房屋维护", amount: 250, max: 2000 },
    { id: "utilities", name: "水电燃气", amount: 300, max: 2000 },
    { id: "food", name: "饮食", amount: 1500, max: 5000 },
    { id: "medical", name: "稳健医疗", amount: 400, max: 3000 },
    { id: "daily", name: "日常开销", amount: 350, max: 3000 },
    { id: "appliance", name: "家电折旧", amount: 125, max: 2000 }
  ]
};

const baseResult = calculateFirePlan(baseInput);

function simulate(extra = {}) {
  return runMonteCarlo({
    fireResult: baseResult,
    fireInput: baseInput,
    profileKey: "balanced",
    runs: 1000,
    seed: 20261119,
    startingPrincipal: baseResult.conservative,
    ...extra
  });
}

test("蒙特卡洛输出引擎版本与资产配置预设", () => {
  const result = simulate();
  assert.equal(result.engineVersion, MC_ENGINE_VERSION);
  assert.equal(result.profileKey, "balanced");
  assert.equal(result.profile.label, MC_PROFILES.balanced.label);
  assert.equal(result.runs, 1000);
  assert.equal(result.seed, 20261119);
  assert.equal(result.years, 50);
});

test("固定种子完全可复现", () => {
  const first = simulate();
  const second = simulate();
  assert.equal(first.successRate, second.successRate);
  assert.equal(first.failedCount, second.failedCount);
  assert.equal(first.p10End, second.p10End);
  assert.equal(first.p50End, second.p50End);
  assert.equal(first.p90End, second.p90End);
  assert.deepEqual(first.endBalances, second.endBalances);
});

test("不同种子生成不同随机路径", () => {
  const first = simulate();
  const second = simulate({ seed: 20261120 });
  assert.notEqual(first.endBalances[0], second.endBalances[0]);
});

test("波动率上升会降低存续成功率", () => {
  const marginalPrincipal = { startingPrincipal: baseResult.reverse };
  const stable = simulate({ ...marginalPrincipal, sigmaOverride: 0 });
  const volatile = simulate({ ...marginalPrincipal, sigmaOverride: 0.5 });
  assert.equal(stable.successRate, 1);
  assert.ok(volatile.successRate < stable.successRate);
});

test("支出弹性在回撤超阈值时触发并提升成功率", () => {
  const highRisk = { sigmaOverride: 0.6, startingPrincipal: baseResult.reverse };
  const rigid = simulate(highRisk);
  const flexible = simulate({ ...highRisk, expenseFlexibility: true });
  assert.ok(rigid.flexAppliedCount === 0);
  assert.ok(flexible.flexAppliedCount > 0);
  assert.ok(flexible.successRate >= rigid.successRate);
});

test("所有路径逐年资金守恒误差为 0", () => {
  const result = simulate({ runs: 1000, expenseFlexibility: true, sigmaOverride: 0.4 });
  assert.ok(result.conservationMaxError < 0.01);
});

test("期末资产分位数有序，失败年份分桶求和一致", () => {
  const result = simulate({ sigmaOverride: 0.35 });
  assert.ok(result.p10End <= result.p50End);
  assert.ok(result.p50End <= result.p90End);
  assert.ok(result.p10Min <= result.p50Min);
  assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.count, 0), result.failedCount);
  assert.equal(result.failedCount + result.successCount, result.runs);
});

test("路径注入与固定收益率口径一致", () => {
  const path = new Array(50).fill(0.055);
  const withPath = calculateFirePlan({ ...baseInput, returnPath: path });
  const withoutPath = calculateFirePlan(baseInput);
  assert.ok(Math.abs(withPath.projection.points[50].balance - withoutPath.projection.points[50].balance) < 0.01);
  assert.equal(withPath.projection.points[25].yearReturn, 0.055);
});

test("现金流入口在支出被削减时仍保持守恒", () => {
  const result = simulateCustomProjection({
    principal: 1000000,
    annualExpense: 60000,
    annualReturn: 0.02,
    inflation: 0.03,
    years: 20,
    returnPath: new Array(20).fill(-0.15),
    expenseFlexibility: true,
    flexibilityDrawdown: 0.1,
    flexibilityCut: 0.2
  });
  const maxError = Math.max(...result.points.map((point) => {
    const expected = Math.max(0, point.startBalance + point.investmentReturn - point.withdrawal);
    return Math.abs(point.balance - expected);
  }));
  assert.ok(maxError < 0.01);
  assert.ok(result.points.some((point) => point.flexApplied));
});

test("我的组合持仓权重与截图一致", () => {
  const holdings = MC_PROFILES.myPortfolio.holdings;
  assert.equal(holdings.reduce((sum, item) => sum + item.weight, 0), 100);
  assert.deepEqual(holdings.map((item) => item.weight), [42, 18, 4.5, 4.5, 21, 10]);
  const micro = holdings.find((item) => item.name === "量化微盘");
  assert.ok(micro.fund.includes("华夏新锦绣"));
});

test("组合收益与波动按近十年回测数据加权计算", () => {
  const stats = computePortfolioStats(MC_PROFILES.myPortfolio.holdings);
  assert.ok(Math.abs(stats.mu - 0.0674365) < 1e-6);
  assert.ok(stats.sigma > 0.11 && stats.sigma < 0.14);
  assert.equal(MC_PROFILES.myPortfolio.backtest.cagr, 6.73);
  assert.equal(MC_PROFILES.myPortfolio.backtest.maxDrawdown, -20.15);
});

test("我的组合预设使用组合自身中枢而非全局收益率", () => {
  const result = simulate({ profileKey: "myPortfolio" });
  assert.equal(result.profileKey, "myPortfolio");
  assert.notEqual(result.mu, baseInput.returnRate / 100);
  assert.ok(Math.abs(result.mu - result.portfolioStats.mu) < 1e-9);
  assert.ok(Math.abs(result.sigma - result.portfolioStats.sigma) < 1e-9);
  assert.equal(result.holdings.length, 6);
});
