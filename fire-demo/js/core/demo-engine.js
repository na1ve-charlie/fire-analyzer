"use strict";

// FIRE 2.0 结构优化 DEMO 引擎（独立，不依赖主站）
// 目标：三情景 + 三红利模式 + 账户资金闭环 + 守恒校验 + 压力路径。
// 所有金额均为名义金额；收益率口径为扣除费用后的名义净总回报。

export const SCENARIOS = {
  conservative: {
    label: "保守情景",
    portfolioReturn: 3.5, inflation: 3.5, dcaReturn: 3.5,
    reserveReturn: 1, dividendYield: 2, sideIncomeMonthly: 0, withdrawalRate: 2.5
  },
  base: {
    label: "基准情景",
    portfolioReturn: 5.0, inflation: 2.5, dcaReturn: 5.0,
    reserveReturn: 2, dividendYield: 3, sideIncomeMonthly: 1000, withdrawalRate: 3.0
  },
  optimistic: {
    label: "乐观情景",
    portfolioReturn: 6.5, inflation: 2.0, dcaReturn: 6.5,
    reserveReturn: 3, dividendYield: 4, sideIncomeMonthly: 2000, withdrawalRate: 3.5
  }
};

// 分类通胀：每类支出独立增长，医疗单独按更高通胀
export const INFLATION_BY_CATEGORY = {
  food: { label: "饮食", base: 2.5, stress: 4 },
  utilities: { label: "水电燃气", base: 2.5, stress: 4 },
  property: { label: "物业", base: 3, stress: 5 },
  maintenance: { label: "房屋维护", base: 3, stress: 5 },
  daily: { label: "日常消费", base: 2.5, stress: 4 },
  medical: { label: "医疗", base: 4, stress: 6 },
  appliance: { label: "家电折旧", base: 2.5, stress: 4 }
};

export const STRESS_PATHS = {
  normal: { label: "正常情景", desc: "每年按情景收益率，通胀按情景值" },
  lowReturn: { label: "长期低收益", desc: "投资/定投每年 3%，通胀 3%" },
  earlyBear: { label: "初期熊市", desc: "第1年 -25%、第2年 -10%、第3年 0%，之后回到情景收益" },
  highInflation: { label: "高通胀冲击", desc: "前5年收益 4%、通胀 5%，之后回到情景值" }
};

export const DEFAULT_EXPENSES = [
  { id: "property", name: "物业费", amount: 300 },
  { id: "maintenance", name: "房屋维护", amount: 250 },
  { id: "utilities", name: "水电燃气", amount: 300 },
  { id: "food", name: "饮食", amount: 1500 },
  { id: "medical", name: "医疗", amount: 400 },
  { id: "daily", name: "日常开销", amount: 350 },
  { id: "appliance", name: "家电折旧", amount: 125 }
];

const num = (v, fallback = 0) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
};
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 压力路径下第 year 年的投资组合收益率（小数）
function portfolioReturnForYear(scenario, stressKey, year) {
  const baseR = scenario.portfolioReturn / 100;
  if (stressKey === "lowReturn") return 0.03;
  if (stressKey === "earlyBear") {
    if (year === 1) return -0.25;
    if (year === 2) return -0.10;
    if (year === 3) return 0;
    return baseR;
  }
  if (stressKey === "highInflation" && year <= 5) return 0.04;
  return baseR;
}

// 压力路径下第 year 年的通胀率（小数，分类通胀的基准乘数）
function inflationForYear(scenario, stressKey, year) {
  const baseI = scenario.inflation / 100;
  if (stressKey === "lowReturn") return 0.03;
  if (stressKey === "highInflation" && year <= 5) return 0.05;
  return baseI;
}

// 某年总生活支出：各分类按自己的通胀率从 FIRE 第 1 年（t=0 基准）增长
function expenseForYear(expenses, scenario, stressKey, year, useCategoryInflation, stressInflation) {
  const generalI = inflationForYear(scenario, stressKey, year);
  return expenses.reduce((sum, item) => {
    const category = INFLATION_BY_CATEGORY[item.id];
    let rate = generalI;
    if (useCategoryInflation && category) {
      const raw = stressInflation ? category.stress : category.base;
      rate = raw / 100;
      if (stressKey === "lowReturn") rate = Math.max(rate, 0.03);
      if (stressKey === "highInflation" && year <= 5) rate = Math.max(rate, 0.05);
    }
    // 支出项为月度金额，乘 12 得年度支出
    return sum + num(item.amount) * 12 * Math.pow(1 + rate, year - 1);
  }, 0);
}

