"use strict";

export const FIRE_ENGINE_VERSION = "fire-engine.2.0.0-alpha.1";

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
    returnRate: clampNumber(rawInput.returnRate, 0, 12, 4.5),
    inflationRate: clampNumber(rawInput.inflationRate, 0, 8, 2),
    years: Math.round(clampNumber(rawInput.years, 10, 80, 50)),
    principal: clampNumber(rawInput.principal, 0, 100000000, 0),
    sideIncomeMonthly: clampNumber(rawInput.sideIncomeMonthly, 0, 1000000, 0),
    reserveReturnRate: clampNumber(rawInput.reserveReturnRate, 0, 8, 2.25),
    medicalReserve: clampNumber(rawInput.medicalReserve, 0, 1000000, 0),
    dcaYears: Math.round(clampNumber(rawInput.dcaYears, 1, 50, 10)),
    dcaMonthly: clampNumber(rawInput.dcaMonthly, 0, 1000000, 0),
    dcaReturnRate: clampNumber(rawInput.dcaReturnRate, 0, 20, 6),
    dividendYield: clampNumber(rawInput.dividendYield, 0, 15, 4),
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

function reserveInterestFactor(years, annualReturn) {
  if (years <= 0) return 0;
  let factor = 0;
  for (let year = 1; year <= years; year += 1) {
    factor += 1 / Math.pow(1 + annualReturn, year);
  }
  return factor;
}

function requiredPrincipalWithReserveInterest(
  annualExpense,
  annualReturn,
  inflation,
  years,
  medicalReserve,
  cashReserve,
  reserveReturnRate
) {
  const grossPrincipal = requiredPrincipal(annualExpense, annualReturn, inflation, years);
  const factor = reserveInterestFactor(years, annualReturn);
  const numerator = grossPrincipal - factor * reserveReturnRate * (1.1 * medicalReserve + 0.1 * cashReserve);
  const denominator = 1 + 0.1 * factor * reserveReturnRate;
  return Math.max(0, numerator / denominator);
}

function perpetualPrincipalWithReserveInterest(
  annualExpense,
  annualReturn,
  inflation,
  medicalReserve,
  cashReserve,
  reserveReturnRate
) {
  if (!(annualReturn > inflation)) return null;
  const grossPrincipal = annualExpense / (annualReturn - inflation);
  const factor = 1 / annualReturn;
  const numerator = grossPrincipal - factor * reserveReturnRate * (1.1 * medicalReserve + 0.1 * cashReserve);
  const denominator = 1 + 0.1 * factor * reserveReturnRate;
  return Math.max(0, numerator / denominator);
}

function simulateProjection(
  principal,
  annualExpense,
  annualReturn,
  inflation,
  years,
  annualReserveInterest = 0
) {
  const points = [{
    year: 0,
    startBalance: principal,
    investmentReturn: 0,
    grossExpense: 0,
    reserveOffset: 0,
    expense: 0,
    withdrawal: 0,
    balance: principal
  }];
  let balance = principal;
  let depletionYear = null;
  let totalWithdrawals = 0;

  for (let year = 1; year <= years; year += 1) {
    const startBalance = balance;
    const investmentReturn = startBalance * annualReturn;
    const available = startBalance + investmentReturn;
    const grossExpense = annualExpense * Math.pow(1 + inflation, year - 1);
    const reserveOffset = Math.min(grossExpense, Math.max(0, annualReserveInterest));
    const expense = grossExpense - reserveOffset;
    const withdrawal = Math.min(available, expense);
    balance = Math.max(0, available - expense);
    totalWithdrawals += withdrawal;
    if (expense > available + 0.01 && depletionYear === null) depletionYear = year;
    points.push({
      year,
      startBalance,
      investmentReturn,
      grossExpense,
      reserveOffset,
      expense,
      withdrawal,
      balance
    });
  }

  return { points, depletionYear, totalWithdrawals };
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

function buildDcaPlan(input, monthlyExpense) {
  const dcaMonths = Math.max(0, Math.round(input.dcaYears * 12));
  const dcaReturnRate = input.dcaReturnRate / 100;
  const dividendYieldRate = input.dividendYield / 100;
  const dcaMonthly = input.dcaMonthly;
  const dcaTotalContributed = dcaMonthly * dcaMonths;
  const fundValue = futureValueMonthlyDca(dcaMonthly, input.dcaYears, dcaReturnRate);
  const fundAnnualDividend = fundValue * dividendYieldRate;
  const fundMonthlyDividend = fundAnnualDividend / 12;
  const scenarios = [
    { label: "低收益（−2%）", rate: Math.max(0, input.dcaReturnRate - 2) },
    { label: "当前设置", rate: input.dcaReturnRate },
    { label: "高收益（+2%）", rate: Math.min(20, input.dcaReturnRate + 2) }
  ].map((scenario) => {
    const value = futureValueMonthlyDca(dcaMonthly, input.dcaYears, scenario.rate / 100);
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

  const perpetualReverse = annualReturn > inflation ? annual / (annualReturn - inflation) : null;
  const reverse = input.scenario === "endowment"
    ? perpetualPrincipalWithReserveInterest(annual, annualReturn, inflation, medicalReserve, cashReserve, reserveRate)
    : requiredPrincipalWithReserveInterest(annual, annualReturn, inflation, input.years, medicalReserve, cashReserve, reserveRate);

  const reverseBase = reverse === null ? null : reverse + medicalReserve + cashReserve;
  const reverseFull = reverseBase === null ? null : reverseBase * 1.1;
  const conservativeBase = annual * 40 + medicalReserve + cashReserve;
  const conservative = conservativeBase * 1.1;

  let reservePlan = null;
  let annualReserveInterest = 0;
  if (reverse !== null && reverseFull !== null) {
    const reserveTarget = reverseFull - reverse;
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

  const chartStart = input.curveSource === "target" && reverse !== null ? reverse : input.principal;
  const projection = simulateProjection(chartStart, annual, annualReturn, inflation, input.years, annualReserveInterest);
  const finalPoint = projection.points[input.years];
  const realEndBalance = finalPoint.balance / Math.pow(1 + inflation, input.years);
  const dcaPlan = buildDcaPlan(input, monthly);

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
    realEndBalance,
    safetyDifference: reverseFull === null ? null : conservative - reverseFull,
    reservePlan,
    ...dcaPlan,
    principalGap: reverse === null ? null : input.principal - reverse,
    principalMultiple: reverse === null || input.principal <= 0 ? null : reverse / input.principal,
    fullTargetMultiple: reverseFull === null || input.principal <= 0 ? null : reverseFull / input.principal,
    audit: {
      engineVersion: FIRE_ENGINE_VERSION,
      formulas: {
        requiredCapital: "未来净支出现值；FIRE 后储备利息按现值抵扣投资本金需求。",
        reserveInterest: "FIRE 后利息 =（医疗储备 + 10% 安全垫）× 储备利率；积累阶段不计息。",
        reserveAccumulation: "住家储蓄按年通胀递增，副业收入保持不变；积累阶段不计息。",
        dcaDividend: "月末定投按月复利；退休期只提取股息，不卖出本金。"
      }
    }
  };
}
