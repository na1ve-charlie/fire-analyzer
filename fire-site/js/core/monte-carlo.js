"use strict";

// 蒙特卡洛风险模拟：在用户当前收益中枢上叠加年度波动，复用正式站现金流引擎逐路径计算。
// 输入参数与输出口径均在本地计算，不接入外部数据；固定种子保证同一方案可完全复现。

import {
  simulateCustomProjection, reserveInterestForPrincipal, calculateFirePlan
} from "./fire-engine.js?v=20261119d";

export const MC_ENGINE_VERSION = "monte-carlo.1.0.0";

// sigma 为年度算术波动率的示意值；通用预设的 mu 取当前方案的年化收益率中枢。
// “我的组合”按用户实际持仓权重与示意收益/波动假设自行计算 mu 与 sigma。
export const MC_PROFILES = {
  myPortfolio: {
    label: "我的组合",
    sigma: 12.54,
    note: "按近 10 年回测数据校准",
    backtest: {
      period: "2016-11-22 ~ 2026-11-18",
      cagr: 6.73,
      volatility: 12.54,
      maxDrawdown: -20.15,
      sharpe: 0.37,
      riskFreeRate: 2.11
    },
    holdings: [
      { name: "红利低波", fund: "D红利低波（中证红利低波 H30269）", group: "cnDividend", weight: 42, mu: 4.16, sigma: 16.58 },
      { name: "红利低波-波段", fund: "D红利低波（同底层回测）", group: "cnDividend", weight: 18, mu: 4.16, sigma: 16.58 },
      { name: "量化微盘", fund: "华夏新锦绣混合（002833/002834）", group: "cnMicro", weight: 4.5, mu: 10.86, sigma: 18.30 },
      { name: "纳斯达克100", fund: "W美股指数（纳指ETF 513100）", group: "usEquity", weight: 4.5, mu: 19.95, sigma: 23.02 },
      { name: "标普500", fund: "W美股指数（标普ETF 513500）", group: "usEquity", weight: 21, mu: 12.62, sigma: 18.95 },
      { name: "现金", fund: "C现金（货币基金七天年化）", group: "cash", weight: 10, mu: 2.11, sigma: 0 }
    ]
  },
  balanced: { label: "股债 50/50", sigma: 9, note: "中等波动" },
  equity70: { label: "股 70% / 债 30%", sigma: 14, note: "偏高波动" },
  equity100: { label: "100% 宽基股票", sigma: 22, note: "高波动" },
  dividend: { label: "红利低波为主", sigma: 16, note: "权益波动" }
};

function correlation(groupA, groupB) {
  if (groupA === groupB) {
    if (groupA === "cash") return 1;
    if (groupA === "cnDividend") return 1; // 两档红利低波共用同一底层指数
    if (groupA === "usEquity") return 0.82; // 513100/513500 近十年实测约 0.82
    return 1;
  }
  const pair = [groupA, groupB].sort().join("|");
  if (pair === "cnDividend|cnMicro") return 0.50;
  if (pair === "cnDividend|usEquity") return 0.24;
  if (pair === "cnMicro|usEquity") return 0.28;
  return 0; // 现金与其他资产按低相关处理
}

// 按权重与组别相关性计算组合年化收益中枢和波动率（均为十进制）。
export function computePortfolioStats(holdings) {
  if (!Array.isArray(holdings) || holdings.length === 0) return null;
  const totalWeight = holdings.reduce((sum, item) => sum + Number(item.weight), 0) || 100;
  const normalized = holdings.map((item) => ({
    ...item,
    w: Number(item.weight) / totalWeight,
    muDecimal: Number(item.mu) / 100,
    sigmaDecimal: Number(item.sigma) / 100
  }));
  const mu = normalized.reduce((sum, item) => sum + item.w * item.muDecimal, 0);
  let variance = 0;
  for (const a of normalized) {
    for (const b of normalized) {
      variance += a.w * b.w * a.sigmaDecimal * b.sigmaDecimal * correlation(a.group, b.group);
    }
  }
  return { mu, sigma: Math.sqrt(variance), totalWeight };
}

