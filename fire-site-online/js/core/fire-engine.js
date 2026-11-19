"use strict";

export const FIRE_ENGINE_VERSION = "fire-engine.2.1.0-alpha.1";

function clampNumber(value, min, max, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.min(max, Math.max(min, numeric));
}

function normalizeExpenses(expenses) {
  if (!Array.isArray(expenses)) return [];
  return expenses.map((item) => ({
    ...item,
    amount: clampNumber(item.amount, 0, Number(item.max) || Number.MAX_SAFE_INTEGER)
  }));
}

function normalizeFireInputs(rawInput = {}) {
  return {
    scenario: rawInput.scenario === "endowment" ? "endowment" : "drawdown",
    curveSource: rawInput.curveSource === "principal" ? "principal" : "target",
    returnRate: clampNumber(rawInput.returnRate, 0, 12, 5.5),
    inflationRate: clampNumber(rawInput.inflationRate, 0, 8, 2),
    years: Math.round(clampNumber(rawInput.years, 10, 80, 50)),
    principal: clampNumber(rawInput.principal, 0, 100000000, 0),
    sideIncomeMonthly: clampNumber(rawInput.sideIncomeMonthly, 0, 1000000, 0),
    reserveReturnRate: clampNumber(rawInput.reserveReturnRate, 0, 8, 3),
    medicalReserve: clampNumber(rawInput.medicalReserve, 0, 1000000, 0),
    dcaYears: Math.round(clampNumber(rawInput.dcaYears, 1, 50, 10)),
    dcaMonthly: clampNumber(rawInput.dcaMonthly, 0, 1000000, 0),
    dcaInflationAdjust: rawInput.dcaInflationAdjust === true,
    dcaReturnRate: clampNumber(rawInput.dcaReturnRate, 0, 20, 6),
    dividendYield: clampNumber(rawInput.dividendYield, 0, 15, 4),
    dividendEnabled: rawInput.dividendEnabled === true,
    dividendMode: rawInput.dividendMode === "dividendPrincipal" ? "dividendPrincipal" : "dividendOnly",
    // 蒙特卡洛逐路径注入的年度收益率（小数）；仅影响展示用现金流，不参与反推求解。
    returnPath: Array.isArray(rawInput.returnPath) ? rawInput.returnPath.map((value) => Number(value)) : null,
    expenseFlexibility: rawInput.expenseFlexibility === true,
    flexibilityDrawdown: clampNumber(rawInput.flexibilityDrawdown, 0, 0.8, 0.2),
    flexibilityCut: clampNumber(rawInput.flexibilityCut, 0, 0.5, 0.1),
    expenses: normalizeExpenses(rawInput.expenses)
  };
}

function requiredPrincipal(annualExpense, annualReturn, inflation, years) {
  if (annualExpense <= 0 || years <= 0) return 0;
  if (Math.abs(annualReturn - inflation) < 1e-10) {
    return annualExpense * years / (1 + annualReturn);
  }
  const ratio = (1 + inflation) / (1 + annualReturn);
  return annualExpense * (1 - Math.pow(ratio, years)) / (annualReturn - inflation);
}

function simulateProjection(
  principal,
  annualExpense,
  annualReturn,
  inflation,
  years,
  annualReserveInterest = 0,
  dividendIncomeByYear = [],
  options = {}
) {
  const {
    returnPath = null,
    expenseFlexibility = false,
    flexibilityDrawdown = 0.2,
    flexibilityCut = 0.1
  } = options;
  const points = [{
    year: 0,
    yearReturn: 0,
    startBalance: principal,
    investmentReturn: 0,
    grossExpense: 0,
    reserveOffset: 0,
    dividendIncome: 0,
    dividendOffset: 0,
    expense: 0,
    withdrawal: 0,
    balance: principal,
    drawdown: 0,
    flexApplied: false
  }];
  let balance = principal;
  let depletionYear = null;
  let totalWithdrawals = 0;
  let peakBalance = principal;

  for (let year = 1; year <= years; year += 1) {
    const startBalance = balance;
    // 蒙特卡洛路径覆盖当年收益率；未注入时沿用场景固定收益率。
    const yearReturn = returnPath && Number.isFinite(Number(returnPath[year - 1]))
      ? Number(returnPath[year - 1])
      : annualReturn;
    const investmentReturn = startBalance * yearReturn;
    const available = startBalance + investmentReturn;
    let grossExpense = annualExpense * Math.pow(1 + inflation, year - 1);
    peakBalance = Math.max(peakBalance, startBalance);
    const drawdown = peakBalance > 0 ? 1 - startBalance / peakBalance : 0;
    const flexApplied = expenseFlexibility && drawdown > flexibilityDrawdown;
    if (flexApplied) grossExpense *= 1 - flexibilityCut;
    const reserveOffset = Math.min(grossExpense, Math.max(0, annualReserveInterest));
    const dividendIncome = Math.max(0, Number(dividendIncomeByYear[year]) || 0);
    const dividendOffset = Math.min(grossExpense - reserveOffset, dividendIncome);
    const expense = grossExpense - reserveOffset - dividendOffset;
    const withdrawal = Math.min(available, expense);
    balance = Math.max(0, available - expense);
    totalWithdrawals += withdrawal;
    if (expense > available + 0.01 && depletionYear === null) depletionYear = year;
    points.push({
      year,
      yearReturn,
      startBalance,
      investmentReturn,
      grossExpense,
      reserveOffset,
      dividendIncome,
      dividendOffset,
      expense,
      withdrawal,
      balance,
      drawdown,
      flexApplied
    });
  }

  return {
    points,
    depletionYear,
    totalWithdrawals,
    minBalance: Math.min(...points.map((point) => point.balance))
  };
}

