"use strict";

// 压力测试引擎：把历史危机场景与自定义冲击叠加到当前 FIRE 方案上，
// 用与主现金流完全相同的记账口径逐路径回放，输出存续判定、回撤预警与水桶拆算。
// 所有场景数据为示意性年化数字，本地计算，不构成投资建议。

import {
  simulateCustomProjection, reserveInterestForPrincipal
} from "./fire-engine.js?v=20261123a";

export const STRESS_ENGINE_VERSION = "stress-test.1.0.0";

// ===== 历史危机场景（年收益率序列为该危机对 diversified 组合的示意性近似） =====
// crisisYears: 危机年度数；returns: 每年收益率（小数）；inflationShock: 危机期年通胀上浮（百分点/年）；
// description: 场景说明；note: 数据口径提示。
export const STRESS_SCENARIOS = {
  gfc2008: {
    label: "2008 金融危机",
    shortLabel: "2008 危机",
    crisisYears: 2,
    returns: [-0.32, -0.08],
    inflationShock: 1.5,
    description: "全球金融危机量级的冲击：首年深亏，次年继续收窄跌幅，随后市场逐步修复。",
    note: "示意口径：按全球分散组合在 2007–2008 的量级近似（首年约 −32%），非任何单一指数。"
  },
  cn2015: {
    label: "2015 异常波动",
    shortLabel: "2015 异常波动",
    crisisYears: 1,
    returns: [-0.28],
    inflationShock: 0.5,
    description: "A 股异常波动量级的单年冲击：深度回撤后较快修复。",
    note: "示意口径：按沪深综合指数在 2015 年内高点回撤的量级近似，分散组合实际回撤通常更浅。"
  },
  covid2020: {
    label: "2020 疫情冲击",
    shortLabel: "2020 疫情",
    crisisYears: 1,
    returns: [-0.18],
    inflationShock: 1.0,
    description: "疫情爆发式冲击：急跌急回，单年深亏后市场快速修复。",
    note: "示意口径：按全球分散组合 2020 年 2–3 月急跌的全年化量级近似。"
  },
  dual2022: {
    label: "2022 股债双杀",
    shortLabel: "2022 股债双杀",
    crisisYears: 2,
    returns: [-0.15, -0.10],
    inflationShock: 3.0,
    description: "股债同时下跌：传统分散失效，叠加高通胀侵蚀，修复期更长。",
    note: "示意口径：按股债 50/50 组合在 2022 年的量级近似，债券部分同步为负。"
  },
  depression1929: {
    label: "1929 大萧条",
    shortLabel: "1929 大萧条",
    crisisYears: 4,
    returns: [-0.35, -0.22, -0.10, -0.05],
    inflationShock: -1.5,
    description: "极端历史情形：连续四年下跌且首年深亏，通缩环境下支出同步收缩。",
    note: "示意口径：按美股 1929–1932 的量级近似；该场景为历史极端参考，发生概率极低。"
  }
};

export const STRESS_SCENARIO_KEYS = Object.keys(STRESS_SCENARIOS);

// Guyton-Klinger 提取率护栏：当前提取率超过初始提取率 20% 时，当年支出减 10%。
const GK_EXCESS = 0.2;
const GK_CUT = 0.1;

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

// 生成完整测算期的收益率路径：前 crisisYears 年按场景收益率，之后回到用户中枢。
function buildScenarioReturnPath(baseReturnRate, scenario, years) {
  const path = new Array(years);
  for (let year = 0; year < years; year += 1) {
    path[year] = year < scenario.crisisYears
      ? scenario.returns[year]
      : baseReturnRate;
  }
  return path;
}

// 生成危机期通胀上浮后的逐年通胀路径：危机年份 = 基础通胀 + shock，其余年份回到基础通胀。
function buildScenarioInflationPath(baseInflation, scenario, years) {
  const path = new Array(years + 1).fill(baseInflation);
  for (let year = 1; year <= Math.min(scenario.crisisYears, years); year += 1) {
    path[year] = baseInflation + scenario.inflationShock / 100;
  }
  return path;
}