// 定投账户每年缴款额（月末投入、月投额按通胀逐年上调）；收益递推交给主循环统一处理。
function buildDcaPaymentSchedule(input, scenario) {
  const years = Math.max(0, Math.round(num(input.dcaYears, 25)));
  const baseMonthly = num(input.dcaMonthly, 1200);
  const schedule = [{ year: 0, annualPayment: 0, cumulative: 0, monthly: baseMonthly }];
  let cumulative = 0;
  for (let y = 1; y <= years; y += 1) {
    const monthly = baseMonthly * Math.pow(1 + scenario.inflation / 100, y - 1);
    const annualPayment = monthly * 12;
    cumulative += annualPayment;
    schedule.push({ year: y, annualPayment, cumulative, monthly });
  }
  return {
    schedule,
    years,
    finalMonthly: baseMonthly * Math.pow(1 + scenario.inflation / 100, Math.max(0, years - 1)),
    totalContributed: cumulative
  };
}

// 定投账户第 year 年的收益率（压力路径）
function dcaReturnForYear(scenario, stressKey, year) {
  if (stressKey === "lowReturn") return 0.03;
  if (stressKey === "earlyBear") {
    if (year === 1) return -0.25;
    if (year === 2) return -0.10;
    if (year === 3) return 0;
    return scenario.dcaReturn / 100;
  }
  if (stressKey === "highInflation" && year <= 5) return 0.04;
  return scenario.dcaReturn / 100;
}

// 三种领取模式的规则定义；实际提款额在主循环中按当年余额递推，保证守恒。
function buildPayoutPlan(input, scenario, years, fundAtStart) {
  const startYear = Math.min(Math.round(num(input.dcaYears, 25)), years);
  const remaining = Math.max(0, years - startYear + 1);
  const mode = input.dividendMode || "dividend"; // dividend | totalReturn | annuity
  const yieldRate = scenario.dividendYield / 100;
  const withdrawRate = scenario.withdrawalRate / 100;
  const rDca = scenario.dcaReturn / 100;
  // 固定年金的支付额由领取起点余额、收益率、剩余年数决定
  const annuityPayment = remaining > 0
    ? (rDca <= 0 ? fundAtStart / remaining : fundAtStart * rDca / (1 - Math.pow(1 + rDca, -remaining)))
    : 0;
  return {
    mode, startYear, remaining, yieldRate, withdrawRate, annuityPayment,
    fundAtStart,
    annualAtStart: mode === "dividend" ? fundAtStart * yieldRate
      : mode === "totalReturn" ? fundAtStart * withdrawRate : annuityPayment
  };
}

// 给定领取前余额，计算当年提款额
function payoutForYear(plan, balanceBefore) {
  if (plan.mode === "dividend") return balanceBefore * plan.yieldRate;
  if (plan.mode === "totalReturn") return balanceBefore * plan.withdrawRate;
  return plan.annuityPayment;
}

/**
 * 主模拟：账户 A 主投资 / B 定投 / C 医疗储备 / D 现金储备
 * 定投来源 dcaSource: side(副业) | main(主账户) | external(独立外部收入)
 */
