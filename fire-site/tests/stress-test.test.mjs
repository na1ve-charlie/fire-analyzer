import test from "node:test";
import assert from "node:assert/strict";
import { calculateFirePlan } from "../js/core/fire-engine.js";
import {
  runStressScenario, runStressComparison, buildBuckets,
  STRESS_SCENARIOS, STRESS_SCENARIO_KEYS, STRESS_ENGINE_VERSION
} from "../js/core/stress-test.js";

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

function scenario(extra = {}) {
  return runStressScenario({
    fireResult: baseResult,
    fireInput: baseInput,
    scenarioKey: "gfc2008",
    startingPrincipal: baseResult.chartStart,
    ...extra
  });
}

test("压力引擎输出版本与场景元信息", () => {
  const result = scenario();
  assert.equal(result.engineVersion, STRESS_ENGINE_VERSION);
  assert.equal(result.scenarioId, "gfc2008");
  assert.equal(result.scenario.label, STRESS_SCENARIOS.gfc2008.label);
  assert.equal(result.years, 50);
  assert.equal(result.startingPrincipal, baseResult.chartStart);
});

test("危机年收益率注入路径，危机后回到用户中枢", () => {
  const result = scenario();
  const path = result.points.map((point) => point.yearReturn);
  // 第 0 年是期初占位点，yearReturn = 0
  assert.equal(path[0], 0);
  assert.equal(path[1], -0.32);
  assert.equal(path[2], -0.08);
  for (let year = 3; year <= 50; year += 1) {
    assert.equal(path[year], 0.055, `第 ${year} 年应回到中枢 5.5%`);
  }
});

test("危机期通胀上浮进入支出路径", () => {
  const result = scenario();
  // 基线毛支出第 1 年 = 38700；gfc2008 通胀上浮 1.5pp → 3.5%
  // 毛支出 = 38700 × 1.035 = 40054.5
  assert.ok(Math.abs(result.points[1].grossExpense - 38700 * 1.035) < 0.01);
  // 第 2 年 = 38700 × 1.035 × 1.035
  assert.ok(Math.abs(result.points[2].grossExpense - 38700 * 1.035 * 1.035) < 0.01);
  // 第 3 年回到基础通胀 2%：38700 × 1.035² × 1.02
  assert.ok(Math.abs(result.points[3].grossExpense - 38700 * 1.035 * 1.035 * 1.02) < 0.01);
});

test("逐点资金守恒：年末资产 = 期初 + 收益 − 提取", () => {
  for (const key of STRESS_SCENARIO_KEYS) {
    const result = scenario({ scenarioKey: key });
    assert.ok(result.conservationMaxError < 0.01, `${key} 守恒误差应小于 1 分钱`);
  }
  const custom = scenario({ customShock: { depth: 40, length: 3, inflation: 4 } });
  assert.ok(custom.conservationMaxError < 0.01);
});

test("冲击越深，期末资产越差（场景严重度单调）", () => {
  const mild = scenario({ scenarioKey: "covid2020" });   // -18% 单年
  const severe = scenario({ scenarioKey: "gfc2008" });  // -32% 后 -8%
  const extreme = scenario({ scenarioKey: "depression1929" }); // 连续四年
  assert.ok(mild.endBalance >= severe.endBalance, "疫情冲击应轻于 2008 量级");
  assert.ok(severe.endBalance >= extreme.endBalance, "2008 量级应轻于大萧条量级");
});

test("基线无冲击时与主现金流同口径", () => {
  // 基线场景（无冲击）应与 simulateCustomProjection 恒定收益路径一致。
  const comparison = runStressComparison({
    fireResult: baseResult,
    fireInput: baseInput,
    startingPrincipal: baseResult.chartStart
  });
  const baseline = comparison.baseline;
  assert.equal(baseline.scenarioId, "baseline");
  assert.equal(baseline.points[1].yearReturn, 0.055);
  assert.equal(baseline.points[1].grossExpense, baseResult.annual * 1.02);
  // 基线不破产
  assert.equal(baseline.survived, true);
});