function clamp(value, min, max, fallback) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

// 储备利息必须与实际起算本金同源：即使调用方显式传入 startingPrincipal，
// 也不会误用另一个口径下算出的旧利息。
function reserveInterestForStartingPrincipal(fireResult, principal) {
  const reserveRate = Number(fireResult.reserveRate ?? Number(fireResult.assumptions?.reserveReturnRate) / 100);
  const medicalReserve = Number(fireResult.medicalReserve ?? fireResult.assumptions?.medicalReserve);
  const cashReserve = Number(fireResult.cashReserve ?? fireResult.assumptions?.cashReserve);
  if (Number.isFinite(reserveRate) && Number.isFinite(medicalReserve) && Number.isFinite(cashReserve)) {
    return reserveInterestForPrincipal(principal, medicalReserve, cashReserve, reserveRate);
  }
  return Number(fireResult.activeReserveInterest ?? fireResult.reservePlan?.annualReserveInterest) || 0;
}

// mulberry32：确定性 PRNG，相同种子生成完全相同的路径。
function mulberry32(seed) {
  let s = Math.floor(seed) | 0;
  return function next() {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function standardNormal(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function percentile(sortedValues, p) {
  if (!Array.isArray(sortedValues) || sortedValues.length === 0) return null;
  const index = clamp((sortedValues.length - 1) * p, 0, sortedValues.length - 1, 0);
  const low = Math.floor(index);
  const high = Math.ceil(index);
  return sortedValues[low] + (sortedValues[high] - sortedValues[low]) * (index - low);
}

function buildFailureBuckets(failedYears, years, bucketSize = 10) {
  const buckets = [];
  for (let start = 1; start <= years; start += bucketSize) {
    const end = Math.min(start + bucketSize - 1, years);
    buckets.push({
      label: `${start}–${end}年`,
      count: failedYears.filter((year) => year >= start && year <= end).length
    });
  }
  return buckets;
}

/**
 * 生成 N 条随机收益路径，并逐条调用 simulateCustomProjection。
 * 成功定义：测算期内不出现缺口；金鹅永续模式还要求期末实际购买力不低于起点本金。
 */
export function runMonteCarlo({
  fireResult,
  fireInput = {},
  profileKey = "balanced",
  runs = 5000,
  seed = 20261119,
  startingPrincipal,
  expenseFlexibility = false,
  flexibilityDrawdown = 0.2,
  flexibilityCut = 0.1,
  sigmaOverride = null
} = {}) {
  if (!fireResult || !fireResult.assumptions) {
    throw new Error("runMonteCarlo 需要 calculateFirePlan 的结果");
  }

  const profile = MC_PROFILES[profileKey] ? MC_PROFILES[profileKey] : MC_PROFILES.balanced;
  const portfolioStats = profile.holdings ? computePortfolioStats(profile.holdings) : null;
  const runCount = Math.round(clamp(runs, 100, 20000, 5000));
  const randomSeed = Math.floor(clamp(seed, 0, 2147483647, 20261119));
  const years = Math.round(clamp(fireInput.years ?? fireResult.assumptions.years, 1, 80, 50));
  const inputMu = clamp((fireInput.returnRate ?? fireResult.assumptions.returnRate) / 100, -0.99, 1, 0.05);
  const mu = portfolioStats ? portfolioStats.mu : inputMu;
  const sigmaPercent = sigmaOverride !== null && sigmaOverride !== undefined
    ? Number(sigmaOverride)
    : (portfolioStats ? portfolioStats.sigma * 100 : profile.sigma);
  const sigma = clamp(sigmaPercent, 0, 100, profile.sigma) / 100;
  const principal = clamp(startingPrincipal ?? fireResult.chartStart ?? fireInput.principal ?? 0, 0, 1e12, 0);
  const inflation = Number(fireResult.inflation) || 0;
  const annualReserveInterest = reserveInterestForStartingPrincipal(fireResult, principal);
  const dividendIncomeByYear = fireResult.dividendPlan?.enabled
    ? fireResult.dividendPlan.dividendIncomeByYear
    : new Array(years + 1).fill(0);
  const isEndowment = (fireInput.scenario ?? fireResult.assumptions.scenario) === "endowment";
  const sigmaLog = sigma > 0 ? Math.log(1 + sigma) : 0;
  const muLog = Math.log(1 + mu);

  const endBalances = [];
  const endRealBalances = [];
  const minBalances = [];
  const failedYears = [];
  let successCount = 0;
  let conservationMaxError = 0;
  let flexAppliedCount = 0;

  for (let index = 0; index < runCount; index += 1) {
    const rand = mulberry32(randomSeed + index * 7919);
    const returnPath = new Array(years);
    for (let year = 0; year < years; year += 1) {
      returnPath[year] = Math.exp(muLog + sigmaLog * standardNormal(rand)) - 1;
    }

    const simulation = simulateCustomProjection({
      principal,
      annualExpense: fireResult.annual,
      annualReturn: mu,
      inflation,
      years,
      annualReserveInterest,
      dividendIncomeByYear,
      returnPath,
      expenseFlexibility,
      flexibilityDrawdown,
      flexibilityCut
    });

    for (const point of simulation.points) {
      const expected = Math.max(0, point.startBalance + point.investmentReturn - point.withdrawal);
      conservationMaxError = Math.max(conservationMaxError, Math.abs(point.balance - expected));
      if (point.flexApplied) flexAppliedCount += 1;
    }

    const endingBalance = simulation.points[years].balance;
    const realEndingBalance = endingBalance / Math.pow(1 + inflation, years);
    // 拒绝 1 元以内的浮点误差造成的“假缺口”；只有实质资金不足才计为失败。
    const materialShortfall = simulation.points.some((point) => (
      point.expense - (point.startBalance + point.investmentReturn) > 1
    ));
    const survived = !materialShortfall
      && (!isEndowment || realEndingBalance >= principal - 1);

    endBalances.push(endingBalance);
    endRealBalances.push(realEndingBalance);
    minBalances.push(simulation.minBalance ?? Math.min(...simulation.points.map((point) => point.balance)));
    if (survived) successCount += 1;
    else failedYears.push(simulation.depletionYear ?? years);
  }

  const sortedEnd = [...endBalances].sort((a, b) => a - b);
  const sortedMin = [...minBalances].sort((a, b) => a - b);

  return {
    engineVersion: MC_ENGINE_VERSION,
    runs: runCount,
    seed: randomSeed,
    profileKey: MC_PROFILES[profileKey] ? profileKey : "balanced",
    profile,
    holdings: profile.holdings || null,
    portfolioStats,
    years,
    mu,
    sigma,
    sigmaLog,
    isEndowment,
    startingPrincipal: principal,
    successRate: successCount / runCount,
    successCount,
    failedCount: failedYears.length,
    failedYears,
    endBalances,
    endRealBalances,
    minBalances,
    p10End: percentile(sortedEnd, 0.1),
    p50End: percentile(sortedEnd, 0.5),
    p90End: percentile(sortedEnd, 0.9),
    p10Min: percentile(sortedMin, 0.1),
    p50Min: percentile(sortedMin, 0.5),
    buckets: buildFailureBuckets(failedYears, years),
    conservationMaxError,
    flexAppliedCount
  };
}

// 每条随机路径反推「刚好能走完」的最小本金；其分位数即为达到目标成功率所需本金。
export function computeRequiredPrincipalDistribution({
  fireResult,
  fireInput = {},
  profileKey = "myPortfolio",
  runs = 2000,
  seed = 20261119,
  startingPrincipal,
  expenseCut = 0,
  extraMonthlyIncome = 0,
  expenseFlexibility = false,
  flexibilityDrawdown = 0.2,
  flexibilityCut = 0.1
} = {}) {
  if (!fireResult || !fireResult.assumptions) {
    throw new Error("computeRequiredPrincipalDistribution 需要 calculateFirePlan 的结果");
  }
  const profile = MC_PROFILES[profileKey] ? MC_PROFILES[profileKey] : MC_PROFILES.balanced;
  const stats = profile.holdings ? computePortfolioStats(profile.holdings) : null;
  const runCount = Math.round(clamp(runs, 100, 5000, 2000));
  const randomSeed = Math.floor(clamp(seed, 0, 2147483647, 20261119));
  const years = Math.round(clamp(fireInput.years ?? fireResult.assumptions.years, 1, 80, 50));
  const mu = stats ? stats.mu : clamp((fireInput.returnRate ?? fireResult.assumptions.returnRate) / 100, -0.99, 1, 0.05);
  const sigma = clamp(stats ? stats.sigma * 100 : profile.sigma, 0, 100, profile.sigma) / 100;
  const sigmaLog = sigma > 0 ? Math.log(1 + sigma) : 0;
  const muLog = Math.log(1 + mu);
  const inflation = Number(fireResult.inflation) || 0;
  // 胜率反推是在求「候选本金」，因此储备利息也必须按该候选本金同步计算。
  const reserveInterestFor = (candidate) => reserveInterestForStartingPrincipal(fireResult, candidate);
  const dividendIncomeByYear = fireResult.dividendPlan?.enabled
    ? fireResult.dividendPlan.dividendIncomeByYear
    : new Array(years + 1).fill(0);
  const isEndowment = (fireInput.scenario ?? fireResult.assumptions.scenario) === "endowment";
  const annualExpense = Math.max(0, Number(fireResult.annual) * (1 - clamp(expenseCut, 0, 0.9, 0))
    - Number(extraMonthlyIncome) * 12);

  const required = [];
  for (let index = 0; index < runCount; index += 1) {
    const rand = mulberry32(randomSeed + index * 7919);
    const returnPath = new Array(years);
    for (let year = 0; year < years; year += 1) {
      returnPath[year] = Math.exp(muLog + sigmaLog * standardNormal(rand)) - 1;
    }

    const isEnough = (principal) => {
      const simulation = simulateCustomProjection({
        principal, annualExpense, annualReturn: mu, inflation, years,
        annualReserveInterest: reserveInterestFor(principal), dividendIncomeByYear, returnPath,
        expenseFlexibility, flexibilityDrawdown, flexibilityCut
      });
      const shortfall = simulation.points.some((point) => (
        point.expense - (point.startBalance + point.investmentReturn) > 1
      ));
      if (shortfall) return false;
      if (isEndowment) {
        const realEnd = simulation.points[years].balance / Math.pow(1 + inflation, years);
        if (realEnd < principal - 1) return false;
      }
      return true;
    };

    let low = 0;
    let high = Math.max(startingPrincipal || 0, fireResult.conservative || 0, annualExpense * years, 1);
    let guard = 0;
    while (!isEnough(high) && guard < 30) { high *= 1.3; guard += 1; }
    for (let step = 0; step < 36; step += 1) {
      const middle = (low + high) / 2;
      if (isEnough(middle)) high = middle; else low = middle;
    }
    required.push(high);
  }

  const sorted = required.sort((a, b) => a - b);
  return {
    runs: runCount,
    seed: randomSeed,
    profileKey: profile.holdings ? profileKey : "balanced",
    mu, sigma, annualExpense,
    sorted,
    p50: percentile(sorted, 0.5),
    p80: percentile(sorted, 0.8),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95)
  };
}

// 一键汇总可用的胜率杠杆：目标本金分位、单项调整效果、配置对比。
export function analyzeSuccessLevers({
  fireResult,
  fireInput = {},
  targetRate = 0.9,
  runs = 2000,
  seed = 20261119,
  startingPrincipal,
  profileKey = "myPortfolio"
} = {}) {
  const target = clamp(targetRate, 0.5, 0.99, 0.9);
  const common = { fireResult, fireInput, runs, seed, startingPrincipal, profileKey };
  const required = computeRequiredPrincipalDistribution({ ...common });
  const baseline = runMonteCarlo({ ...common });
  const targetPrincipal = percentile(required.sorted, target);

  const levers = [];
  for (const cut of [0.1, 0.2]) {
    const mc = runMonteCarlo({
      ...common,
      fireResult: { ...fireResult, annual: fireResult.annual * (1 - cut) }
    });
    levers.push({ label: `支出降低 ${(cut * 100).toFixed(0)}%`, detail: `年支出降至 ${formatPlain(fireResult.annual * (1 - cut))}`, successRate: mc.successRate });
  }
  for (const extra of [1000, 2000]) {
    const mc = runMonteCarlo({
      ...common,
      fireResult: { ...fireResult, annual: Math.max(0, fireResult.annual - extra * 12) }
    });
    levers.push({ label: `每月多 ${formatPlain(extra)} 收入`, detail: `相当于年支出减少 ${formatPlain(extra * 12)}`, successRate: mc.successRate });
  }
  const delayPrincipal = (years) => {
    const rate = baseline.mu;
    const dcaMonthly = Number(fireInput.dcaMonthly ?? fireResult.assumptions.dcaMonthly) || 0;
    const factor = Math.pow(1 + rate, years);
    const contribution = rate > 0
      ? dcaMonthly * 12 * (factor - 1) / rate
      : dcaMonthly * 12 * years;
    return startingPrincipal * factor + contribution;
  };
  for (const delay of [3, 5]) {
    const grown = delayPrincipal(delay);
    const mc = runMonteCarlo({ ...common, startingPrincipal: grown });
    levers.push({ label: `推迟 ${delay} 年 FIRE`, detail: `继续定投后本金约 ${formatPlain(grown)}`, successRate: mc.successRate });
  }

  // 页面「红利低波退休金」：按当前定投参数单独算出的领取现金流，作为额外年度抵扣。
  const dividendEnabledInBaseline = Boolean(fireResult.dividendPlan?.enabled);
  const dividendResult = calculateFirePlan({ ...fireInput, dividendEnabled: true });
  const dividendPlan = dividendResult.dividendPlan;
  if (dividendPlan?.enabled && dividendPlan.startYear !== null) {
    const mc = runMonteCarlo({
      ...common,
      fireResult: { ...fireResult, dividendPlan }
    });
    levers.push({
      label: "计入页面红利退休金",
      detail: `FIRE 第 ${dividendPlan.startYear} 年起 ${formatPlain(dividendPlan.annualIncome)}/年`,
      successRate: mc.successRate
    });
  } else {
    levers.push({
      label: "计入页面红利退休金",
      detail: "当前定投参数无法产生领取金额",
      successRate: baseline.successRate
    });
  }

  const profiles = Object.keys(MC_PROFILES).map((key) => ({
    key,
    label: MC_PROFILES[key].label,
    successRate: runMonteCarlo({ ...common, profileKey: key }).successRate
  }));

  return {
    targetRate: target,
    targetPrincipal,
    currentPrincipal: startingPrincipal,
    gap: targetPrincipal - startingPrincipal,
    baselineSuccessRate: baseline.successRate,
    dividendEnabledInBaseline,
    dividendPlan,
    required,
    levers,
    profiles
  };
}

function formatPlain(value) {
  return `¥${Math.round(Number(value) || 0).toLocaleString("zh-CN")}`;
}
