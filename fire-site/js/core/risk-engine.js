"use strict";

export const RISK_ENGINE_VERSION = "risk-engine.v0.1.0";

const SEVERITY_ORDER = {
  blocking: 5,
  critical: 4,
  warning: 3,
  notice: 2,
  info: 1
};

function evidence(label, value, unit = "", sourceId = "fire-engine") {
  return { label, value, unit, sourceId };
}

function makeResult(rule, fireResult, triggered, extraEvidence = [], messageOverride = null) {
  return {
    ruleId: rule.id,
    ruleVersion: rule.version,
    severity: triggered ? rule.severity : "info",
    triggered,
    title: rule.title,
    message: triggered ? (messageOverride || rule.message) : rule.passMessage,
    recommendation: triggered ? rule.recommendation : null,
    evidence: [...rule.evidence(fireResult), ...extraEvidence]
  };
}

function medicalReserveMonths(fireResult) {
  const monthly = fireResult.monthly;
  if (monthly <= 0) return null;
  return fireResult.medicalReserve / monthly;
}

function reserveInterestRatio(fireResult) {
  const annual = fireResult.annual;
  if (!fireResult.reservePlan || annual <= 0) return null;
  return fireResult.reservePlan.annualReserveInterest / annual;
}

const RULES = [
  {
    id: "principal.below.required",
    version: "v0.1.0",
    severity: "critical",
    title: "预期本金低于反推投资本金",
    message: "当前输入的预期本金还不足以覆盖所选期限内的净支出。",
    passMessage: "当前预期本金高于反推投资本金。",
    recommendation: "提高初始本金，或延长积累期、降低支出假设。",
    evidence: (result) => [
      evidence("预期本金", result.assumptions.principal, "CNY"),
      evidence("反推投资本金", result.reverse, "CNY")
    ],
    evaluate: (result) => result.reverse !== null && result.principalGap < 0
  },
  {
    id: "medical.reserve.months.low",
    version: "v0.1.0",
    severity: "warning",
    title: "医疗储备覆盖月数偏低",
    message: "医疗专项储备能够覆盖的月支出偏少。",
    passMessage: "医疗专项储备覆盖月数处于合理区间。",
    recommendation: "提高医疗专项储备，避免突发医疗支出时被迫卖出长期投资。",
    evidence: (result) => [
      evidence("医疗储备覆盖月数", medicalReserveMonths(result), "个月"),
      evidence("月支出", result.monthly, "CNY"),
      evidence("医疗专项储备", result.medicalReserve, "CNY")
    ],
    evaluate: (result) => {
      const months = medicalReserveMonths(result);
      return months !== null && months < 6;
    }
  },
  {
    id: "return.rate.high",
    version: "v0.1.0",
    severity: "warning",
    title: "年化收益率假设偏高",
    message: "长期年化收益率假设较高，可能低估收益波动和坏序列风险。",
    passMessage: "年化收益率假设处于可讨论区间。",
    recommendation: "使用更保守的收益率假设，或增加敏感性分析。",
    evidence: (result) => [
      evidence("年化收益率", result.assumptions.returnRate, "%"),
      evidence("实际收益率", result.realReturn * 100, "%")
    ],
    evaluate: (result) => result.assumptions.returnRate > 10
  },
  {
    id: "forecast.years.short",
    version: "v0.1.0",
    severity: "notice",
    title: "现金流测算年限较短",
    message: "测算年限较短，可能低估长寿风险。",
    passMessage: "现金流测算年限较充分。",
    recommendation: "如果 FIRE 时较年轻，建议把测算年限提高到 50 年以上。",
    evidence: (result) => [evidence("测算年限", result.assumptions.years, "年")],
    evaluate: (result) => result.assumptions.years < 30
  },
  {
    id: "reserve.interest.dependency",
    version: "v0.1.0",
    severity: "notice",
    title: "FIRE 后储备利息依赖度偏高",
    message: "储备利息占年度支出比例较高，利率变化或储备动用会影响现金流。",
    passMessage: "FIRE 后储备利息依赖度可控。",
    recommendation: "确认储备账户利率的稳定性，并避免把安全垫当作长期收益资产。",
    evidence: (result) => [
      evidence("FIRE 后年利息", result.reservePlan ? result.reservePlan.annualReserveInterest : 0, "CNY"),
      evidence("年度毛支出", result.annual, "CNY"),
      evidence("利息占比", reserveInterestRatio(result) === null ? null : reserveInterestRatio(result) * 100, "%")
    ],
    evaluate: (result) => {
      const ratio = reserveInterestRatio(result);
      return ratio !== null && ratio > 0.25;
    }
  },
  {
    id: "dividend.coverage.high",
    version: "v0.1.0",
    severity: "notice",
    title: "红利低波股息依赖度偏高",
    message: "红利低波基金股息对月支出的覆盖比例较高，分红波动会影响退休现金流。",
    passMessage: "红利低波股息覆盖比例可控。",
    recommendation: "把股息视为增强现金流，而不是唯一退休收入来源。",
    evidence: (result) => [
      evidence("每月股息", result.fundMonthlyDividend, "CNY"),
      evidence("月支出", result.monthly, "CNY"),
      evidence("股息覆盖率", result.fundCoverage === null ? null : result.fundCoverage * 100, "%")
    ],
    evaluate: (result) => result.fundCoverage !== null && result.fundCoverage > 0.5
  },
  {
    id: "dca.return.rate.high",
    version: "v0.1.0",
    severity: "notice",
    title: "红利低波定投收益率假设偏高",
    message: "定投年化收益率假设偏高，期末市值和股息可能过于乐观。",
    passMessage: "红利低波定投收益率假设处于可讨论区间。",
    recommendation: "同时检查低收益情景，避免只用当前设置做决策。",
    evidence: (result) => [
      evidence("定投年化收益率", result.assumptions.dcaReturnRate, "%"),
      evidence("低收益情景", result.fundScenarios[0]?.rate ?? 0, "%")
    ],
    evaluate: (result) => result.assumptions.dcaReturnRate > 12
  }
];

export function evaluateRiskRules({ fireResult, evaluatedAt = null } = {}) {
  if (!fireResult) {
    throw new Error("evaluateRiskRules 需要 fireResult 输入");
  }

  const results = RULES.map((rule) => {
    const triggered = Boolean(rule.evaluate(fireResult));
    return makeResult(rule, fireResult, triggered);
  });

  results.sort((a, b) => {
    if (a.triggered !== b.triggered) return a.triggered ? -1 : 1;
    return SEVERITY_ORDER[b.severity] - SEVERITY_ORDER[a.severity];
  });

  return {
    riskEngineVersion: RISK_ENGINE_VERSION,
    fireEngineVersion: fireResult.engineVersion,
    evaluatedAt,
    totalRules: results.length,
    triggeredCount: results.filter((item) => item.triggered).length,
    results
  };
}