// GK 护栏模拟：按「当年毛支出先按通胀路径增长，再看提取率是否超标」的口径逐年记账。
// 与 simulateCustomProjection 的差异：通胀可逐年变化 + GK 减提规则，其余记账完全一致。
function simulateWithGuards(options = {}) {
  const {
    principal,
    annualExpense,
    inflationPath,
    years,
    annualReserveInterest,
    dividendIncomeByYear = [],
    returnPath,
    guytonKlinger = false,
    expenseFlexibility = false,
    flexibilityDrawdown = 0.2,
    flexibilityCut = 0.1
  } = options;

  const points = [{
    year: 0, yearReturn: 0, startBalance: principal, investmentReturn: 0,
    grossExpense: 0, reserveOffset: 0, dividendIncome: 0, dividendOffset: 0,
    expense: 0, withdrawal: 0, balance: principal, drawdown: 0,
    flexApplied: false, gkApplied: false
  }];
  let balance = principal;
  let depletionYear = null;
  let totalWithdrawals = 0;
  let peakBalance = principal;
  const initialWithdrawalRate = principal > 0 ? annualExpense / principal : 0;

  for (let year = 1; year <= years; year += 1) {
    const startBalance = balance;
    const yearReturn = Number.isFinite(Number(returnPath[year - 1])) ? Number(returnPath[year - 1]) : 0;
    const investmentReturn = startBalance * yearReturn;
    const available = startBalance + investmentReturn;

    // 支出按逐年通胀路径复合增长：gross_n = annualExpense × Π(1 + inflationPath_k)。
    let grossExpense = annualExpense;
    for (let k = 1; k <= year; k += 1) grossExpense *= 1 + inflationPath[k];

    peakBalance = Math.max(peakBalance, startBalance);
    const drawdown = peakBalance > 0 ? 1 - startBalance / peakBalance : 0;
    const flexApplied = expenseFlexibility && drawdown > flexibilityDrawdown;
    if (flexApplied) grossExpense *= 1 - flexibilityCut;

    // Guyton-Klinger：当前提取率 = 毛支出/期初资产，超过初始提取率 20% 即减提 10%。
    const currentRate = startBalance > 0 ? grossExpense / startBalance : Infinity;
    const gkApplied = guytonKlinger && initialWithdrawalRate > 0
      && currentRate > initialWithdrawalRate * (1 + GK_EXCESS);
    if (gkApplied) grossExpense *= 1 - GK_CUT;

    const reserveOffset = Math.min(grossExpense, Math.max(0, annualReserveInterest));
    const dividendIncome = Math.max(0, Number(dividendIncomeByYear[year]) || 0);
    const dividendOffset = Math.min(grossExpense - reserveOffset, dividendIncome);
    const expense = grossExpense - reserveOffset - dividendOffset;
    const withdrawal = Math.min(available, expense);
    balance = Math.max(0, available - expense);
    totalWithdrawals += withdrawal;
    if (expense > available + 1 && depletionYear === null) depletionYear = year;
    points.push({
      year, yearReturn, startBalance, investmentReturn, grossExpense,
      reserveOffset, dividendIncome, dividendOffset, expense, withdrawal,
      balance, drawdown, flexApplied, gkApplied
    });
  }

  return {
    points,
    depletionYear,
    totalWithdrawals,
    minBalance: Math.min(...points.map((point) => point.balance)),
    gkAppliedCount: points.filter((point) => point.gkApplied).length,
    flexAppliedCount: points.filter((point) => point.flexApplied).length
  };
}

// 回撤预警灯：points 中的 drawdown 为正数深度（0.35 = 回撤 35%），取最深深度分级。
// maxDrawdown 以负数形式返回（-0.35），供页面直接展示为 -35%。
function evaluateDrawdownAlerts(drawdowns) {
  const depths = drawdowns.map((value) => Math.max(0, Number(value) || 0));
  const maxDepth = depths.length > 0 ? Math.max(...depths) : 0;
  const warningIndex = depths.findIndex((value) => value >= 0.15);
  const criticalIndex = depths.findIndex((value) => value >= 0.25);
  let level = "safe";
  if (maxDepth >= 0.25) level = "critical";
  else if (maxDepth >= 0.15) level = "warning";
  return {
    maxDrawdown: -maxDepth,
    level,
    warningYear: warningIndex === -1 ? null : warningIndex,
    criticalYear: criticalIndex === -1 ? null : criticalIndex
  };
}