// 蒙特卡洛专用入口：复用与正式现金流完全相同的记账逻辑，但允许逐路径注入收益率与支出弹性。
export function simulateCustomProjection(options = {}) {
  return simulateProjection(
    options.principal,
    options.annualExpense,
    options.annualReturn,
    options.inflation,
    options.years,
    options.annualReserveInterest || 0,
    options.dividendIncomeByYear || [],
    {
      returnPath: options.returnPath || null,
      expenseFlexibility: options.expenseFlexibility === true,
      flexibilityDrawdown: options.flexibilityDrawdown,
      flexibilityCut: options.flexibilityCut
    }
  );
}

// 与 reservePlan 完全同一口径：某投资本金对应的储备年利息 =（医疗储备 + 10% 安全垫）× 储备利率。
export function reserveInterestForPrincipal(principal, medicalReserve, cashReserve, reserveRate) {
  const safetyPad = 0.1 * (principal + medicalReserve + cashReserve);
  return (medicalReserve + safetyPad) * reserveRate;
}

// 细水长流反推：用与现金流曲线完全相同的模拟引擎，二分求「全程不破产」的最小投资本金。
// 因为期末余额随本金单调递增，收敛到不破产临界点即 = 净支出现值，保证期间不破产、期末恰好归零。
function solveSafeDrawdownPrincipal(annual, annualReturn, inflation, years, medicalReserve, cashReserve, reserveRate, dividendIncomeByYear) {
  const isBankrupt = (principal) => simulateProjection(
    principal, annual, annualReturn, inflation, years,
    reserveInterestForPrincipal(principal, medicalReserve, cashReserve, reserveRate),
    dividendIncomeByYear
  ).depletionYear !== null;

  let low = 0;
  let high = Math.max(annual * years, 1);
  let guard = 0;
  while (isBankrupt(high) && guard < 60) { high *= 1.5; guard += 1; }
  for (let i = 0; i < 70; i += 1) {
    const mid = (low + high) / 2;
    if (isBankrupt(mid)) low = mid; else high = mid;
  }
  return high;
}

// 金鹅永续反推：二分求使测算窗内本金实际购买力不减、且全程不破产的最小本金。
function solveSafeEndowmentPrincipal(annual, annualReturn, inflation, years, medicalReserve, cashReserve, reserveRate, dividendIncomeByYear) {
  if (!(annualReturn > inflation)) return null;
  const isSafe = (principal) => {
    const projection = simulateProjection(
      principal, annual, annualReturn, inflation, years,
      reserveInterestForPrincipal(principal, medicalReserve, cashReserve, reserveRate),
      dividendIncomeByYear
    );
    if (projection.depletionYear !== null) return false;
    const realEnd = projection.points[years].balance / Math.pow(1 + inflation, years);
    return realEnd >= principal - 1;
  };
  let low = 0;
  let high = annual / (annualReturn - inflation);
  let guard = 0;
  while (!isSafe(high) && guard < 60) { high *= 1.5; guard += 1; }
  for (let i = 0; i < 70; i += 1) {
    const mid = (low + high) / 2;
    if (isSafe(mid)) high = mid; else low = mid;
  }
  return high;
}

function findTurningPoint(points) {
  if (!Array.isArray(points) || points.length < 3) return null;

  for (let index = 1; index < points.length - 1; index += 1) {
    const previous = points[index - 1].balance;
    const current = points[index].balance;
    const next = points[index + 1].balance;
    if (current > previous && current > next) {
      return { year: points[index].year, balance: current, type: "peak" };
    }
  }

  for (let index = 1; index < points.length; index += 1) {
    if (points[index].balance < points[index - 1].balance - 0.01) {
      return { year: points[index].year, balance: points[index].balance, type: "decline" };
    }
  }

  return null;
}

