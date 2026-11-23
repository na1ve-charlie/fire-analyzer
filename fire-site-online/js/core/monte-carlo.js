"use strict";

// 蒙特卡洛风险模拟：在用户当前收益中枢上叠加年度波动，复用正式站现金流引擎逐路径计算。
// 输入参数与输出口径均在本地计算，不接入外部数据；固定种子保证同一方案可完全复现。

import {
  simulateCustomProjection, reserveInterestForPrincipal, calculateFirePlan
} from "./fire-engine.js?v=20261123a";

export const MC_ENGINE_VERSION = "monte-carlo.1.4.0";

// sigma 为年度算术波动率的示意值；通用预设的 mu 取当前方案的年化收益率中枢。
// 六个命名组合（calibrated）按用户提供的组合级回测 CAGR 与波动率直接校准，
// 不再由持仓权重与相关性推算；holdings 仅用于展示仓位构成。
// 组合二五个债券版本：指数版（5–7 年基线 / 10 年 / 30 年）同为 2011 年起样本，
// ETF 版（10 年 / 30 年）受 ETF 上市日限制同为 2023-06-13 起样本，相互之间不可直接横比。
export const MC_PROFILES = {
  portfolioA: {
    label: "组合一 · 进攻",
    sigma: 17.43,
    note: "按 2007 年以来长样本回测校准",
    calibrated: true,
    backtest: {
      period: "2007-01-04 ~ 2026-11-09",
      cagr: 13.48,
      volatility: 17.43,
      maxDrawdown: -54.49,
      sharpe: 0.76,
      riskFreeRate: 1.0
    },
    holdings: [
      { name: "红利低波全收益", fund: "中证红利低波动全收益（H20269）", group: "cnDividend", weight: 60 },
      { name: "标普500全收益", fund: "标普 500 全收益（^SP500TR）", group: "usEquity", weight: 18 },
      { name: "纳指100全收益", fund: "纳斯达克 100 全收益（XNDX）", group: "usEquity", weight: 7.5 },
      { name: "微盘股等权", fund: "万得微盘股日频等权（8841431.WI）", group: "cnMicro", weight: 4.5 },
      { name: "现金", fund: "现金（年化 1.4%）", group: "cash", weight: 10 }
    ]
  },
  portfolioB57: {
    label: "组合二 · 5–7年基线",
    sigma: 10.74,
    note: "按 2011 年以来指数版回测校准",
    calibrated: true,
    backtest: {
      period: "2011-01-04 ~ 2026-11-09",
      cagr: 10.75,
      volatility: 10.74,
      maxDrawdown: -22.18,
      sharpe: 0.91,
      riskFreeRate: 1.0
    },
    holdings: [
      { name: "红利低波全收益", fund: "中证红利低波动全收益（H20269）", group: "cnDividend", weight: 42 },
      { name: "标普500全收益", fund: "标普 500 全收益（^SP500TR）", group: "usEquity", weight: 18 },
      { name: "纳指100全收益", fund: "纳斯达克 100 全收益（XNDX）", group: "usEquity", weight: 7.5 },
      { name: "微盘股等权", fund: "万得微盘股日频等权（8841431.WI）", group: "cnMicro", weight: 4.5 },
      { name: "5–7年利率债", fund: "中债国债及政策性银行债 5–7 年财富（CBA05841.CB）", group: "cnBond", weight: 18 },
      { name: "现金", fund: "现金（年化 1.4%）", group: "cash", weight: 10 }
    ]
  },
  portfolioB10y: {
    label: "组合二 · 10年指数",
    sigma: 10.73,
    note: "按 2011 年以来指数版回测校准",
    calibrated: true,
    backtest: {
      period: "2011-01-04 ~ 2026-11-09",
      cagr: 10.73,
      volatility: 10.73,
      maxDrawdown: -22.2,
      sharpe: 0.91,
      riskFreeRate: 1.0
    },
    holdings: [
      { name: "红利低波全收益", fund: "中证红利低波动全收益（H20269）", group: "cnDividend", weight: 42 },
      { name: "标普500全收益", fund: "标普 500 全收益（^SP500TR）", group: "usEquity", weight: 18 },
      { name: "纳指100全收益", fund: "纳斯达克 100 全收益（XNDX）", group: "usEquity", weight: 7.5 },
      { name: "微盘股等权", fund: "万得微盘股日频等权（8841431.WI）", group: "cnMicro", weight: 4.5 },
      { name: "10年国债指数", fund: "中债 10 年期国债财富（CBA04501.CB）", group: "cnBond", weight: 18 },
      { name: "现金", fund: "现金（年化 1.4%）", group: "cash", weight: 10 }
    ]
  },
  portfolioB30y: {
    label: "组合二 · 30年指数",
    sigma: 10.73,
    note: "按 2011 年以来指数版回测校准",
    calibrated: true,
    backtest: {
      period: "2011-01-04 ~ 2026-11-09",
      cagr: 11.12,
      volatility: 10.73,
      maxDrawdown: -21.87,
      sharpe: 0.94,
      riskFreeRate: 1.0
    },
    holdings: [
      { name: "红利低波全收益", fund: "中证红利低波动全收益（H20269）", group: "cnDividend", weight: 42 },
      { name: "标普500全收益", fund: "标普 500 全收益（^SP500TR）", group: "usEquity", weight: 18 },
      { name: "纳指100全收益", fund: "纳斯达克 100 全收益（XNDX）", group: "usEquity", weight: 7.5 },
      { name: "微盘股等权", fund: "万得微盘股日频等权（8841431.WI）", group: "cnMicro", weight: 4.5 },
      { name: "30年国债指数", fund: "中债 30 年期国债财富（CBA21801.CB）", group: "cnBond", weight: 18 },
      { name: "现金", fund: "现金（年化 1.4%）", group: "cash", weight: 10 }
    ]
  },
  portfolioB10etf: {
    label: "组合二 · 10年ETF",
    sigma: 8.55,
    note: "按 ETF 上市以来短样本回测校准",
    calibrated: true,
    backtest: {
      period: "2023-06-13 ~ 2026-11-09",
      cagr: 10.98,
      volatility: 8.55,
      maxDrawdown: -6.71,
      sharpe: 1.15,
      riskFreeRate: 1.0
    },
    holdings: [
      { name: "红利低波全收益", fund: "中证红利低波动全收益（H20269）", group: "cnDividend", weight: 42 },
      { name: "标普500全收益", fund: "标普 500 全收益（^SP500TR）", group: "usEquity", weight: 18 },
      { name: "纳指100全收益", fund: "纳斯达克 100 全收益（XNDX）", group: "usEquity", weight: 7.5 },
      { name: "微盘股等权", fund: "万得微盘股日频等权（8841431.WI）", group: "cnMicro", weight: 4.5 },
      { name: "10年国债ETF", fund: "国泰上证 10 年期国债 ETF（511260.SH）", group: "cnBond", weight: 18 },
      { name: "现金", fund: "现金（年化 1.4%）", group: "cash", weight: 10 }
    ]
  },
  portfolioB30etf: {
    label: "组合二 · 30年ETF",
    sigma: 8.51,
    note: "按 ETF 上市以来短样本回测校准",
    calibrated: true,
    backtest: {
      period: "2023-06-13 ~ 2026-11-09",
      cagr: 11.62,
      volatility: 8.51,
      maxDrawdown: -6.27,
      sharpe: 1.23,
      riskFreeRate: 1.0
    },
    holdings: [
      { name: "红利低波全收益", fund: "中证红利低波动全收益（H20269）", group: "cnDividend", weight: 42 },
      { name: "标普500全收益", fund: "标普 500 全收益（^SP500TR）", group: "usEquity", weight: 18 },
      { name: "纳指100全收益", fund: "纳斯达克 100 全收益（XNDX）", group: "usEquity", weight: 7.5 },
      { name: "微盘股等权", fund: "万得微盘股日频等权（8841431.WI）", group: "cnMicro", weight: 4.5 },
      { name: "30年国债ETF", fund: "鹏扬中债 30 年期国债 ETF（511090.SH）", group: "cnBond", weight: 18 },
      { name: "现金", fund: "现金（年化 1.4%）", group: "cash", weight: 10 }
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
    if (groupA === "cnDividend") return 1;
    if (groupA === "usEquity") return 0.82; // 513100/513500 近十年实测约 0.82
    return 1;
  }
  const pair = [groupA, groupB].sort().join("|");
  if (pair === "cnDividend|cnMicro") return 0.50;
  if (pair === "cnDividend|usEquity") return 0.24;
  if (pair === "cnMicro|usEquity") return 0.28;
  if (pair === "cnBond|cnDividend") return 0.05;
  if (pair === "cnBond|cnMicro") return 0.05;
  if (pair === "cnBond|usEquity") return 0;
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

// 组合二各债券版本共享同一条样本口径说明，供前端与文案复用。
export const MC_PROFILE_GROUPS = {
  calibratedNames: ["portfolioA", "portfolioB57", "portfolioB10y", "portfolioB30y", "portfolioB10etf", "portfolioB30etf"],
  bondVariants: {
    portfolioB57: "指数版（2011 年起）",
    portfolioB10y: "指数版（2011 年起）",
    portfolioB30y: "指数版（2011 年起）",
    portfolioB10etf: "ETF 版（2023-06 起）",
    portfolioB30etf: "ETF 版（2023-06 起）"
  },
  indexSample: "2011-01-04 ~ 2026-11-09",
  etfSample: "2023-06-13 ~ 2026-11-09"
};

// 组合解析：内置预置优先，其次页面自定义组合（customProfiles 为 key→profile 映射）；未知 key 回退股债 50/50。
export function resolveProfile(profileKey, customProfiles = null) {
  if (MC_PROFILES[profileKey]) return { key: profileKey, profile: MC_PROFILES[profileKey] };
  if (customProfiles && customProfiles[profileKey]) return { key: profileKey, profile: customProfiles[profileKey] };
  return { key: "balanced", profile: MC_PROFILES.balanced };
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

// 每个耗尽年份桶的「典型失败路径」：取桶内样本中位收益率逐年构成一条代表性路径，
// 再用与正式现金流完全相同的 simulateCustomProjection 重放，得到可展示的资产轨迹。
function buildBucketPathSamples({
  failedYearByRun, returnPathByRun, years, bucketSize, annualExpense, mu,
  principal, inflation, annualReserveInterest, dividendIncomeByYear,
  expenseFlexibility, flexibilityDrawdown, flexibilityCut, isEndowment
}) {
  if (failedYearByRun.length === 0) return [];
  const bucketCount = Math.ceil(years / bucketSize);
  const samples = new Array(bucketCount);
  for (let index = 0; index < bucketCount; index += 1) {
    const start = index * bucketSize + 1;
    const end = Math.min(start + bucketSize - 1, years);
    const members = [];
    for (let run = 0; run < failedYearByRun.length; run += 1) {
      if (failedYearByRun[run] >= start && failedYearByRun[run] <= end) {
        members.push(returnPathByRun[run]);
      }
    }
    if (members.length === 0) continue;

    // 中位路径：逐年取各样本收益率的中位数，保留真实年份间的收益顺序结构。
    const medianPath = new Array(years);
    const column = new Array(members.length);
    for (let year = 0; year < years; year += 1) {
      for (let m = 0; m < members.length; m += 1) column[m] = members[m][year];
      column.sort((a, b) => a - b);
      medianPath[year] = percentile(column, 0.5);
    }

    const simulation = simulateCustomProjection({
      principal,
      annualExpense,
      annualReturn: mu,
      inflation,
      years,
      annualReserveInterest,
      dividendIncomeByYear,
      returnPath: medianPath,
      expenseFlexibility,
      flexibilityDrawdown,
      flexibilityCut
    });

    // 与主循环同口径的失败判定；重放失败年份取实际缺口年份，避免与桶区间错位。
    const replayDepletion = simulation.depletionYear ?? years;
    samples[index] = {
      start,
      end,
      sampleCount: members.length,
      depletionYear: replayDepletion,
      medianPath,
      points: simulation.points
    };
  }
  // 保持与 buildFailureBuckets 相同的索引对齐：没有样本的桶显式置为 null，调用方按索引取用。
  return Array.from(samples, (sample) => sample || null);
}

// 用一条指定收益路径做轻量存续判定（不构造 points，专供反事实归因使用）。
// 判定口径与 simulateCustomProjection 完全一致：资金缺口 > 1 元即失败；
// 金鹅永续还要求期末实际购买力不低于本金。
function pathSurvives({
  principal, annualExpense, inflation, years, annualReserveInterest,
  dividendIncomeByYear, returnPath, isEndowment,
  expenseFlexibility, flexibilityDrawdown, flexibilityCut
}) {
  let balance = principal;
  let peak = principal;
  for (let year = 1; year <= years; year += 1) {
    const start = balance;
    const yearReturn = Number(returnPath && returnPath[year - 1]);
    const investmentReturn = start * (Number.isFinite(yearReturn) ? yearReturn : 0);
    const available = start + investmentReturn;
    peak = Math.max(peak, start);
    const drawdown = peak > 0 ? 1 - start / peak : 0;
    let gross = annualExpense * Math.pow(1 + inflation, year - 1);
    if (expenseFlexibility && drawdown > flexibilityDrawdown) gross *= 1 - flexibilityCut;
    const reserveOffset = Math.min(gross, Math.max(0, annualReserveInterest));
    const dividendIncome = Math.max(0, Number(dividendIncomeByYear && dividendIncomeByYear[year]) || 0);
    const dividendOffset = Math.min(gross - reserveOffset, dividendIncome);
    const expense = gross - reserveOffset - dividendOffset;
    if (expense - available > 1) return false;
    balance = Math.max(0, available - expense);
  }
  if (isEndowment && balance / Math.pow(1 + inflation, years) < principal - 1) return false;
  return true;
}

// 几何平均年化收益：比算术平均更能反映长期复利体验。
function geometricMeanReturn(returnPath) {
  if (!Array.isArray(returnPath) || returnPath.length === 0) return 0;
  let logSum = 0;
  for (const r of returnPath) logSum += Math.log(1 + clamp(r, -0.9999, 100, 0));
  return Math.exp(logSum / returnPath.length) - 1;
}

// 失败归因：对每条失败路径做 4 项反事实测试，统计各补救措施的救活率；
// 主因按「收益特征画像」归类（早期/后期收益差、尾部亏损），比反事实组合更有区分度。
function attributeFailure({
  returnPath, geoReturn, mu, principal, annualExpense, inflation, years,
  annualReserveInterest, dividendIncomeByYear, isEndowment,
  expenseFlexibility, flexibilityDrawdown, flexibilityCut, fireResult
}) {
  const common = {
    annualExpense, inflation, years, dividendIncomeByYear, isEndowment,
    expenseFlexibility, flexibilityDrawdown, flexibilityCut
  };
  // 反事实救活率：回答「调哪个杠杆能把这条失败路径救回来」。
  const reorderPath = [...returnPath].sort((a, b) => b - a); // 好年份提前：检验顺序风险
  const medianPath = new Array(years).fill(mu);               // 每年稳定中枢：检验波动拖累
  const rescued = {
    order: pathSurvives({ ...common, principal, annualReserveInterest, returnPath: reorderPath }),
    volatility: pathSurvives({ ...common, principal, annualReserveInterest, returnPath: medianPath }),
    expense: pathSurvives({ ...common, principal, annualReserveInterest, returnPath, annualExpense: annualExpense * 0.8 })
  };
  const upPrincipal = principal * 1.2;
  rescued.principal = pathSurvives({
    ...common, principal: upPrincipal,
    annualReserveInterest: reserveInterestForStartingPrincipal(fireResult, upPrincipal),
    returnPath
  });

  // 互斥主因：按失败路径自身的收益特征归类，互补且可解释。
  // 先判断「结构性可救」——如果本金或支出单独调整即可救活，说明失败根源不在市场运气。
  // 再看收益画像——前期差后期好=顺序风险；出现极端亏损年=尾部冲击；否则=整体收益偏低。
  const half = Math.floor(years / 2);
  const earlyGeo = geometricMeanReturn(returnPath.slice(0, half));
  const lateGeo = geometricMeanReturn(returnPath.slice(half));
  const worstYear = Math.min(...returnPath);
  let primary;
  if (rescued.principal && !rescued.volatility) primary = "principal";
  else if (rescued.expense && !rescued.volatility) primary = "expense";
  else if (lateGeo - earlyGeo >= 0.012) primary = "order";       // 后期明显好于前期 = 顺序不利
  else if (worstYear <= -0.2) primary = "tail";                   // 单年极端亏损
  else primary = "return";                                        // 整体收益偏低

  return { rescued, primary, geoReturn };
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
  extraIncomeByYear = null,
  sigmaOverride = null,
  withAttribution = false,
  withBucketPaths = true,
  customProfiles = null
} = {}) {
  if (!fireResult || !fireResult.assumptions) {
    throw new Error("runMonteCarlo 需要 calculateFirePlan 的结果");
  }

  const resolved = resolveProfile(profileKey, customProfiles);
  const profile = resolved.profile;
  // 回测校准组合（组合一/二/三）：模拟中枢直接取回测 CAGR 与波动率，
  // 不再用持仓权重×相关性推算——那会偏离用户实测的组合级数字。
  const portfolioStats = profile.calibrated ? null : (profile.holdings ? computePortfolioStats(profile.holdings) : null);
  const runCount = Math.round(clamp(runs, 100, 20000, 5000));
  const randomSeed = Math.floor(clamp(seed, 0, 2147483647, 20261119));
  const years = Math.round(clamp(fireInput.years ?? fireResult.assumptions.years, 1, 80, 50));
  const inputMu = clamp((fireInput.returnRate ?? fireResult.assumptions.returnRate) / 100, -0.99, 1, 0.05);
  const mu = portfolioStats ? portfolioStats.mu : (profile.calibrated ? profile.backtest.cagr / 100 : inputMu);
  const sigmaPercent = sigmaOverride !== null && sigmaOverride !== undefined
    ? Number(sigmaOverride)
    : (portfolioStats ? portfolioStats.sigma * 100 : (profile.calibrated ? profile.backtest.volatility : profile.sigma));
  const sigma = clamp(sigmaPercent, 0, 100, profile.sigma) / 100;
  const principal = clamp(startingPrincipal ?? fireResult.chartStart ?? fireInput.principal ?? 0, 0, 1e12, 0);
  const inflation = Number(fireResult.inflation) || 0;
  const annualReserveInterest = reserveInterestForStartingPrincipal(fireResult, principal);
  const baseDividendIncome = fireResult.dividendPlan?.enabled
    ? fireResult.dividendPlan.dividendIncomeByYear
    : new Array(years + 1).fill(0);
  // 过渡期收入（Barista FI）：前 N 年的固定年度收入，与红利抵扣合并进同一条抵扣通道。
  const bridgeMerged = Array.isArray(extraIncomeByYear) && extraIncomeByYear.some((value) => Number(value) > 0);
  const dividendIncomeByYear = bridgeMerged
    ? baseDividendIncome.map((value, year) => (Number(value) || 0) + Math.max(0, Number(extraIncomeByYear[year]) || 0))
    : baseDividendIncome;
  const isEndowment = (fireInput.scenario ?? fireResult.assumptions.scenario) === "endowment";
  const sigmaLog = sigma > 0 ? Math.log(1 + sigma) : 0;
  const muLog = Math.log(1 + mu);

  const endBalances = [];
  const endRealBalances = [];
  const minBalances = [];
  const failedYears = [];
  const failedYearByRun = [];
  const returnPathByRun = [];
  const attributionStats = {
    geoFailed: [], geoSuccess: [],
    rescued: { order: 0, volatility: 0, expense: 0, principal: 0, any: 0 },
    primary: { order: 0, tail: 0, expense: 0, principal: 0, return: 0 }
  };
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

    if (survived) {
      successCount += 1;
      if (withAttribution) attributionStats.geoSuccess.push(geometricMeanReturn(returnPath));
    } else {
      failedYears.push(simulation.depletionYear ?? years);
      if (withBucketPaths) {
        failedYearByRun.push(simulation.depletionYear ?? years);
        returnPathByRun.push(returnPath);
      }
      if (withAttribution) {
        const geoReturn = geometricMeanReturn(returnPath);
        attributionStats.geoFailed.push(geoReturn);
        const attribution = attributeFailure({
          returnPath, geoReturn, mu, principal, annualExpense: fireResult.annual,
          inflation, years, annualReserveInterest, dividendIncomeByYear, isEndowment,
          expenseFlexibility, flexibilityDrawdown, flexibilityCut, fireResult
        });
        for (const key of ["order", "volatility", "expense", "principal"]) {
          if (attribution.rescued[key]) attributionStats.rescued[key] += 1;
        }
        if (Object.values(attribution.rescued).some(Boolean)) attributionStats.rescued.any += 1;
        attributionStats.primary[attribution.primary] += 1;
      }
    }
  }

  const sortedEnd = [...endBalances].sort((a, b) => a - b);
  const sortedMin = [...minBalances].sort((a, b) => a - b);

  let failureAttribution = null;
  if (withAttribution && failedYears.length > 0) {
    const failed = failedYears.length;
    const avg = (arr) => arr.length ? arr.reduce((sum, v) => sum + v, 0) / arr.length : null;
    const geoFailed = avg(attributionStats.geoFailed);
    const geoSuccess = avg(attributionStats.geoSuccess);
    const remedyMeta = [
      { key: "order", label: "收益顺序更理想", note: "把高收益年份提前，检验顺序风险" },
      { key: "volatility", label: "每年稳定拿到中枢收益", note: "抹平波动，检验波动拖累" },
      { key: "expense", label: "年支出降低 20%", note: "检验支出压力" },
      { key: "principal", label: "本金提高 20%", note: "检验本金是否不足" }
    ];
    const primaryMeta = [
      { key: "return", label: "收益整体偏低" },
      { key: "order", label: "收益顺序不利" },
      { key: "tail", label: "极端亏损年份" },
      { key: "expense", label: "支出压力偏高" },
      { key: "principal", label: "本金不足" }
    ];
    const sumPrimary = Object.values(attributionStats.primary).reduce((s, v) => s + v, 0) || 1;
    failureAttribution = {
      failedCount: failed,
      geoFailed,
      geoSuccess,
      geoGap: geoFailed !== null && geoSuccess !== null ? geoSuccess - geoFailed : null,
      remedies: remedyMeta.map((meta) => ({
        ...meta,
        rescued: attributionStats.rescued[meta.key],
        share: attributionStats.rescued[meta.key] / failed
      })),
      rescuableAny: attributionStats.rescued.any / failed,
      primary: primaryMeta.map((meta) => ({
        ...meta,
        count: attributionStats.primary[meta.key],
        share: attributionStats.primary[meta.key] / sumPrimary
      })).sort((a, b) => b.share - a.share)
    };
  }

  return {
    engineVersion: MC_ENGINE_VERSION,
    runs: runCount,
    seed: randomSeed,
    profileKey: resolved.key,
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
    p1End: percentile(sortedEnd, 0.01),
    p5End: percentile(sortedEnd, 0.05),
    p10End: percentile(sortedEnd, 0.1),
    p25End: percentile(sortedEnd, 0.25),
    p50End: percentile(sortedEnd, 0.5),
    p75End: percentile(sortedEnd, 0.75),
    p90End: percentile(sortedEnd, 0.9),
    p10Min: percentile(sortedMin, 0.1),
    p25Min: percentile(sortedMin, 0.25),
    p50Min: percentile(sortedMin, 0.5),
    p75Min: percentile(sortedMin, 0.75),
    p90Min: percentile(sortedMin, 0.9),
    buckets: buildFailureBuckets(failedYears, years),
    // 耗尽年份分桶的典型现金流曲线：每桶取样本中位收益率路径重放，供弹窗解读使用。
    bucketPaths: withBucketPaths ? buildBucketPathSamples({
      failedYearByRun,
      returnPathByRun,
      years,
      bucketSize: 10,
      annualExpense: fireResult.annual,
      mu,
      principal,
      inflation,
      annualReserveInterest,
      dividendIncomeByYear,
      expenseFlexibility,
      flexibilityDrawdown,
      flexibilityCut,
      isEndowment
    }) : [],
    conservationMaxError,
    flexAppliedCount,
    failureAttribution
  };
}

// 每条随机路径反推「刚好能走完」的最小本金；其分位数即为达到目标成功率所需本金。
export function computeRequiredPrincipalDistribution({
  fireResult,
  fireInput = {},
  profileKey = "portfolioA",
  runs = 2000,
  seed = 20261119,
  startingPrincipal,
  expenseCut = 0,
  extraMonthlyIncome = 0,
  expenseFlexibility = false,
  flexibilityDrawdown = 0.2,
  flexibilityCut = 0.1,
  extraIncomeByYear = null,
  customProfiles = null
} = {}) {
  if (!fireResult || !fireResult.assumptions) {
    throw new Error("computeRequiredPrincipalDistribution 需要 calculateFirePlan 的结果");
  }
  const resolved = resolveProfile(profileKey, customProfiles);
  const profile = resolved.profile;
  const stats = profile.calibrated ? null : (profile.holdings ? computePortfolioStats(profile.holdings) : null);
  const runCount = Math.round(clamp(runs, 100, 5000, 2000));
  const randomSeed = Math.floor(clamp(seed, 0, 2147483647, 20261119));
  const years = Math.round(clamp(fireInput.years ?? fireResult.assumptions.years, 1, 80, 50));
  const mu = stats ? stats.mu : (profile.calibrated ? profile.backtest.cagr / 100 : clamp((fireInput.returnRate ?? fireResult.assumptions.returnRate) / 100, -0.99, 1, 0.05));
  const sigma = clamp(stats ? stats.sigma * 100 : (profile.calibrated ? profile.backtest.volatility : profile.sigma), 0, 100, profile.sigma) / 100;
  const sigmaLog = sigma > 0 ? Math.log(1 + sigma) : 0;
  const muLog = Math.log(1 + mu);
  const inflation = Number(fireResult.inflation) || 0;
  // 胜率反推是在求「候选本金」，因此储备利息也必须按该候选本金同步计算。
  const reserveInterestFor = (candidate) => reserveInterestForStartingPrincipal(fireResult, candidate);
  const baseDividendIncome = fireResult.dividendPlan?.enabled
    ? fireResult.dividendPlan.dividendIncomeByYear
    : new Array(years + 1).fill(0);
  // 过渡期收入（Barista FI）：前 N 年的固定年度收入，与红利抵扣合并进同一条抵扣通道。
  const bridgeMerged = Array.isArray(extraIncomeByYear) && extraIncomeByYear.some((value) => Number(value) > 0);
  const dividendIncomeByYear = bridgeMerged
    ? baseDividendIncome.map((value, year) => (Number(value) || 0) + Math.max(0, Number(extraIncomeByYear[year]) || 0))
    : baseDividendIncome;
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
    profileKey: resolved.key,
    mu, sigma, annualExpense,
    sorted,
    p50: percentile(sorted, 0.5),
    p80: percentile(sorted, 0.8),
    p90: percentile(sorted, 0.9),
    p95: percentile(sorted, 0.95)
  };
}