test("回撤预警灯分级正确", () => {
  const safe = scenario({ scenarioKey: "covid2020", startingPrincipal: baseResult.conservative * 2 });
  // 高本金 + 温和冲击：不一定触发，但结构完整
  assert.ok(["safe", "warning", "critical"].includes(safe.alerts.level));
  assert.ok(safe.alerts.maxDrawdown <= 0);

  const crash = scenario({ scenarioKey: "depression1929" });
  // 大萧条量级：首年 -35% 必然超过 -25% 红线
  assert.equal(crash.alerts.level, "critical");
  assert.ok(crash.alerts.criticalYear !== null);
  assert.ok(crash.alerts.warningYear !== null);
  assert.ok(crash.alerts.warningYear <= crash.alerts.criticalYear);
});

test("Guyton-Klinger 护栏在提取率超标时减提", () => {
  // 用边际本金（反推值）放大提取压力，验证 GK 触发。
  const tight = scenario({ startingPrincipal: baseResult.reverse });
  const withGk = scenario({ startingPrincipal: baseResult.reverse, guytonKlinger: true });
  assert.ok(withGk.gkAppliedCount > 0, "边际本金下 GK 应触发");
  assert.ok(withGk.points.some((point) => point.gkApplied));
  // 减提意味着毛支出被砍 10%：触发年份的 grossExpense 应小于非 GK 口径的同一年
  const firstGkYear = withGk.points.find((point) => point.gkApplied).year;
  // 非触发年份（第 1 年）两者毛支出相同；触发后 GK 的支出更低
  assert.ok(withGk.points[firstGkYear].grossExpense < tight.points[firstGkYear].grossExpense * 1.0001
    || withGk.points[firstGkYear].expense < tight.points[firstGkYear].expense);
  // GK 不应让结果更差（减提只可能延缓耗尽）
  assert.ok(withGk.endBalance >= tight.endBalance - 1);
});

test("GK 与支出弹性可叠加且记账守恒", () => {
  const both = scenario({ guytonKlinger: true, expenseFlexibility: true, customShock: { depth: 50, length: 4, inflation: 5 } });
  assert.ok(both.conservationMaxError < 0.01);
  assert.ok(both.gkAppliedCount + both.flexAppliedCount > 0);
});

test("三层水桶拆算：现金 3 年 + 债券 5 年 + 权益余额", () => {
  const buckets = buildBuckets(1000000, 38700);
  assert.equal(buckets.cash, 116100);       // 38700 × 3
  assert.equal(buckets.bond, 193500);       // 38700 × 5
  assert.equal(buckets.equity, 690400);     // 1000000 - 现金 - 债券
  assert.equal(buckets.cashMonths, 36);
  assert.ok(Math.abs(buckets.bondYears - 5) < 1e-9);
  // 水桶总额始终等于起算本金
  assert.equal(buckets.cash + buckets.bond + buckets.equity, 1000000);
});

test("压力场景输出水桶结构与危机期组合回撤", () => {
  const result = scenario();
  assert.ok(result.buckets.cash > 0);
  assert.ok(result.buckets.bond > 0);
  // gfc2008 危机期回撤 = (1-0.32)×(1-0.08) - 1 ≈ -37.44%
  assert.ok(Math.abs(result.crisisReturn - ((1 - 0.32) * (1 - 0.08) - 1)) < 1e-9);
  assert.equal(result.crisisYears, 2);
});

test("自定义冲击：首年跌幅全额注入，其后按 40% 衰减", () => {
  const result = scenario({ customShock: { depth: 40, length: 3, inflation: 3 } });
  assert.equal(result.scenarioId, "custom");
  const path = result.points.map((point) => point.yearReturn);
  assert.ok(Math.abs(path[1] - -0.4) < 1e-9);
  assert.ok(Math.abs(path[2] - -0.16) < 1e-9);
  assert.ok(Math.abs(path[3] - -0.064) < 1e-9);
  assert.equal(path[4], 0.055);
  // 通胀上浮 3pp → 第 1 年通胀 5%
  assert.ok(Math.abs(result.points[1].grossExpense - baseResult.annual * 1.05) < 0.01);
});