export function runDemoSimulation(input = {}) {
  const scenarioKey = SCENARIOS[input.scenarioKey] ? input.scenarioKey : "base";
  const scenario = SCENARIOS[scenarioKey];
  const stressKey = STRESS_PATHS[input.stressKey] ? input.stressKey : "normal";
  const years = clamp(Math.round(num(input.years, 50)), 1, 80);
  const expenses = Array.isArray(input.expenses) && input.expenses.length ? input.expenses : DEFAULT_EXPENSES;
  const totalAssets = num(input.totalAssets, 1885510);
  const reserveIncluded = input.reserveIncluded !== false; // 188.55万是否含储备
  const medicalReserve = num(input.medicalReserve, 150000);
  const cashReserve = num(input.cashReserve, 116100);
  const safetyPad = totalAssets * 0.1 / 1.1; // 从含安全垫的总资产反推安全垫本金
  const reserveBalance = medicalReserve + cashReserve + safetyPad;
  const mainStart = reserveIncluded ? Math.max(0, totalAssets - reserveBalance) : totalAssets;

  const dca = buildDcaPaymentSchedule(input, scenario);
  const dcaSource = ["side", "main", "external"].includes(input.dcaSource) ? input.dcaSource : "side";
  const useCategoryInflation = input.useCategoryInflation !== false;
  const stressInflation = Boolean(input.stressInflation);
  // 蒙特卡洛注入：外部收益路径（按年返回小数收益率）。提供时覆盖情景/压力路径收益。
  const mainReturnFn = typeof input.mainReturnPathFn === "function" ? input.mainReturnPathFn : null;
  const dcaReturnFn = typeof input.dcaReturnPathFn === "function" ? input.dcaReturnPathFn : null;
  // 支出弹性：主账户相对路径内历史高点回撤超过阈值时，当年支出按比例削减（行为弹性）。
  const flexEnabled = Boolean(input.expenseFlexibility);
  const flexDrawdown = num(input.flexibilityDrawdown, 0.2);
  const flexCut = num(input.flexibilityCut, 0.1);

  // 定投账户余额需要先跑完积累期，得到领取起点的资金，才能算固定年金支付额。
  let dcaFundAtStart = 0;
  for (let y = 1; y <= dca.years; y += 1) {
    const r = dcaReturnFn ? dcaReturnFn(y) : dcaReturnForYear(scenario, stressKey, y);
    dcaFundAtStart = dcaFundAtStart * (1 + r) + dca.schedule[y].annualPayment;
  }
  const payout = buildPayoutPlan(input, scenario, years, dcaFundAtStart);

  const points = [];
  let main = mainStart;
  let reserve = reserveBalance;
  let dcaBal = 0;
  let depletedYear = null;
  let conservationMaxError = 0;
  const startTotal = main + dcaBal + reserve;
  let cumulativeExternalIncome = 0;
  let cumulativeConsumption = 0;
  let annuityPayment = payout.annuityPayment;
  let mainPeak = mainStart; // 路径内历史高点，用于支出弹性判定

  for (let year = 1; year <= years; year += 1) {
    const openMain = main;
    const openDca = dcaBal;
    const openReserve = reserve;
    const openTotal = openMain + openDca + openReserve;

    // 1) 主账户、储备账户收益（储备收益从第 1 年即开始计提）
    const rPortfolio = mainReturnFn ? mainReturnFn(year) : portfolioReturnForYear(scenario, stressKey, year);
    const mainReturn = openMain * rPortfolio;
    const reserveInterest = openReserve * scenario.reserveReturn / 100;

    // 2) 生活支出（分类通胀）＋ 行为弹性：主账户自高点回撤超阈值时按比例削减当年支出
    let expense = expenseForYear(expenses, scenario, stressKey, year, useCategoryInflation, stressInflation);
    mainPeak = Math.max(mainPeak, openMain);
    const drawdown = mainPeak > 0 ? 1 - openMain / mainPeak : 0;
    const flexApplied = flexEnabled && drawdown > flexDrawdown;
    if (flexApplied) expense *= 1 - flexCut;

    // 3) 副业收入（外部收入在步骤 7 统一计算，定投缴款经分配后入账）
    const sideIncomeRaw = num(scenario.sideIncomeMonthly, 0) * 12;

    // 4) 定投账户（计划口径）：先按计划缴款计算账户与提款需求
    const dcaReturnRate = dcaReturnFn ? dcaReturnFn(year) : dcaReturnForYear(scenario, stressKey, year);
    const dcaReturn = openDca * dcaReturnRate;
    const dcaPaymentPlan = dca.schedule[year]?.annualPayment || 0;
    const beforePayout = Math.max(0, openDca + dcaReturn + dcaPaymentPlan);
    // 年金支付额在真正开始领取的当年按实际账户余额重算，避免预估余额与实际记账不一致。
    if (payout.mode === "annuity" && year === payout.startYear) {
      const r = scenario.dcaReturn / 100;
      const n = payout.remaining;
      annuityPayment = n > 0
        ? (r <= 0 ? beforePayout / n : beforePayout * r / (1 - Math.pow(1 + r, -n)))
        : 0;
      payout.annuityPayment = annuityPayment;
      payout.annualAtStart = annuityPayment;
      payout.fundAtStart = beforePayout;
    }
    // 当年生活现金流缺口（副业 + 储备利息之后），决定定投提款的实际需要量。
    const livingGap = Math.max(0, expense - sideIncomeRaw - reserveInterest);
    const plannedPayout = year >= payout.startYear
      ? Math.min(beforePayout, payoutForYear({ ...payout, annuityPayment }, beforePayout))
      : 0;

    // 5) 资金分配：生活优先，定投次之。主账户可用于定投的资金按"最坏情况生活需求"预判，保证主账户永不为负。
    const sideToDca = dcaSource === "side" ? Math.min(sideIncomeRaw, dcaPaymentPlan) : 0;
    // external 模式缴款由外部收入足额承担，主账户不出钱；side 模式缺口部分转由主账户补足
    const mainToDcaPlan = dcaSource === "main" ? dcaPaymentPlan : dcaSource === "side" ? dcaPaymentPlan - sideToDca : 0;
    const available = openMain + mainReturn;
    const sideAfterDca = Math.max(0, sideIncomeRaw - sideToDca);
    // 最坏情况生活需求（假设定投提款为 0），用于预留主账户资金
    const worstNeed = Math.max(0, expense - sideAfterDca - reserveInterest);
    const mainToDca = Math.min(mainToDcaPlan, Math.max(0, available - worstNeed));
    // 定投账户当年实际入账 = 副业投入 + 主账户投入（external 模式由外部收入足额缴付）
    const dcaPaymentActual = dcaSource === "external" ? dcaPaymentPlan : sideToDca + mainToDca;
    // 定提款按实际资金封顶
    const beforePayoutActual = openDca + dcaReturn + dcaPaymentActual;
    const dcaPayout = year >= payout.startYear
      ? Math.min(plannedPayout, livingGap, beforePayoutActual)
      : 0;
    const mainNeed = Math.max(0, expense - sideAfterDca - reserveInterest - dcaPayout);
    const actualWithdrawal = Math.min(mainNeed, available);
    const unmetExpense = mainNeed - actualWithdrawal;
    main = available - actualWithdrawal - mainToDca;
    dcaBal = beforePayoutActual - dcaPayout;
    reserve = openReserve;

    // 7) 守恒：期末总资产 = 期初 + 投资收益 + 外部收入 - 实际消费（破产年份按实际支付计，守恒恒成立）
    const closeTotal = main + dcaBal + reserve;
    const investmentIncome = mainReturn + reserveInterest + dcaReturn;
    const externalIncome = sideIncomeRaw + (dcaSource === "external" ? dcaPaymentActual : 0);
    const actualConsumption = expense - unmetExpense;
    const expected = openTotal + investmentIncome + externalIncome - actualConsumption;
    const error = closeTotal - expected;
    conservationMaxError = Math.max(conservationMaxError, Math.abs(error));
    cumulativeExternalIncome += externalIncome;
    cumulativeConsumption += actualConsumption;

    if (unmetExpense > 0.01 && depletedYear === null) depletedYear = year;

    points.push({
      year,
      openMain, openDca, openReserve, openTotal,
      mainReturn, reserveInterest, dcaReturn, dcaPayment: dcaPaymentActual, dcaPayout,
      expense, actualConsumption, unmetExpense, sideIncome: sideAfterDca, sideToDca, mainToDca,
      externalContribution: dcaSource === "external" ? dcaPaymentActual : 0,
      reserveOffset: reserveInterest, mainWithdrawal: actualWithdrawal,
      drawdown, flexApplied,
      main, dcaBal, reserve, closeTotal, conservationError: error
    });
  }

  const final = points[points.length - 1];
  const mainValues = points.map((p) => p.main);
  const totalValues = points.map((p) => p.closeTotal);
  return {
    scenarioKey, scenario, stressKey, years,
    mainStart, reserveBalance, totalAssets, reserveIncluded,
    dca, payout, dcaSource, useCategoryInflation, stressInflation,
    points,
    startTotal,
    endMain: final.main, endDca: final.dcaBal, endReserve: final.reserve, endTotal: final.closeTotal,
    minMain: Math.min(...mainValues), minTotal: Math.min(...totalValues),
    depletedYear,
    conservationMaxError,
    cumulativeExternalIncome, cumulativeConsumption
  };
}