function monthsForReservePlan(target, monthlyHomeSavings, monthlySideSavings, inflation) {
  if (target <= 0) return 0;
  if (monthlyHomeSavings <= 0 && monthlySideSavings <= 0) return null;
  let balance = 0;
  for (let month = 1; month <= 1200; month += 1) {
    const yearIndex = Math.floor((month - 1) / 12);
    const homeAmount = monthlyHomeSavings * Math.pow(1 + inflation, yearIndex);
    balance += homeAmount + monthlySideSavings;
    if (balance >= target) return month;
  }
  return null;
}

function futureValueMonthlyDca(monthlyAmount, years, annualReturnRate) {
  const months = Math.max(0, Math.round(years * 12));
  if (monthlyAmount <= 0 || months <= 0) return 0;
  const monthlyRate = Math.pow(1 + annualReturnRate, 1 / 12) - 1;
  if (Math.abs(monthlyRate) < 1e-12) return monthlyAmount * months;
  return monthlyAmount * ((Math.pow(1 + monthlyRate, months) - 1) / monthlyRate);
}

// 月定投额按年通胀逐年上调：第 y 年每月投入 monthlyAmount × (1+inflation)^y，月末投入、月复利。
function futureValueGrowingDca(monthlyAmount, years, annualReturnRate, inflation) {
  const months = Math.max(0, Math.round(years * 12));
  if (monthlyAmount <= 0 || months <= 0) return { value: 0, contributed: 0 };
  const monthlyRate = Math.pow(1 + annualReturnRate, 1 / 12) - 1;
  let balance = 0;
  let contributed = 0;
  for (let month = 1; month <= months; month += 1) {
    const yearIndex = Math.floor((month - 1) / 12);
    const payment = monthlyAmount * Math.pow(1 + inflation, yearIndex);
    balance = balance * (1 + monthlyRate) + payment;
    contributed += payment;
  }
  return { value: balance, contributed };
}

function annuityPaymentForFund(fundValue, annualReturnRate, years) {
  if (fundValue <= 0 || years <= 0) return 0;
  if (annualReturnRate <= 0) return fundValue / years;
  return fundValue * annualReturnRate / (1 - Math.pow(1 + annualReturnRate, -years));
}

function buildDividendPlan(input, dcaPlan, annualExpense, inflation, annualReturn, years) {
  const enabled = input.dividendEnabled && input.dcaMonthly > 0 && dcaPlan.fundValue > 0;
  const startYear = enabled ? Math.min(input.dcaYears, years) : null;
  const remainingYears = startYear === null ? 0 : years - startYear + 1;
  const annualDividend = dcaPlan.fundValue * input.dividendYield / 100;
  const annualPayment = enabled && input.dividendMode === "dividendPrincipal"
    ? annuityPaymentForFund(dcaPlan.fundValue, input.dcaReturnRate / 100, remainingYears)
    : 0;
  const annualIncome = !enabled
    ? 0
    : input.dividendMode === "dividendPrincipal" ? annualPayment : annualDividend;
  // 领取起点在第 startYear 年的名义金额，按通胀折算回 FIRE 起点（第 0 年）的购买力。
  const purchasingPowerFactor = enabled && startYear > 0
    ? 1 / Math.pow(1 + inflation, startYear)
    : 1;
  const annualIncomeReal = annualIncome * purchasingPowerFactor;
  const monthlyIncome = annualIncome / 12;
  const monthlyIncomeReal = annualIncomeReal / 12;

  const dividendIncomeByYear = new Array(years + 1).fill(0);
  const dividendOffsetByYear = new Array(years + 1).fill(0);
  if (enabled && startYear !== null) {
    for (let year = startYear; year <= years; year += 1) {
      const grossExpense = annualExpense * Math.pow(1 + inflation, year - 1);
      dividendIncomeByYear[year] = annualIncome;
      dividendOffsetByYear[year] = Math.min(grossExpense, annualIncome);
    }
  }

  return {
    enabled,
    mode: input.dividendMode,
    startYear,
    remainingYears,
    fundValueAtStart: dcaPlan.fundValue,
    annualDividend,
    annualPayment,
    annualIncome,
    annualIncomeReal,
    monthlyIncome,
    monthlyIncomeReal,
    purchasingPowerFactor,
    dividendIncomeByYear,
    dividendOffsetByYear,
    totalDividendOffset: dividendOffsetByYear.reduce((sum, value) => sum + value, 0)
  };
}

