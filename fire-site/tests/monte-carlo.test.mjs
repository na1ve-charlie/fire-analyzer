import test from "node:test";
import assert from "node:assert/strict";
import { calculateFirePlan, simulateCustomProjection } from "../js/core/fire-engine.js";
import {
  runMonteCarlo, MC_PROFILES, MC_ENGINE_VERSION, MC_PROFILE_GROUPS, computePortfolioStats,
  computeRequiredPrincipalDistribution, analyzeSuccessLevers
} from "../js/core/monte-carlo.js";

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
  assert.ok(result.p1End <= result.p5End);
  assert.ok(result.p5End <= result.p10End);
  assert.ok(result.p10End <= result.p25End);
  assert.ok(result.p25End <= result.p50End);
  assert.ok(result.p50End <= result.p75End);
  assert.ok(result.p75End <= result.p90End);
  assert.ok(result.p10Min <= result.p25Min);
  assert.ok(result.p25Min <= result.p50Min);
  assert.ok(result.p50Min <= result.p75Min);
  assert.ok(result.p75Min <= result.p90Min);
  assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.count, 0), result.failedCount);
  assert.equal(result.failedCount + result.successCount, result.runs);
});

test("分位数口径：失败率低于分位时该分位为正，高于则为零", () => {
  // 高成功率：失败率 2.4% < 5%，P5 应为真实的正余额
  const safe = simulate({ startingPrincipal: baseResult.conservative * 1.5, sigmaOverride: 0.2 });
  if (safe.failedCount / safe.runs < 0.05) {
    assert.ok(safe.p5End > 0, "失败率 <5% 时 P5 应为正数");
  }
  // 高失败率：失败率 >25%，P25 必为 0
  const risky = simulate({ startingPrincipal: baseResult.reverse * 0.7, sigmaOverride: 0.3 });
  if (risky.failedCount / risky.runs > 0.25) {
    assert.equal(risky.p25End, 0);
  }
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

test("六个校准组合持仓权重合计为 100%", () => {
  for (const key of MC_PROFILE_GROUPS.calibratedNames) {
    const profile = MC_PROFILES[key];
    assert.ok(profile.calibrated, `${key} 应为回测校准组合`);
    assert.equal(profile.holdings.reduce((sum, item) => sum + item.weight, 0), 100);
  }
  assert.deepEqual(MC_PROFILES.portfolioA.holdings.map((item) => item.weight), [60, 18, 7.5, 4.5, 10]);
  for (const key of ["portfolioB57", "portfolioB10y", "portfolioB30y", "portfolioB10etf", "portfolioB30etf"]) {
    assert.deepEqual(
      MC_PROFILES[key].holdings.map((item) => item.weight),
      [42, 18, 7.5, 4.5, 18, 10]
    );
  }
  const bond57 = MC_PROFILES.portfolioB57.holdings.find((item) => item.name === "5–7年利率债");
  assert.ok(bond57.fund.includes("CBA05841.CB"));
  const bond30etf = MC_PROFILES.portfolioB30etf.holdings.find((item) => item.name === "30年国债ETF");
  assert.ok(bond30etf.fund.includes("511090.SH"));
});

test("六个组合使用各自回测样本的中枢与波动率", () => {
  // 组合一：2007 年以来长样本。
  assert.equal(MC_PROFILES.portfolioA.backtest.period, "2007-01-04 ~ 2026-11-09");
  assert.equal(MC_PROFILES.portfolioA.backtest.cagr, 13.48);
  assert.equal(MC_PROFILES.portfolioA.backtest.volatility, 17.43);
  assert.equal(MC_PROFILES.portfolioA.backtest.maxDrawdown, -54.49);
  assert.equal(MC_PROFILES.portfolioA.backtest.sharpe, 0.76);
  // 组合二指数版：同一 2011 年起样本。
  for (const key of ["portfolioB57", "portfolioB10y", "portfolioB30y"]) {
    assert.equal(MC_PROFILES[key].backtest.period, MC_PROFILE_GROUPS.indexSample);
  }
  assert.equal(MC_PROFILES.portfolioB57.backtest.cagr, 10.75);
  assert.equal(MC_PROFILES.portfolioB57.backtest.volatility, 10.74);
  assert.equal(MC_PROFILES.portfolioB57.backtest.maxDrawdown, -22.18);
  assert.equal(MC_PROFILES.portfolioB57.backtest.sharpe, 0.91);
  assert.equal(MC_PROFILES.portfolioB10y.backtest.cagr, 10.73);
  assert.equal(MC_PROFILES.portfolioB10y.backtest.volatility, 10.73);
  assert.equal(MC_PROFILES.portfolioB10y.backtest.maxDrawdown, -22.2);
  assert.equal(MC_PROFILES.portfolioB10y.backtest.sharpe, 0.91);
  assert.equal(MC_PROFILES.portfolioB30y.backtest.cagr, 11.12);
  assert.equal(MC_PROFILES.portfolioB30y.backtest.volatility, 10.73);
  assert.equal(MC_PROFILES.portfolioB30y.backtest.maxDrawdown, -21.87);
  assert.equal(MC_PROFILES.portfolioB30y.backtest.sharpe, 0.94);
  // 组合二 ETF 版：同一 2023-06 起短样本。
  for (const key of ["portfolioB10etf", "portfolioB30etf"]) {
    assert.equal(MC_PROFILES[key].backtest.period, MC_PROFILE_GROUPS.etfSample);
  }
  assert.equal(MC_PROFILES.portfolioB10etf.backtest.cagr, 10.98);
  assert.equal(MC_PROFILES.portfolioB10etf.backtest.volatility, 8.55);
  assert.equal(MC_PROFILES.portfolioB10etf.backtest.maxDrawdown, -6.71);
  assert.equal(MC_PROFILES.portfolioB10etf.backtest.sharpe, 1.15);
  assert.equal(MC_PROFILES.portfolioB30etf.backtest.cagr, 11.62);
  assert.equal(MC_PROFILES.portfolioB30etf.backtest.volatility, 8.51);
  assert.equal(MC_PROFILES.portfolioB30etf.backtest.maxDrawdown, -6.27);
  assert.equal(MC_PROFILES.portfolioB30etf.backtest.sharpe, 1.23);
});

test("校准组合直接使用回测 CAGR 与波动率而非持仓推算", () => {
  const result = simulate({ profileKey: "portfolioA" });
  assert.equal(result.profileKey, "portfolioA");
  assert.equal(result.portfolioStats, null);
  assert.ok(Math.abs(result.mu - MC_PROFILES.portfolioA.backtest.cagr / 100) < 1e-9);
  assert.ok(Math.abs(result.sigma - MC_PROFILES.portfolioA.backtest.volatility / 100) < 1e-9);
  assert.equal(result.holdings.length, 5);
  const stable = simulate({ profileKey: "portfolioB57" });
  assert.ok(stable.sigma < result.sigma, "组合二 5–7 年基线波动应低于组合一");
  const bond10Etf = simulate({ profileKey: "portfolioB10etf" });
  assert.ok(Math.abs(bond10Etf.mu - 0.1098) < 1e-9);
  assert.ok(Math.abs(bond10Etf.sigma - 0.0855) < 1e-9);
  const bond30Etf = simulate({ profileKey: "portfolioB30etf" });
  assert.ok(Math.abs(bond30Etf.mu - 0.1162) < 1e-9);
  assert.ok(bond30Etf.holdings.length, 6);
});

test("全盘口径：手动本金变化会同步改变 MC 起点与成功率", () => {
  const lowInput = { ...baseInput, principal: 1000000, curveSource: "principal" };
  const highInput = { ...baseInput, principal: 4000000, curveSource: "principal" };
  const low = calculateFirePlan(lowInput);
  const high = calculateFirePlan(highInput);
  const common = { profileKey: "balanced", runs: 300, seed: 20261119 };
  const lowMc = runMonteCarlo({ ...common, fireResult: low, fireInput: lowInput, startingPrincipal: low.chartStart });
  const highMc = runMonteCarlo({ ...common, fireResult: high, fireInput: highInput, startingPrincipal: high.chartStart });
  assert.equal(lowMc.startingPrincipal, 1000000);
  assert.equal(highMc.startingPrincipal, 4000000);
  assert.ok(highMc.successRate > lowMc.successRate);
});

test("失败归因：主因分布合计等于失败数，反事实救活率在 0~1 之间", () => {
  const result = simulate({ profileKey: "balanced", startingPrincipal: baseResult.reverse, withAttribution: true });
  const attr = result.failureAttribution;
  assert.ok(attr, "应产出失败归因");
  assert.equal(attr.failedCount, result.failedCount);
  const primaryTotal = attr.primary.reduce((sum, item) => sum + item.count, 0);
  assert.equal(primaryTotal, result.failedCount);
  assert.ok(Math.abs(attr.primary.reduce((sum, item) => sum + item.share, 0) - 1) < 1e-9);
  for (const remedy of attr.remedies) {
    assert.ok(remedy.share >= 0 && remedy.share <= 1);
    assert.ok(remedy.rescued >= 0 && remedy.rescued <= result.failedCount);
  }
  assert.ok(attr.geoSuccess > attr.geoFailed, "成功路径几何收益应高于失败路径");
});

test("失败归因：无失败路径时不产出归因", () => {
  const safe = simulate({ sigmaOverride: 0, startingPrincipal: baseResult.conservative * 3, withAttribution: true });
  assert.equal(safe.failedCount, 0);
  assert.equal(safe.failureAttribution, null);
});

test("自定义模拟次数在 500–20000 之间生效并参与分桶输出", () => {
  const custom = simulate({ runs: 750 });
  assert.equal(custom.runs, 750);
  assert.equal(custom.buckets.reduce((sum, bucket) => sum + bucket.count, 0), custom.failedCount);
  assert.ok(Array.isArray(custom.bucketPaths));
  const belowMin = simulate({ runs: 50 });
  assert.equal(belowMin.runs, 100);
  const aboveMax = simulate({ runs: 99999 });
  assert.equal(aboveMax.runs, 20000);
});

test("耗尽年份分桶输出典型路径：分桶对齐、样本合计等于失败数、资产守恒", () => {
  const result = simulate({ profileKey: "balanced", startingPrincipal: baseResult.reverse });
  const paths = result.bucketPaths;
  assert.ok(paths.some(Boolean), "存在失败路径时应产出典型路径");
  // bucketPaths 与 buckets 必须逐索引对齐（空桶为 null），否则前端点击柱形会打开错误的区间。
  assert.equal(paths.length, result.buckets.length);
  paths.forEach((bucket, index) => {
    if (bucket === null) {
      assert.equal(result.buckets[index].count, 0, `空桶 ${index} 对应的统计计数也应为 0`);
      return;
    }
    assert.equal(bucket.sampleCount, result.buckets[index].count);
    const sampledTotal = paths.reduce((sum, bucket) => sum + (bucket?.sampleCount || 0), 0);
    assert.equal(sampledTotal, result.failedCount);
    assert.ok(bucket.start >= 1 && bucket.end <= result.years);
    assert.ok(bucket.sampleCount > 0);
    assert.ok(bucket.depletionYear >= bucket.start && bucket.depletionYear <= bucket.end
      || (bucket.depletionYear === result.years && bucket.end === result.years));
    assert.equal(bucket.medianPath.length, result.years);
    assert.equal(bucket.points.length, result.years + 1);
    assert.equal(bucket.points[0].balance, result.startingPrincipal);
    // 逐点资金守恒：年末资产 = 期初资产 + 投资收益 − 实际提取。
    for (const point of bucket.points) {
      const expected = Math.max(0, point.startBalance + point.investmentReturn - point.withdrawal);
      assert.ok(Math.abs(point.balance - expected) < 0.01);
    }
  });
  // 固定种子下典型路径完全可复现。
  const again = simulate({ profileKey: "balanced", startingPrincipal: baseResult.reverse });
  assert.deepEqual(
    again.bucketPaths.map((bucket) => bucket ? bucket.medianPath.map((r) => Number(r.toFixed(12))) : null),
    paths.map((bucket) => bucket ? bucket.medianPath.map((r) => Number(r.toFixed(12))) : null)
  );
});

test("无失败路径时 bucketPaths 为空数组", () => {
  const safe = simulate({ sigmaOverride: 0, startingPrincipal: baseResult.conservative * 3 });
  assert.equal(safe.failedCount, 0);
  assert.deepEqual(safe.bucketPaths, []);
});

test("空桶为 null 且与统计桶索引对齐", () => {
  // 用低波动构造只有少数桶有样本的场景，验证 null 占位逻辑。
  const result = simulate({ profileKey: "balanced", startingPrincipal: baseResult.reverse, sigmaOverride: 0.12 });
  if (result.failedCount === 0) {
    assert.deepEqual(result.bucketPaths, []);
    return;
  }
  assert.equal(result.bucketPaths.length, result.buckets.length);
  result.bucketPaths.forEach((bucket, index) => {
    if (bucket === null) assert.equal(result.buckets[index].count, 0);
    else assert.equal(bucket.sampleCount, result.buckets[index].count);
  });
});

test("失败归因：高波动组合的主因更偏向顺序风险与极端亏损", () => {
  const common = { withAttribution: true, runs: 600, startingPrincipal: baseResult.reverse };
  const stable = simulate({ ...common, profileKey: "balanced" });
  const volatile = simulate({ ...common, profileKey: "equity100" });
  const shareOf = (attr, key) => attr.primary.find((p) => p.key === key).share;
  const stableRisk = shareOf(stable.failureAttribution, "order") + shareOf(stable.failureAttribution, "tail");
  const volatileRisk = shareOf(volatile.failureAttribution, "order") + shareOf(volatile.failureAttribution, "tail");
  assert.ok(volatileRisk > 0.5, "高波动下顺序/尾部风险应占主导");
  assert.ok(volatileRisk >= stableRisk, "高波动下顺序/尾部风险占比不应低于低波动");
});

test("反推本金分位随目标胜率单调上升", () => {
  const dist = computeRequiredPrincipalDistribution({
    fireResult: baseResult,
    fireInput: baseInput,
    profileKey: "portfolioA",
    runs: 300,
    startingPrincipal: baseResult.chartStart
  });
  assert.ok(dist.p50 <= dist.p80);
  assert.ok(dist.p80 <= dist.p90);
  assert.ok(dist.p90 <= dist.p95);
});

test("胜率工具箱输出目标本金与多种提升杠杆", () => {
  const analysis = analyzeSuccessLevers({
    fireResult: baseResult,
    fireInput: baseInput,
    targetRate: 0.9,
    runs: 300,
    startingPrincipal: baseResult.chartStart,
    profileKey: "portfolioA"
  });
  assert.ok(analysis.targetPrincipal > 0);
  assert.ok(analysis.baselineSuccessRate >= 0 && analysis.baselineSuccessRate <= 1);
  // 8 个可勾选项：支出降低 / 每月额外收入 / 过渡期兼职收入 / 推迟 FIRE / 提高初始本金 / 红利退休金 / 支出弹性 / 支出弹性强化档。
  assert.equal(analysis.levers.length, 8);
  assert.equal(analysis.profiles.length, Object.keys(MC_PROFILES).length);
  assert.ok(analysis.levers.some((item) => item.key === "expenseCut"));
  assert.ok(analysis.levers.some((item) => item.key === "delay"));
  assert.ok(analysis.levers.some((item) => item.key === "extraPrincipal"));
  assert.ok(analysis.levers.some((item) => item.key === "flexibility"));
  assert.ok(analysis.levers.some((item) => item.key === "flexibilityStrong"));
  assert.ok(analysis.levers.some((item) => item.key === "bridge"));
  assert.equal(analysis.dividendEnabledInBaseline, false);
  assert.ok(analysis.levers.some((item) => item.key === "dividend"));
  // 未传 selection 时无勾选组合。
  assert.equal(analysis.hasSelection, false);
  assert.equal(analysis.combined, null);
});

test("过渡期兼职收入杠杆：提升成功率且只在 FIRE 后前 N 年生效", () => {
  // 单项杠杆：前 5 年兼职 3000/月应提升成功率。
  const withBridge = analyzeSuccessLevers({
    fireResult: baseResult,
    fireInput: baseInput,
    targetRate: 0.9,
    runs: 500,
    startingPrincipal: baseResult.reverse,
    profileKey: "portfolioA",
    selection: {
      params: { bridgeMonthly: 3000, bridgeYears: 5 },
      checked: { bridge: true }
    }
  });
  const bridge = withBridge.levers.find((item) => item.key === "bridge");
  assert.ok(bridge);
  assert.ok(bridge.successRate > withBridge.baselineSuccessRate, "过渡期收入应提升成功率");
  // 组合勾选：桥接收入进入组合与反推口径。
  assert.ok(withBridge.hasSelection);
  assert.ok(withBridge.combined);
  assert.ok(withBridge.combined.details.some((text) => text.includes("兼职")));
  // 参数为 0 时杠杆行仍展示但不重跑。
  const empty = analyzeSuccessLevers({
    fireResult: baseResult, fireInput: baseInput, targetRate: 0.9, runs: 300,
    startingPrincipal: baseResult.chartStart, profileKey: "portfolioA",
    selection: { params: { bridgeMonthly: 0, bridgeYears: 0 }, checked: { bridge: false } }
  });
  const emptyBridge = empty.levers.find((item) => item.key === "bridge");
  assert.equal(emptyBridge.successRate, empty.baselineSuccessRate);
});

test("支出弹性强化档：救活率不低于普通档", () => {
  const analysis = analyzeSuccessLevers({
    fireResult: baseResult, fireInput: baseInput, targetRate: 0.9, runs: 500,
    startingPrincipal: baseResult.reverse, profileKey: "equity100"
  });
  const flex = analysis.levers.find((item) => item.key === "flexibility");
  const strong = analysis.levers.find((item) => item.key === "flexibilityStrong");
  assert.ok(strong.successRate >= flex.successRate, "回撤 30% 减 30% 的效果应不低于回撤 20% 减 10%");
});

test("胜率工具箱勾选组合完整重算", () => {
  const analysis = analyzeSuccessLevers({
    fireResult: baseResult,
    fireInput: baseInput,
    targetRate: 0.9,
    runs: 300,
    startingPrincipal: baseResult.chartStart,
    profileKey: "portfolioA",
    selection: {
      params: { expenseCutPct: 10, extraMonthlyIncome: 1000, delayYears: 3, extraPrincipal: 100000 },
      checked: { expenseCut: true, extraIncome: false, delay: false, extraPrincipal: true, dividendIncome: false, flexibility: false },
      dividendIncome: false,
      expenseFlexibility: false
    }
  });
  assert.equal(analysis.hasSelection, true);
  assert.ok(analysis.combined);
  // 组合口径：支出降 10%，本金 = 原本金 + 10 万（未勾选推迟，不计复利增长）。
  assert.ok(analysis.combined.annualExpense < baseResult.annual);
  assert.ok(analysis.combined.principal > baseResult.chartStart);
  assert.ok(analysis.combined.targetPrincipal > 0);
  // 组合成功率按同一批随机路径重算，提升幅度与基线可比。
  assert.ok(analysis.combined.successRate >= 0 && analysis.combined.successRate <= 1);
  assert.ok(analysis.combined.details.length >= 2);
});

test("胜率工具箱勾选参数为 0 时不重复计算", () => {
  const analysis = analyzeSuccessLevers({
    fireResult: baseResult,
    fireInput: baseInput,
    targetRate: 0.9,
    runs: 300,
    startingPrincipal: baseResult.chartStart,
    profileKey: "portfolioA",
    selection: {
      params: { expenseCutPct: 0, extraMonthlyIncome: 0, delayYears: 0, extraPrincipal: 0 },
      checked: { expenseCut: true, extraIncome: true, delay: true, extraPrincipal: true, dividendIncome: false, flexibility: false },
      dividendIncome: false,
      expenseFlexibility: false
    }
  });
  // 参数全为 0：组合不生效，也不产生误导性的提升。
  assert.equal(analysis.hasSelection, false);
  assert.equal(analysis.combined, null);
});

test("自定义组合：模拟直接使用传入的 CAGR 与波动率", () => {
  const customProfiles = {
    "custom-1": {
      key: "custom-1",
      label: "我的自定义组合",
      calibrated: true,
      custom: true,
      note: "页面自定义组合",
      sigma: 12.5,
      backtest: { period: "2015-01-01 ~ 2026-11-09", cagr: 9.25, volatility: 12.5 }
    }
  };
  const mc = simulate({ profileKey: "custom-1", customProfiles });
  assert.equal(mc.profileKey, "custom-1");
  assert.equal(mc.profile.label, "我的自定义组合");
  assert.equal(mc.profile.custom, true);
  assert.equal(mc.mu, 0.0925);
  assert.equal(mc.sigma, 0.125);
  // 反推分布同样走自定义组合口径
  const required = computeRequiredPrincipalDistribution({
    fireResult: baseResult,
    fireInput: baseInput,
    profileKey: "custom-1",
    customProfiles,
    runs: 300
  });
  assert.equal(required.profileKey, "custom-1");
  assert.equal(required.mu, 0.0925);
});

test("自定义组合：未知 key 回退股债 50/50", () => {
  const mc = simulate({ profileKey: "custom-missing", customProfiles: null });
  assert.equal(mc.profileKey, "balanced");
  assert.equal(mc.profile.label, MC_PROFILES.balanced.label);
});

test("胜率工具箱配置对比包含自定义组合", () => {
  const customProfiles = {
    "custom-2": {
      key: "custom-2",
      label: "自定义对照",
      calibrated: true,
      custom: true,
      sigma: 8,
      backtest: { period: "自定义", cagr: 6, volatility: 8 }
    }
  };
  const analysis = analyzeSuccessLevers({
    fireResult: baseResult,
    fireInput: baseInput,
    targetRate: 0.9,
    runs: 200,
    startingPrincipal: baseResult.chartStart,
    profileKey: "custom-2",
    customProfiles
  });
  assert.equal(analysis.baselineSuccessRate, 1);
  const customRow = analysis.profiles.find((profile) => profile.key === "custom-2");
  assert.ok(customRow, "自定义组合应出现在配置对比中");
  assert.equal(customRow.label, "自定义对照");
  const builtinRow = analysis.profiles.find((profile) => profile.key === "portfolioA");
  assert.ok(builtinRow, "内置组合仍应出现在配置对比中");
});