// 三层水桶拆算：把起算本金按「现金桶 → 债券桶 → 权益桶」分层。
// 现金桶 = 36 个月支出（页面现金储备口径），债券桶 = 5 年支出，其余进权益桶。
export function buildBuckets(startingPrincipal, annualExpense) {
  const cashBucket = Math.max(0, annualExpense * 3);
  const bondBucket = Math.max(0, annualExpense * 5);
  const equityBucket = Math.max(0, startingPrincipal - cashBucket - bondBucket);
  return {
    cash: cashBucket,
    bond: bondBucket,
    equity: equityBucket,
    cashMonths: annualExpense > 0 ? Math.round(cashBucket / (annualExpense / 12)) : 0,
    bondYears: annualExpense > 0 ? bondBucket / annualExpense : 0
  };
}

/**
 * 对当前方案回放一个压力场景。
 * 输出与主现金流同口径的完整记账点列 + 存续判定 + 预警灯 + 水桶拆算。
 */
export function runStressScenario({
  fireResult,
  fireInput = {},
  scenarioKey = "gfc2008",
  startingPrincipal,
  guytonKlinger = false,
  expenseFlexibility = false,
  flexibilityDrawdown = 0.2,
  flexibilityCut = 0.1,
  customShock = null
} = {}) {
  if (!fireResult || !fireResult.assumptions) {
    throw new Error("runStressScenario 需要 calculateFirePlan 的结果");
  }

  // 自定义冲击：depth 为首年跌幅（百分比正数），length 为冲击年数，inflation 为危机期年通胀上浮（百分点）。
  let scenario;
  let scenarioId;
  if (customShock) {
    const depth = clamp(customShock.depth, 1, 90, 30) / 100;
    const length = Math.round(clamp(customShock.length, 1, 10, 2));
    const shock = clamp(customShock.inflation, -5, 15, 1);
    // 自定义冲击的年度结构：首年吃满 depth，其后每年按 40% 衰减（示意性恢复路径）。
    const returns = [];
    let remaining = depth;
    for (let index = 0; index < length; index += 1) {
      returns.push(-remaining);
      remaining *= 0.4;
    }
    scenario = {
      label: `自定义冲击（首年 −${(depth * 100).toFixed(0)}%）`,
      shortLabel: "自定义冲击",
      crisisYears: length,
      returns,
      inflationShock: shock,
      description: `自定义情景：首年 −${(depth * 100).toFixed(0)}%，其后每年亏损收窄至前一年的 40%，共 ${length} 年；危机期年通胀上浮 ${shock.toFixed(1)} 个百分点。`,
      note: "自定义情景为示意性假设：亏损逐年按 40% 衰减只是恢复形态的近似，非任何真实市场路径。"
    };
    scenarioId = "custom";
  } else if (scenarioKey === "baseline") {
    // 基线：无冲击对照，收益恒为中枢、通胀恒为基础值。
    scenario = {
      label: "基线（无冲击）",
      shortLabel: "基线",
      crisisYears: 0,
      returns: [],
      inflationShock: 0,
      description: "不叠加任何冲击的对照基准：按当前收益中枢与通胀直接推演。",
      note: "对照口径：与主现金流完全一致，用于衡量场景冲击的净影响。"
    };
    scenarioId = "baseline";
  } else {
    scenario = STRESS_SCENARIOS[scenarioKey] || STRESS_SCENARIOS.gfc2008;
    scenarioId = STRESS_SCENARIOS[scenarioKey] ? scenarioKey : "gfc2008";
  }

  const years = Math.round(clamp(fireInput.years ?? fireResult.assumptions.years, 1, 80, 50));
  const principal = clamp(startingPrincipal ?? fireResult.chartStart ?? fireInput.principal ?? 0, 0, 1e12, 0);
  const baseReturn = clamp((fireInput.returnRate ?? fireResult.assumptions.returnRate) / 100, -0.99, 1, 0.05);
  // fireInput.inflationRate 为百分数（如 2），fireResult.inflation 为小数（如 0.02）；两者只能取其一，不可混用。
  const baseInflation = fireInput.inflationRate !== undefined && fireInput.inflationRate !== null
    ? clamp(Number(fireInput.inflationRate) / 100, 0, 0.5, 0.02)
    : clamp(Number(fireResult.inflation), 0, 0.5, 0.02);
  const isEndowment = (fireInput.scenario ?? fireResult.assumptions.scenario) === "endowment";
  const annualReserveInterest = reserveInterestForPrincipal(
    principal,
    fireResult.medicalReserve,
    fireResult.cashReserve,
    fireResult.reserveRate
  );
  const dividendIncomeByYear = fireResult.dividendPlan?.enabled
    ? fireResult.dividendPlan.dividendIncomeByYear
    : new Array(years + 1).fill(0);

  const returnPath = buildScenarioReturnPath(baseReturn, scenario, years);
  const inflationPath = buildScenarioInflationPath(baseInflation, scenario, years);

  const simulation = simulateWithGuards({
    principal,
    annualExpense: fireResult.annual,
    inflationPath,
    years,
    annualReserveInterest,
    dividendIncomeByYear,
    returnPath,
    guytonKlinger,
    expenseFlexibility,
    flexibilityDrawdown,
    flexibilityCut
  });

  // 逐点资金守恒校验。
  let conservationMaxError = 0;
  for (const point of simulation.points) {
    const expected = Math.max(0, point.startBalance + point.investmentReturn - point.withdrawal);
    conservationMaxError = Math.max(conservationMaxError, Math.abs(point.balance - expected));
  }

  // 存续判定与主引擎同口径：缺口 > 1 元即失败；金鹅永续还要求期末购买力不减。
  const materialShortfall = simulation.points.some((point) => (
    point.expense - (point.startBalance + point.investmentReturn) > 1
  ));
  const inflationFactor = inflationPath.reduce((factor, value) => factor * (1 + value), 1);
  const realEndBalance = simulation.points[years].balance / inflationFactor;
  const survived = !materialShortfall && (!isEndowment || realEndBalance >= principal - 1);

  const drawdowns = simulation.points.map((point) => point.drawdown);
  // 耗尽后余额恒为 0、回撤恒为 100%，只会重复同一信号；预警灯只看耗尽前的路径。
  const alertHorizon = simulation.depletionYear !== null
    ? drawdowns.slice(0, simulation.depletionYear + 1)
    : drawdowns;
  const alerts = evaluateDrawdownAlerts(alertHorizon);
  const buckets = buildBuckets(principal, fireResult.annual);

  // 危机期的纯回撤（不含通胀支出）：冲击段首尾资产比。
  const crisisYears = Math.min(scenario.crisisYears, years);
  let crisisReturn = 1;
  for (let index = 0; index < crisisYears; index += 1) crisisReturn *= 1 + scenario.returns[index];
  crisisReturn -= 1;

  return {
    engineVersion: STRESS_ENGINE_VERSION,
    scenarioId,
    scenario,
    years,
    startingPrincipal: principal,
    isEndowment,
    survived,
    depletionYear: simulation.depletionYear,
    points: simulation.points,
    totalWithdrawals: simulation.totalWithdrawals,
    conservationMaxError,
    gkAppliedCount: simulation.gkAppliedCount,
    flexAppliedCount: simulation.flexAppliedCount,
    alerts,
    buckets,
    crisisYears,
    crisisReturn,
    realEndBalance,
    endBalance: simulation.points[years].balance
  };
}