function buildDcaPlan(input, monthlyExpense, inflation) {
  const dcaMonths = Math.max(0, Math.round(input.dcaYears * 12));
  const dcaReturnRate = input.dcaReturnRate / 100;
  const dividendYieldRate = input.dividendYield / 100;
  const dcaMonthly = input.dcaMonthly;
  const adjust = input.dcaInflationAdjust;
  const project = (rate) => adjust
    ? futureValueGrowingDca(dcaMonthly, input.dcaYears, rate, inflation)
    : { value: futureValueMonthlyDca(dcaMonthly, input.dcaYears, rate), contributed: dcaMonthly * dcaMonths };

  const base = project(dcaReturnRate);
  const fundValue = base.value;
  const dcaTotalContributed = base.contributed;
  const finalMonthly = adjust && dcaMonths > 0
    ? dcaMonthly * Math.pow(1 + inflation, Math.floor((dcaMonths - 1) / 12))
    : dcaMonthly;
  const fundAnnualDividend = fundValue * dividendYieldRate;
  const fundMonthlyDividend = fundAnnualDividend / 12;
  const scenarios = [
    { label: "低收益（−2%）", rate: Math.max(0, input.dcaReturnRate - 2) },
    { label: "当前设置", rate: input.dcaReturnRate },
    { label: "高收益（+2%）", rate: Math.min(20, input.dcaReturnRate + 2) }
  ].map((scenario) => {
    const value = project(scenario.rate / 100).value;
    return {
      label: scenario.label,
      rate: scenario.rate,
      value,
      annualDividend: value * dividendYieldRate,
      monthlyDividend: value * dividendYieldRate / 12
    };
  });

  return {
    dcaMonths,
    dcaMonthly,
    dcaInflationAdjust: adjust,
    dcaFinalMonthly: finalMonthly,
    dcaTotalContributed,
    fundValue,
    fundAnnualDividend,
    fundMonthlyDividend,
    fundScenarios: scenarios,
    fundCoverage: monthlyExpense > 0 ? fundMonthlyDividend / monthlyExpense : null
  };
}