// 一键汇总可用的胜率杠杆：目标本金分位、可自由勾选组合的调整项、配置对比。
// selection 描述勾选组合：params 为各项自定义参数（缺省值仅作预填建议），checked 为各项勾选状态。
// 勾选或参数变化后整份分析完整重算：基线、单项、组合（含反推本金分布）按同一批随机路径全部重跑。
export function analyzeSuccessLevers({
  fireResult,
  fireInput = {},
  targetRate = 0.9,
  runs = 2000,
  seed = 20261119,
  startingPrincipal,
  profileKey = "portfolioA",
  selection = null,
  customProfiles = null
} = {}) {
  const target = clamp(targetRate, 0.5, 0.99, 0.9);
  const common = { fireResult, fireInput, runs, seed, startingPrincipal, profileKey, customProfiles };
  const baseline = runMonteCarlo({ ...common });
  const horizonYears = Math.round(clamp(fireInput.years ?? fireResult.assumptions.years, 1, 80, 50));
  // 过渡期收入：FIRE 后前 N 年每年有固定兼职收入，名义金额不随通胀（与红利抵扣同通道）。
  const bridgeByYear = (monthly, yearCount) => {
    const arr = new Array(horizonYears + 1).fill(0);
    const span = Math.min(Math.max(0, Math.round(yearCount)), horizonYears);
    for (let year = 1; year <= span; year += 1) arr[year] = monthly * 12;
    return arr;
  };

  // 各项自定义参数：未填或为 0 时该行只展示输入框，不产生实际调整。
  const params = selection?.params ?? {};
  const checked = selection?.checked ?? {};
  const isChecked = (key) => Boolean(checked[key]);
  const sel = {
    expenseCutPct: clamp(Number(params.expenseCutPct) || 0, 0, 90, 0),
    extraMonthlyIncome: Math.max(0, Number(params.extraMonthlyIncome) || 0),
    delayYears: Math.round(clamp(Number(params.delayYears) || 0, 0, 30, 0)),
    extraPrincipal: Math.max(0, Number(params.extraPrincipal) || 0),
    bridgeMonthly: Math.max(0, Number(params.bridgeMonthly) || 0),
    bridgeYears: Math.round(clamp(Number(params.bridgeYears) || 0, 0, horizonYears, 0)),
    dividendIncome: Boolean(selection?.dividendIncome),
    expenseFlexibility: Boolean(selection?.expenseFlexibility),
    flexibilityStrong: Boolean(selection?.flexibilityStrong)
  };
  const expenseCut = sel.expenseCutPct / 100;
  const adjustedAnnual = (cut, extraMonthly) => Math.max(0, Number(fireResult.annual) * (1 - cut) - extraMonthly * 12);
  // 推迟 FIRE：本金按中枢收益复利增长，定投继续按现有参数累计。
  const delayPrincipal = (base, years) => {
    const rate = baseline.mu;
    const dcaMonthly = Number(fireInput.dcaMonthly ?? fireResult.assumptions.dcaMonthly) || 0;
    const factor = Math.pow(1 + rate, years);
    const contribution = rate > 0
      ? dcaMonthly * 12 * (factor - 1) / rate
      : dcaMonthly * 12 * years;
    return base * factor + contribution;
  };

  // 单项效果：始终展示全部调整项（含输入框），参数为 0 的项直接复用基线，不重跑模拟。
  const levers = [];
  if (sel.expenseCutPct > 0) {
    const mc = runMonteCarlo({ ...common, fireResult: { ...fireResult, annual: adjustedAnnual(expenseCut, 0) } });
    levers.push({ key: "expenseCut", name: "支出降低", label: `支出降低 ${sel.expenseCutPct}%`, detail: `年支出降至 ${formatPlain(adjustedAnnual(expenseCut, 0))}`, successRate: mc.successRate });
  } else {
    levers.push({ key: "expenseCut", name: "支出降低", label: "支出降低", detail: "填入比例后计算", successRate: baseline.successRate });
  }
  if (sel.extraMonthlyIncome > 0) {
    const mc = runMonteCarlo({ ...common, fireResult: { ...fireResult, annual: adjustedAnnual(0, sel.extraMonthlyIncome) } });
    levers.push({ key: "extraIncome", name: "每月额外收入", label: `每月多 ${formatPlain(sel.extraMonthlyIncome)} 收入`, detail: `相当于年支出减少 ${formatPlain(sel.extraMonthlyIncome * 12)}`, successRate: mc.successRate });
  } else {
    levers.push({ key: "extraIncome", name: "每月额外收入", label: "每月额外收入", detail: "填入金额后计算", successRate: baseline.successRate });
  }
  if (sel.bridgeMonthly > 0 && sel.bridgeYears > 0) {
    const mc = runMonteCarlo({ ...common, extraIncomeByYear: bridgeByYear(sel.bridgeMonthly, sel.bridgeYears) });
    levers.push({
      key: "bridge",
      name: "过渡期兼职收入",
      label: `前 ${sel.bridgeYears} 年兼职 ${formatPlain(sel.bridgeMonthly)}/月`,
      detail: `FIRE 第 1–${sel.bridgeYears} 年每年抵扣 ${formatPlain(sel.bridgeMonthly * 12)}，针对性对冲顺序风险`,
      successRate: mc.successRate
    });
  } else {
    levers.push({ key: "bridge", name: "过渡期兼职收入", label: "过渡期兼职收入", detail: "填入金额与年数后计算", successRate: baseline.successRate });
  }
  if (sel.delayYears > 0) {
    const grown = delayPrincipal(startingPrincipal, sel.delayYears);
    const mc = runMonteCarlo({ ...common, startingPrincipal: grown });
    levers.push({ key: "delay", name: "推迟 FIRE", label: `推迟 ${sel.delayYears} 年 FIRE`, detail: `继续定投后本金约 ${formatPlain(grown)}`, successRate: mc.successRate });
  } else {
    levers.push({ key: "delay", name: "推迟 FIRE", label: "推迟 FIRE", detail: "填入年数后计算", successRate: baseline.successRate });
  }
  if (sel.extraPrincipal > 0) {
    const mc = runMonteCarlo({ ...common, startingPrincipal: startingPrincipal + sel.extraPrincipal });
    levers.push({ key: "extraPrincipal", name: "提高初始本金", label: `提高初始本金 ${formatPlain(sel.extraPrincipal)}`, detail: `本金增至 ${formatPlain(startingPrincipal + sel.extraPrincipal)}`, successRate: mc.successRate });
  } else {
    levers.push({ key: "extraPrincipal", name: "提高初始本金", label: "提高初始本金", detail: "填入金额后计算", successRate: baseline.successRate });
  }

  // 页面「红利低波退休金」：按当前定投参数单独算出的领取现金流，作为额外年度抵扣。
  const dividendEnabledInBaseline = Boolean(fireResult.dividendPlan?.enabled);
  const dividendResult = calculateFirePlan({ ...fireInput, dividendEnabled: true });
  const dividendPlan = dividendResult.dividendPlan;
  const dividendUsable = Boolean(dividendPlan?.enabled && dividendPlan.startYear !== null);
  if (dividendUsable) {
    const mc = runMonteCarlo({ ...common, fireResult: { ...fireResult, dividendPlan } });
    levers.push({
      key: "dividend",
      name: "计入页面红利退休金",
      label: "计入页面红利退休金",
      detail: `FIRE 第 ${dividendPlan.startYear} 年起 ${formatPlain(dividendPlan.annualIncome)}/年`,
      successRate: mc.successRate
    });
  } else {
    levers.push({
      key: "dividend",
      name: "计入页面红利退休金",
      label: "计入页面红利退休金",
      detail: "当前定投参数无法产生领取金额",
      successRate: baseline.successRate
    });
  }

  const flexMc = runMonteCarlo({ ...common, expenseFlexibility: true });
  levers.push({
    key: "flexibility",
    name: "开启支出弹性",
    label: "开启支出弹性",
    detail: "回撤超 20% 时当年支出减 10%",
    successRate: flexMc.successRate
  });

  const flexStrongMc = runMonteCarlo({ ...common, expenseFlexibility: true, flexibilityDrawdown: 0.3, flexibilityCut: 0.3 });
  levers.push({
    key: "flexibilityStrong",
    name: "支出弹性·强化档",
    label: "支出弹性·强化档",
    detail: "回撤超 30% 时当年支出减 30%，救活率更高但体验代价更大",
    successRate: flexStrongMc.successRate
  });

  // 勾选组合：按勾选状态叠加各项参数，整份分析（含反推本金分布）完整重算。
  const useCut = isChecked("expenseCut") ? expenseCut : 0;
  const useExtraIncome = isChecked("extraIncome") ? sel.extraMonthlyIncome : 0;
  const useDelayYears = isChecked("delay") ? sel.delayYears : 0;
  const useExtraPrincipal = isChecked("extraPrincipal") ? sel.extraPrincipal : 0;
  const useDividend = sel.dividendIncome && dividendUsable;
  const useBridge = isChecked("bridge") && sel.bridgeMonthly > 0 && sel.bridgeYears > 0
    ? bridgeByYear(sel.bridgeMonthly, sel.bridgeYears)
    : null;
  // 普通档与强化档弹性互斥：勾选强化档时以强化档参数为准。
  const useFlex = sel.expenseFlexibility || sel.flexibilityStrong;
  const flexParams = sel.flexibilityStrong ? { flexibilityDrawdown: 0.3, flexibilityCut: 0.3 } : {};
  const hasSelection = (useCut > 0 && isChecked("expenseCut")) || (useExtraIncome > 0 && isChecked("extraIncome"))
    || (useDelayYears > 0 && isChecked("delay")) || (useExtraPrincipal > 0 && isChecked("extraPrincipal"))
    || Boolean(sel.dividendIncome) || Boolean(useBridge) || useFlex;

  let combined = null;
  let combinedFireResult = null;
  let combinedPrincipal = null;
  if (hasSelection) {
    const combinedAnnual = adjustedAnnual(useCut, useExtraIncome);
    combinedPrincipal = delayPrincipal(startingPrincipal + useExtraPrincipal, useDelayYears);
    combinedFireResult = {
      ...fireResult,
      annual: combinedAnnual,
      dividendPlan: useDividend ? dividendPlan : fireResult.dividendPlan
    };
    const combinedCommon = {
      ...common,
      fireResult: combinedFireResult,
      startingPrincipal: combinedPrincipal,
      expenseFlexibility: useFlex,
      ...flexParams,
      extraIncomeByYear: useBridge
    };
    const combinedMc = runMonteCarlo({ ...combinedCommon });
    // 反推所需本金：用原始支出参数 + 组合口径的削减参数，避免重复调整；反推过程中本金按候选值求解。
    const requiredCombined = computeRequiredPrincipalDistribution({
      ...common,
      expenseCut: useCut,
      extraMonthlyIncome: useExtraIncome,
      expenseFlexibility: useFlex,
      ...flexParams,
      extraIncomeByYear: useBridge
    });
    const combinedTargetPrincipal = percentile(requiredCombined.sorted, target);
    const details = [];
    if (useCut > 0 && isChecked("expenseCut")) details.push(`支出降低 ${sel.expenseCutPct}%`);
    if (useExtraIncome > 0 && isChecked("extraIncome")) details.push(`每月多 ${formatPlain(useExtraIncome)} 收入`);
    if (useDelayYears > 0 && isChecked("delay")) details.push(`推迟 ${useDelayYears} 年 FIRE`);
    if (useExtraPrincipal > 0 && isChecked("extraPrincipal")) details.push(`初始本金提高 ${formatPlain(useExtraPrincipal)}`);
    if (sel.dividendIncome) details.push(useDividend ? `计入红利退休金（第 ${dividendPlan.startYear} 年起）` : "红利退休金不可用（当前定投参数无领取金额）");
    if (useBridge) details.push(`前 ${sel.bridgeYears} 年兼职 ${formatPlain(sel.bridgeMonthly)}/月`);
    if (sel.flexibilityStrong) details.push("支出弹性强化档（回撤 30% 减 30%）");
    else if (sel.expenseFlexibility) details.push("开启支出弹性");
    combined = {
      principal: combinedPrincipal,
      annualExpense: combinedAnnual,
      successRate: combinedMc.successRate,
      improvement: combinedMc.successRate - baseline.successRate,
      targetPrincipal: combinedTargetPrincipal,
      gap: combinedTargetPrincipal - combinedPrincipal,
      runs: requiredCombined.runs,
      dividendUsable: useDividend,
      details
    };
  }

  // 配置对比：只对比页面自定义组合（内置预置已从 UI 撤下，仅作为引擎回退口径保留）。
  // 未勾选时按当前本金，勾选后按组合口径（支出与本金同步调整），保证口径一致。
  const profileContext = hasSelection
    ? { fireResult: combinedFireResult, startingPrincipal: combinedPrincipal, expenseFlexibility: useFlex, ...flexParams, extraIncomeByYear: useBridge }
    : {};
  const profileKeys = Object.keys(customProfiles || {});
  const profiles = profileKeys.map((key) => ({
    key,
    label: resolveProfile(key, customProfiles).profile.label,
    successRate: runMonteCarlo({ ...common, ...profileContext, profileKey: key }).successRate
  }));

  const required = computeRequiredPrincipalDistribution({ ...common });
  return {
    targetRate: target,
    targetPrincipal: percentile(required.sorted, target),
    currentPrincipal: startingPrincipal,
    gap: percentile(required.sorted, target) - startingPrincipal,
    baselineSuccessRate: baseline.successRate,
    dividendEnabledInBaseline,
    dividendPlan,
    required,
    levers,
    profiles,
    selection: sel,
    hasSelection,
    combined
  };
}

function formatPlain(value) {
  return `¥${Math.round(Number(value) || 0).toLocaleString("zh-CN")}`;
}