/**
 * 一键对比：基线（无冲击）+ 全部预设场景，同一口径并排输出。
 */
export function runStressComparison({
  fireResult,
  fireInput = {},
  startingPrincipal,
  guytonKlinger = false,
  expenseFlexibility = false,
  flexibilityDrawdown = 0.2,
  flexibilityCut = 0.1,
  customShock = null
} = {}) {
  const common = {
    fireResult,
    fireInput,
    startingPrincipal,
    guytonKlinger,
    expenseFlexibility,
    flexibilityDrawdown,
    flexibilityCut
  };

  // 基线：不叠加任何冲击（收益恒为中枢、通胀恒为基础值），与主现金流同口径。
  const baseline = runStressScenario({
    ...common,
    scenarioKey: "baseline",
    customShock: null
  });

  const scenarios = [baseline];
  if (customShock) {
    scenarios.push(runStressScenario({ ...common, customShock }));
  } else {
    for (const key of STRESS_SCENARIO_KEYS) {
      scenarios.push(runStressScenario({ ...common, scenarioKey: key }));
    }
  }

  return {
    engineVersion: STRESS_ENGINE_VERSION,
    baseline,
    scenarios,
    guytonKlinger,
    expenseFlexibility,
    startingPrincipal: baseline.startingPrincipal,
    worst: scenarios.reduce((worst, item) => (
      item.scenarioId !== "baseline" && (worst === null || item.endBalance < worst.endBalance) ? item : worst
    ), null)
  };
}