export function calculateFirePlan(rawInput = {}) {
  const input = normalizeFireInputs(rawInput);
  const monthly = input.expenses.reduce((sum, item) => sum + item.amount, 0);
  const annual = monthly * 12;
  const annualReturn = input.returnRate / 100;
  const inflation = input.inflationRate / 100;
  const realReturn = (1 + annualReturn) / (1 + inflation) - 1;
  const medicalReserve = input.medicalReserve;
  const cashReserve = monthly * 36;
  const reserveRate = input.reserveReturnRate / 100;

  const dcaPlan = buildDcaPlan(input, monthly, inflation);
  const dividendPlan = buildDividendPlan(input, dcaPlan, annual, inflation, annualReturn, input.years);

  const perpetualReverse = annualReturn > inflation ? annual / (annualReturn - inflation) : null;
  // 反推本金：用与现金流曲线完全相同的模拟引擎求解，保证全程不破产 / 永续购买力不减。
  // 模拟内部按 min(毛支出 - 储备利息, 红利收入) 逐年计算抵扣，这里只需传入逐年红利收入。
  const dividendIncomeForReverse = dividendPlan.enabled
    ? dividendPlan.dividendIncomeByYear
    : new Array(input.years + 1).fill(0);
  const solvePrincipal = (incomeTable) => input.scenario === "endowment"
    ? solveSafeEndowmentPrincipal(annual, annualReturn, inflation, input.years, medicalReserve, cashReserve, reserveRate, incomeTable)
    : solveSafeDrawdownPrincipal(annual, annualReturn, inflation, input.years, medicalReserve, cashReserve, reserveRate, incomeTable);
  const reverse = solvePrincipal(dividendIncomeForReverse);
  const reverseWithoutDividend = solvePrincipal(new Array(input.years + 1).fill(0));
  const dividendReverseSaving = reverseWithoutDividend !== null && reverse !== null
    ? Math.max(0, reverseWithoutDividend - reverse)
    : null;

  const reverseBase = reverse === null ? null : reverse + medicalReserve + cashReserve;
  const reverseFull = reverseBase === null ? null : reverseBase * 1.1;
  const conservativeBase = annual * 40 + medicalReserve + cashReserve;
  const conservative = conservativeBase * 1.1;

  // 全盘测算口径：反推目标 / 我的本金。现金流曲线、储备计划、蒙特卡洛与杠杆分析
  // 统一以 activePrincipal 为起点；反推值与保守目标是独立对照基准，不随口径改变。
  const activePrincipal = input.curveSource === "target" && reverse !== null ? reverse : input.principal;
  const activeFullTarget = (activePrincipal + medicalReserve + cashReserve) * 1.1;

  let reservePlan = null;
  let annualReserveInterest = 0;
  if (reverse !== null && reverseFull !== null) {
    const reserveTarget = activeFullTarget - activePrincipal;
    const reserveSafetyPad = reserveTarget - medicalReserve - cashReserve;
    const interestBase = medicalReserve + reserveSafetyPad;
    annualReserveInterest = interestBase * reserveRate;
    const homeMonthlySavings = monthly;
    const homeMonths = monthsForReservePlan(reserveTarget, homeMonthlySavings, 0, inflation);
    const sideMonths = monthsForReservePlan(reserveTarget, 0, input.sideIncomeMonthly, inflation);
    const combinedMonths = monthsForReservePlan(reserveTarget, homeMonthlySavings, input.sideIncomeMonthly, inflation);
    reservePlan = {
      target: reserveTarget,
      medicalReserve,
      cashReserve,
      safetyPad: reserveSafetyPad,
      reserveReturnRate: reserveRate,
      interestBase,
      annualReserveInterest,
      homeMonths,
      sideMonths,
      combinedMonths,
      sideIncomeMonthly: input.sideIncomeMonthly,
      homeMonthlySavings,
      combinedMonthlySavings: homeMonthlySavings + input.sideIncomeMonthly,
      homeAnnualSavings: annual
    };
  }

  const chartStart = activePrincipal;
  const projection = simulateProjection(
    chartStart, annual, annualReturn, inflation, input.years,
    annualReserveInterest, dividendPlan.dividendIncomeByYear,
    {
      returnPath: input.returnPath,
      expenseFlexibility: input.expenseFlexibility,
      flexibilityDrawdown: input.flexibilityDrawdown,
      flexibilityCut: input.flexibilityCut
    }
  );
  projection.turningPoint = findTurningPoint(projection.points);
  const finalPoint = projection.points[input.years];
  const realEndBalance = finalPoint.balance / Math.pow(1 + inflation, input.years);

  return {
    engineVersion: FIRE_ENGINE_VERSION,
    assumptions: input,
    monthly,
    annual,
    annualReturn,
    inflation,
    realReturn,
    medicalReserve,
    cashReserve,
    reserveRate,
    perpetualReverse,
    reverse,
    reverseBase,
    reverseFull,
    conservativeBase,
    conservative,
    projection,
    chartStart,
    activePrincipal,
    activeFullTarget,
    activeReserveInterest: annualReserveInterest,
    realEndBalance,
    safetyDifference: reverseFull === null ? null : conservative - reverseFull,
    reservePlan,
    dividendPlan,
    dividendReverseSaving,
    ...dcaPlan,
    principalGap: reverse === null ? null : input.principal - reverse,
    principalMultiple: reverse === null || input.principal <= 0 ? null : reverse / input.principal,
    fullTargetMultiple: reverseFull === null || input.principal <= 0 ? null : reverseFull / input.principal,
    audit: {
      engineVersion: FIRE_ENGINE_VERSION,
      formulas: {
        requiredCapital: "反推本金用与现金流曲线相同的模拟引擎二分求解：细水长流取全程不破产的最小本金（收敛点即净支出现值，期末恰好归零）；金鹅永续取测算窗内购买力不减的最小本金。储备利息与红利抵扣按模拟口径逐年计入。",
        reserveInterest: "FIRE 后利息 =（医疗储备 + 10% 安全垫）× 储备利率；积累阶段不计息。",
        calculationBasis: "全盘测算口径：反推目标口径用反推本金起算，我的本金口径用手动输入的预期本金起算；现金流曲线、储备利息、蒙特卡洛与杠杆分析全部沿用该起点，反推值与保守目标始终作为独立对照。",
        reserveAccumulation: "住家储蓄按年通胀递增，副业收入保持不变；积累阶段不计息。",
        dcaDividend: "月末定投按月复利；启用后从定投年限对应的 FIRE 年份开始领取。仅股息不卖本金；股息+本金按定投收益率年金化，到测算期末归零。开启定投通胀调整后，第 y 年月投额 = 基准月投额 ×(1+通胀率)^y。",
        dividendPurchasingPower: "领取金额为领取起点当年名义金额；购买力折算 = 名义金额 ÷ (1 + 通胀率)^领取起点年，即换算回 FIRE 开始时的购买力。"
      }
    }
  };
}