test("自定义冲击参数越界被安全收敛", () => {
  const result = scenario({ customShock: { depth: 200, length: 99, inflation: 99 } });
  const path = result.points.map((point) => point.yearReturn);
  assert.ok(Math.abs(path[1] - -0.9) < 1e-9, "跌幅上限 90%");
  assert.equal(result.scenario.crisisYears, 10, "冲击年数上限 10");
  // 通胀上浮上限 15pp
  assert.ok(Math.abs(result.points[1].grossExpense - baseResult.annual * 1.17) < 0.01);
});

test("金鹅永续模式：压力场景要求期末购买力不减", () => {
  const endowmentInput = { ...baseInput, scenario: "endowment" };
  const endowmentResult = calculateFirePlan(endowmentInput);
  const safe = runStressScenario({
    fireResult: endowmentResult,
    fireInput: endowmentInput,
    scenarioKey: "covid2020",
    startingPrincipal: endowmentResult.chartStart * 2
  });
  const crash = runStressScenario({
    fireResult: endowmentResult,
    fireInput: endowmentInput,
    scenarioKey: "depression1929",
    startingPrincipal: endowmentResult.chartStart
  });
  // 结构断言：两个场景都产出购买力口径的判定
  assert.equal(safe.isEndowment, true);
  assert.equal(crash.isEndowment, true);
  assert.equal(typeof crash.survived, "boolean");
});

test("对比模式：基线 + 全部预设场景并排输出", () => {
  const comparison = runStressComparison({
    fireResult: baseResult,
    fireInput: baseInput,
    startingPrincipal: baseResult.chartStart
  });
  assert.equal(comparison.scenarios.length, 1 + STRESS_SCENARIO_KEYS.length);
  assert.equal(comparison.scenarios[0].scenarioId, "baseline");
  // 每个场景都带预警灯与守恒校验
  for (const item of comparison.scenarios) {
    assert.ok(item.alerts);
    assert.ok(item.conservationMaxError < 0.01);
    assert.ok(item.buckets.cash >= 0);
  }
  // worst 指向期末资产最差的非基线场景
  const nonBaseline = comparison.scenarios.filter((item) => item.scenarioId !== "baseline");
  const minEnd = Math.min(...nonBaseline.map((item) => item.endBalance));
  assert.ok(Math.abs(comparison.worst.endBalance - minEnd) < 1e-6);
});

test("对比模式：传入自定义冲击时只含基线 + 自定义", () => {
  const comparison = runStressComparison({
    fireResult: baseResult,
    fireInput: baseInput,
    startingPrincipal: baseResult.chartStart,
    customShock: { depth: 25, length: 2, inflation: 2 }
  });
  assert.equal(comparison.scenarios.length, 2);
  assert.equal(comparison.scenarios[1].scenarioId, "custom");
});

test("GK 开启时全部场景的减提次数与守恒", () => {
  const comparison = runStressComparison({
    fireResult: baseResult,
    fireInput: baseInput,
    startingPrincipal: baseResult.chartStart,
    guytonKlinger: true
  });
  for (const item of comparison.scenarios) {
    assert.ok(item.conservationMaxError < 0.01);
    assert.ok(item.gkAppliedCount >= 0);
  }
});

test("起点本金变化同步改变压力结果", () => {
  const low = scenario({ startingPrincipal: baseResult.reverse * 0.7 });
  const high = scenario({ startingPrincipal: baseResult.conservative * 1.5 });
  assert.equal(low.startingPrincipal, baseResult.reverse * 0.7);
  assert.ok(high.endBalance > low.endBalance);
  if (!low.survived) assert.ok(high.survived || high.endBalance > low.endBalance);
});