export function runAllScenarios(baseInput = {}) {
  const out = {};
  for (const key of Object.keys(SCENARIOS)) {
    out[key] = runDemoSimulation({ ...baseInput, scenarioKey: key });
  }
  return out;
}

export function runStressTests(baseInput = {}) {
  const out = {};
  for (const key of Object.keys(STRESS_PATHS)) {
    out[key] = runDemoSimulation({ ...baseInput, stressKey: key });
  }
  return out;
}

// ============ 蒙特卡洛模拟 ============

// 资产配置预设：μ 为长期年化（几何口径），σ 为年度算术波动率。示意假设值，非预测。
export const ASSET_PROFILES = {
  equity100: { label: "100% 宽基股票", mu: 7, sigma: 22 },
  equity70: { label: "股 70% / 债 30%", mu: 6, sigma: 14 },
  balanced: { label: "股债 50/50", mu: 5, sigma: 9 },
  dividend: { label: "红利低波为主", mu: 5.5, sigma: 16 }
};

// mulberry32：确定性 PRNG，固定种子保证结果完全可复现。
function mulberry32(seed) {
  let s = Math.floor(seed) | 0;
  return function () {
    s = (s + 0x6D2B79F5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Box-Muller 标准正态
function standardNormal(rand) {
  let u = 0;
  let v = 0;
  while (u === 0) u = rand();
  while (v === 0) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function percentile(sortedValues, p) {
  if (!sortedValues.length) return null;
  const index = clamp((sortedValues.length - 1) * p, 0, sortedValues.length - 1);
  const lo = Math.floor(index);
  const hi = Math.ceil(index);
  return sortedValues[lo] + (sortedValues[hi] - sortedValues[lo]) * (index - lo);
}

/**
 * 蒙特卡洛主入口：对主账户/定投账户各生成 N 条独立随机收益路径（对数正态），
 * 逐条复用 runDemoSimulation 的现金流与守恒逻辑，输出存续成功率与分布统计。
 * μ 为长期年化（几何）；收益路径 r(y) = exp(muLog + sigmaLog × Z) − 1。
 */
export function runMonteCarlo(input = {}) {
  const profileKey = ASSET_PROFILES[input.mcProfile] ? input.mcProfile : "equity70";
  const profile = ASSET_PROFILES[profileKey];
  const mu = num(input.mcMu, profile.mu) / 100;        // 长期年化（几何口径）
  const sigma = num(input.mcSigma, profile.sigma) / 100; // 年度波动率
  const runs = clamp(Math.round(num(input.mcRuns, 5000)), 100, 20000);
  const seed = Math.floor(num(input.mcSeed, 20261119));
  const years = clamp(Math.round(num(input.years, 50)), 1, 80);
  const sigmaLog = sigma > 0 ? Math.log(1 + sigma) : 0;
  const muLog = Math.log(1 + mu);

  const successes = [];
  const failedYears = [];
  const endTotals = [];
  const minTotals = [];
  let conservationMaxError = 0;
  let flexAppliedCount = 0;

  for (let i = 0; i < runs; i += 1) {
    const rand = mulberry32(seed + i * 7919);
    const mainPath = new Array(years);
    const dcaPath = new Array(years);
    for (let y = 0; y < years; y += 1) {
      mainPath[y] = Math.exp(muLog + sigmaLog * standardNormal(rand)) - 1;
      dcaPath[y] = Math.exp(muLog + sigmaLog * standardNormal(rand)) - 1;
    }
    const r = runDemoSimulation({
      ...input,
      stressKey: "normal",
      mainReturnPathFn: (year) => mainPath[year - 1],
      dcaReturnPathFn: (year) => dcaPath[year - 1]
    });
    conservationMaxError = Math.max(conservationMaxError, r.conservationMaxError);
    flexAppliedCount += r.points.filter((p) => p.flexApplied).length;
    endTotals.push(r.endTotal);
    minTotals.push(r.minTotal);
    if (r.depletedYear === null) {
      successes.push(r);
    } else {
      failedYears.push(r.depletedYear);
    }
  }

  const sortedEnd = [...endTotals].sort((a, b) => a - b);
  const sortedMin = [...minTotals].sort((a, b) => a - b);
  // 耗尽年直方图（10 年一档）
  const buckets = [];
  for (let start = 1; start <= years; start += 10) {
    const end = Math.min(start + 9, years);
    buckets.push({
      label: `${start}–${end}年`,
      count: failedYears.filter((y) => y >= start && y <= end).length
    });
  }

  return {
    runs, seed, mu, sigma, sigmaLog, profileKey, profile,
    years,
    successRate: successes.length / runs,
    failedCount: failedYears.length,
    failedYears,
    endTotals,
    p10End: percentile(sortedEnd, 0.1),
    p50End: percentile(sortedEnd, 0.5),
    p90End: percentile(sortedEnd, 0.9),
    p10Min: percentile(sortedMin, 0.1),
    p50Min: percentile(sortedMin, 0.5),
    buckets,
    conservationMaxError,
    flexAppliedCount
  };
}
