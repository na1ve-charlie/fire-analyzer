"use strict";

import { calculateFirePlan } from "./js/core/fire-engine.js?v=20261123a";
import { evaluateRiskRules } from "./js/core/risk-engine.js?v=20261123a";
import { createSnapshotPayload, parseSnapshotPayload } from "./js/core/snapshot.js?v=20261123a";
import { normalizeManualSnapshot } from "./js/core/data/manual-snapshot.js?v=20261123a";
import { runMonteCarlo, analyzeSuccessLevers, MC_ENGINE_VERSION, MC_PROFILE_GROUPS } from "./js/core/monte-carlo.js?v=20261123a";
import { runStressScenario, runStressComparison, STRESS_ENGINE_VERSION, STRESS_SCENARIOS } from "./js/core/stress-test.js?v=20261123a";

const DEFAULT_EXPENSES = [
  { id: "property", name: "物业费", icon: "物", amount: 300, max: 2000, color: "#8a6a26", bg: "#f3e9d1" },
  { id: "maintenance", name: "房屋维护", icon: "维", amount: 250, max: 2000, color: "#76623a", bg: "#f1ead9" },
  { id: "utilities", name: "水电燃气", icon: "水", amount: 300, max: 2000, color: "#6f6a3a", bg: "#f0ecda" },
  { id: "food", name: "饮食", icon: "食", amount: 1500, max: 5000, color: "#9a5f35", bg: "#f4e7d6" },
  { id: "medical", name: "稳健医疗", icon: "医", amount: 400, max: 3000, color: "#8c5839", bg: "#f3e5d8" },
  { id: "daily", name: "日常开销", icon: "用", amount: 350, max: 3000, color: "#70603d", bg: "#f2ead8" },
  { id: "appliance", name: "家电折旧", icon: "电", amount: 125, max: 2000, color: "#866a2d", bg: "#f2e9d3" }
];

const DEFAULT_STATE = {
  scenario: "drawdown",
  curveSource: "target",
  returnRate: 5.5,
  inflationRate: 2,
  years: 50,
  principal: 1050000,
  sideIncomeMonthly: 1200,
  reserveReturnRate: 3,
  medicalReserve: 150000,
  dcaYears: 10,
  dcaMonthly: 1200,
  dcaInflationAdjust: false,
  dcaReturnRate: 6,
  dividendYield: 4,
  dividendEnabled: false,
  dividendMode: "dividendOnly",
  mcProfile: "portfolioA",
  mcRuns: 5000,
  mcFlexibility: false,
  mcTargetRate: 0.9,
  stressScenario: "gfc2008",
  stressGuytonKlinger: false,
  stressDepth: 30,
  stressLength: 2,
  stressInflation: 3
};

const MC_RUNS_MIN = 500;
const MC_RUNS_MAX = 20000;
const MC_RUNS_PRESETS = [2000, 5000, 10000];
// 页面自定义组合的存储键与内置组合持仓说明（须在 state 初始化前声明，loadCustomProfiles 顶层即被调用）。
const CUSTOM_PROFILES_STORAGE_KEY = "fire-mc-custom-profiles";
const BUILTIN_HOLDINGS_NOTE = "组合一为 2007-01-04～2026-11-09 长样本回测；组合二三列指数版（5–7 年基线 / 10 年 / 30 年）同为 2011-01-04～2026-11-09 样本；组合二两列 ETF 版（10 年 / 30 年）受 ETF 上市日限制同为 2023-06-13～2026-11-09 短样本。指数版与 ETF 版样本不同，胜率不可直接横比；所有版本均以人民币计价、月末再平衡，ETF 使用单位净值并计入分红再投资；微盘序列全收益口径依据第三方页面标注，待 Wind 原始数据核验。回测不代表未来，非市场预测或投资建议。";

const state = {
  expenses: cloneExpenses(),
  ...DEFAULT_STATE,
  mcCustomProfiles: []
};
state.mcCustomProfiles = loadCustomProfiles();

let latestResult = null;
let latestRisk = null;
let latestSnapshot = null;
let latestMc = null;
let latestStress = null;
let toastTimer = null;
let resizeFrame = null;
let mcTimer = null;
let mcSequence = 0;
let mcInitialized = false;
let leverInitialized = false;
let leverBusy = false;
let leverParamsTimer = null;
let stressInitialized = false;
let stressTimer = null;
let stressSequence = 0;
// 胜率工具箱勾选组合：params 为各项可编辑参数（默认值仅作预填），checked 为勾选状态。
const leverSelection = {
  params: { expenseCutPct: 10, extraMonthlyIncome: 2000, delayYears: 3, extraPrincipal: 0, bridgeMonthly: 2000, bridgeYears: 5 },
  checked: { expenseCut: false, extraIncome: false, delay: false, extraPrincipal: false, dividendIncome: false, flexibility: false, bridge: false, flexibilityStrong: false }
};
const $ = (id) => document.getElementById(id);
const moneyFormatter = new Intl.NumberFormat("zh-CN", { maximumFractionDigits: 0 });

function cloneExpenses() {
  return DEFAULT_EXPENSES.map((item) => ({ ...item }));
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function formatMoney(value) {
  const safeValue = Number.isFinite(value) ? value : 0;
  return `¥${moneyFormatter.format(Math.round(safeValue))}`;
}

function formatOptionalMoney(value) {
  return value === null || !Number.isFinite(value) ? "—" : formatMoney(value);
}

// 名义金额 + 折算回 FIRE 起点购买力，购买力部分用小号字展示：¥3000/¥1500
function setMoneyWithRealPurchasingPower(id, nominal, real) {
  const element = $(id);
  if (!element) return;
  const hasReal = Number.isFinite(real) && Number.isFinite(nominal) && real < nominal - 0.5;
  const html = hasReal
    ? `${formatMoney(nominal)}<span class="real-money">/${formatMoney(real)}</span>`
    : formatMoney(nominal);
  if (element.innerHTML === html) return;
  element.innerHTML = html;
  if (!window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    element.classList.remove("value-updated");
    void element.offsetWidth;
    element.classList.add("value-updated");
  }
}

function formatCompactMoney(value) {
  const absolute = Math.abs(value);
  if (absolute >= 100000000) return `¥${(value / 100000000).toFixed(2)}亿`;
  if (absolute >= 10000) return `¥${(value / 10000).toFixed(1)}万`;
  return formatMoney(value);
}

function formatAxis(value) {
  if (value >= 100000000) return `${Number((value / 100000000).toFixed(1))}亿`;
  if (value >= 10000) return `${Number((value / 10000).toFixed(1))}万`;
  return moneyFormatter.format(value);
}

function formatDelay(months) {
  if (!Number.isFinite(months) || months < 0) return "—";
  const roundedMonths = Math.ceil(months);
  const years = Math.floor(roundedMonths / 12);
  const remainingMonths = roundedMonths % 12;
  if (years === 0) return `${remainingMonths} 个月`;
  if (remainingMonths === 0) return `${years} 年`;
  return `${years} 年 ${remainingMonths} 个月`;
}

function formatPercent(value) {
  return `${Number(value.toFixed(2))}%`;
}

function setText(id, value, animate = true) {
  const element = $(id);
  if (!element || element.textContent === value) return;
  element.textContent = value;
  if (animate && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    element.classList.remove("value-updated");
    void element.offsetWidth;
    element.classList.add("value-updated");
  }
}

function updateRangeFill(range) {
  const min = Number(range.min);
  const max = Number(range.max);
  const value = Number(range.value);
  const percent = max === min ? 0 : ((value - min) / (max - min)) * 100;
  range.style.setProperty("--range-progress", `${clamp(percent, 0, 100)}%`);
}

function buildExpenseControls() {
  const list = $("expenseList");
  list.innerHTML = state.expenses.map((item, index) => `
    <div class="expense-item" data-expense="${item.id}">
      <div class="expense-top">
        <span class="category-icon" style="--category-color:${item.color};--category-bg:${item.bg}">${item.icon}</span>
        <span class="category-name" title="${item.name}">${item.name}</span>
        <label class="expense-number" for="expense-input-${index}"><span>¥</span><input id="expense-input-${index}" data-index="${index}" type="number" min="0" max="${item.max}" step="25" value="${item.amount}" aria-label="${item.name}每月金额"></label>
      </div>
      <input class="range expense-range" id="expense-range-${index}" data-index="${index}" type="range" min="0" max="${item.max}" step="25" value="${item.amount}" aria-label="拖动调整${item.name}">
    </div>
  `).join("");

  list.querySelectorAll(".expense-range").forEach((range) => {
    updateRangeFill(range);
    range.addEventListener("input", () => {
      const index = Number(range.dataset.index);
      const value = Number(range.value);
      state.expenses[index].amount = value;
      $(`expense-input-${index}`).value = value;
      updateRangeFill(range);
      updateAll();
    });
  });

  list.querySelectorAll(".expense-number input").forEach((input) => {
    input.addEventListener("input", () => {
      if (input.value === "") return;
      const index = Number(input.dataset.index);
      const item = state.expenses[index];
      const value = clamp(Number(input.value) || 0, 0, item.max);
      item.amount = value;
      const range = $(`expense-range-${index}`);
      range.value = value;
      updateRangeFill(range);
      updateAll();
    });
    input.addEventListener("change", () => {
      const index = Number(input.dataset.index);
      const item = state.expenses[index];
      item.amount = clamp(Number(input.value) || 0, 0, item.max);
      input.value = item.amount;
      $(`expense-range-${index}`).value = item.amount;
      updateRangeFill($(`expense-range-${index}`));
      updateAll();
    });
  });
}

function bindPair(rangeId, inputId, stateKey, onUpdate = updateAll) {
  const range = $(rangeId);
  const input = $(inputId);
  updateRangeFill(range);

  range.addEventListener("input", () => {
    const value = Number(range.value);
    state[stateKey] = value;
    input.value = value;
    updateRangeFill(range);
    onUpdate();
  });

  input.addEventListener("input", () => {
    if (input.value === "") return;
    const min = Number(input.min);
    const max = Number(input.max);
    const value = clamp(Number(input.value) || 0, min, max);
    state[stateKey] = value;
    range.value = Math.min(Number(range.max), value);
    updateRangeFill(range);
    onUpdate();
  });

  input.addEventListener("change", () => {
    const value = clamp(Number(input.value) || 0, Number(input.min), Number(input.max));
    state[stateKey] = value;
    input.value = value;
    range.value = Math.min(Number(range.max), value);
    updateRangeFill(range);
    onUpdate();
  });
}

function calculate() {
  return calculateFirePlan(state);
}

function updateAll() {
  const result = calculate();
  latestResult = result;
  latestRisk = evaluateRiskRules({ fireResult: result });
  renderRisk(latestRisk);
  setText("snapshotEngineVersion", `${result.engineVersion} · ${latestRisk.riskEngineVersion}`, false);
  const { projection } = result;
  const finalPoint = projection.points[state.years];
  const gap = result.principalGap;
  const isTargetCurve = state.curveSource === "target" && result.reverse !== null;
  const postFireInterest = result.reservePlan ? result.reservePlan.annualReserveInterest : null;
  const dividendPlan = result.dividendPlan;
  const dividendActive = Boolean(dividendPlan?.enabled && dividendPlan.startYear !== null);

  setText("monthlyExpense", formatMoney(result.monthly));
  setText("expensePanelTotal", formatMoney(result.monthly));
  setText("annualExpense", formatMoney(result.annual));
  setText("categoryCount", String(state.expenses.length), false);
  setText("reverseTarget", formatOptionalMoney(result.reverse));
  const reverseDescription = $("reverseTargetDescription");
  if (state.scenario === "endowment") {
    reverseDescription.innerHTML = result.reverse === null ? "收益未跑赢通胀，暂无法永续" : "只取收益，本金购买力保持不减";
  } else {
    reverseDescription.innerHTML = `覆盖 <span id="reverseYears">${state.years}</span> 年支出，期末余额约为 0`;
  }
  setText("reverseRatioDescription", result.principalMultiple === null
    ? "初始目标 × —"
    : `投资本金 ×${result.principalMultiple.toFixed(2)} · 完整目标 ×${result.fullTargetMultiple.toFixed(2)}`, false);
  setText("modelTargetRatio", result.fullTargetMultiple === null
    ? "收益未能覆盖通胀"
    : `初始目标 ×${result.fullTargetMultiple.toFixed(2)}`, false);
  setText("conservativeTarget", formatMoney(result.conservative));
  setText("heroFormulaTotal", formatMoney(result.conservative));
  if (gap === null) {
    setText("principalGap", "—", false);
    $("principalGap").classList.remove("positive", "negative");
    setText("principalGapNote", "收益未跑赢通胀", false);
  } else {
    setText("principalGap", `${gap >= 0 ? "+" : "−"}${formatMoney(Math.abs(gap))}`);
    $("principalGap").classList.toggle("positive", gap >= 0);
    $("principalGap").classList.toggle("negative", gap < 0);
    setText("principalGapNote", gap >= 0 ? "高于现金流反推投资本金" : "距离现金流反推投资本金", false);
  }
  setText("realReturn", `${(result.realReturn * 100).toFixed(2)}%`);

  setText("endBalanceLabel", `第 ${state.years} 年末预计资产`, false);
  setText("endBalance", formatMoney(finalPoint.balance));
  setText("lastYearExpense", formatMoney(finalPoint.expense));
  setText("totalWithdrawals", formatMoney(projection.totalWithdrawals));
  setText("chartSubtitle", state.scenario === "endowment"
    ? (isTargetCurve ? "反推目标口径：仅提取收益，本金随通胀保值" : "我的本金口径：购买力是否能够保持")
    : (isTargetCurve ? "反推目标口径：本金随支出逐步消耗，期末归零" : "我的本金口径：本金够不够花"), false);
  setText("curveSourceNote", state.curveSource === "target"
    ? `全盘按${state.scenario === "endowment" ? "金鹅永续" : "细水长流"}反推 ${formatMoney(result.reverse)} 起算 · 手动本金仅作对照`
    : `全盘按我的本金 ${formatMoney(state.principal)} 起算 · 反推值仍作对照`, false);
  setText("activePrincipalNote", `当前全盘起算本金：${formatMoney(result.activePrincipal)}　·　对应 1.1 倍完整目标：${formatMoney(result.activeFullTarget)}`, false);

  const status = $("sustainStatus");
  if (state.scenario === "endowment") {
    if (result.reverse === null) {
      status.textContent = "永续模式不可行";
      status.classList.add("warning");
    } else if (result.realEndBalance >= result.chartStart - 1) {
      status.textContent = "本金购买力可保持";
      status.classList.remove("warning");
    } else if (projection.depletionYear) {
      status.textContent = `第 ${projection.depletionYear} 年出现缺口`;
      status.classList.add("warning");
    } else {
      status.textContent = "购买力逐步下降";
      status.classList.add("warning");
    }
  } else if (projection.depletionYear) {
    status.textContent = `第 ${projection.depletionYear} 年出现缺口`;
    status.classList.add("warning");
  } else if (isTargetCurve) {
    status.textContent = `第 ${state.years} 年本金归零`;
    status.classList.remove("warning");
  } else {
    status.textContent = `预计覆盖 ${state.years} 年`;
    status.classList.remove("warning");
  }

  const insight = $("chartInsight");
  if (state.scenario === "endowment") {
    if (result.reverse === null) {
      insight.classList.add("warning");
      insight.innerHTML = `当前实际收益率为 <strong>${(result.realReturn * 100).toFixed(2)}%</strong>，收益未跑赢通胀，仅靠收益无法长期覆盖支出，金鹅永续模式暂不可行。`;
    } else if (isTargetCurve) {
      insight.classList.remove("warning");
      insight.innerHTML = `金鹅永续曲线从永续本金 <strong>${formatMoney(result.reverse)}</strong> 起算，${state.years} 年末实际购买力约 <strong>${formatMoney(result.realEndBalance)}</strong>，本金购买力保持不变。FIRE 后储备利息 ${formatMoney(postFireInterest)}/年已用于抵扣支出。你的初始目标比所需本金${gap >= 0 ? "高" : "低"} ${formatMoney(Math.abs(gap))}。`;
    } else if (gap >= 0) {
      insight.classList.remove("warning");
      insight.innerHTML = `金鹅永续模式下，期初投资本金达到 <strong>${formatMoney(result.reverse)}</strong>，收益即可覆盖随通胀增长的支出，并保持本金购买力。当前本金高出 <strong>${formatMoney(gap)}</strong>，期末实际购买力约 ${formatMoney(result.realEndBalance)}。`;
    } else {
      insight.classList.add("warning");
      insight.innerHTML = `当前本金低于金鹅永续所需 <strong>${formatMoney(Math.abs(gap))}</strong>，${state.years} 年后实际购买力约为 <strong>${formatMoney(result.realEndBalance)}</strong>。`;
    }
  } else if (isTargetCurve) {
    insight.classList.remove("warning");
    insight.innerHTML = `细水长流曲线从 <strong>${formatMoney(result.reverse)}</strong> 起算，扣除 FIRE 后储备利息 ${formatMoney(postFireInterest)}/年后，在第 ${state.years} 年末正好归零。你的初始目标比所需本金${gap >= 0 ? "高" : "低"} <strong>${formatMoney(Math.abs(gap))}</strong>。`;
  } else if (projection.depletionYear) {
    insight.classList.add("warning");
    insight.innerHTML = `按当前假设，资产将在 <strong>第 ${projection.depletionYear} 年</strong>不足以支付当年支出。期初投资本金达到 <strong>${formatMoney(result.reverse)}</strong>，理论上可覆盖 ${state.years} 年；你的保守完整目标为 ${formatMoney(result.conservative)}。`;
  } else {
    insight.classList.remove("warning");
    insight.innerHTML = `当前本金比 ${state.years} 年反推值${gap >= 0 ? "高" : "低"} <strong>${formatMoney(Math.abs(gap))}</strong>，期末预计剩余 <strong>${formatMoney(finalPoint.balance)}</strong>。这里的反推值不含额外医疗、现金储备与安全垫。`;
  }

  if (dividendActive && Number.isFinite(result.dividendReverseSaving) && result.dividendReverseSaving > 1) {
    insight.innerHTML += ` <span class="dividend-reverse-note">红利抵扣已参与反推：所需投资本金较关闭红利时减少 <strong>${formatMoney(result.dividendReverseSaving)}</strong>。</span>`;
  }

  setText("reverseFullTarget", formatOptionalMoney(result.reverseFull));
  setText("conservativeFullTarget", formatMoney(result.conservative));
  setText("comparisonYears", state.scenario === "endowment" ? "金鹅永续现金流模型" : `${state.years} 年现金流模型`, false);
  const headerByCaliber = state.curveSource === "principal"
    ? "我的本金方案"
    : (state.scenario === "endowment" ? "现金流反推（金鹅永续）" : `现金流反推（${state.years} 年）`);
  setText("modelColumnTitle", headerByCaliber, false);

  const modelTargetValue = state.curveSource === "principal"
    ? result.activeFullTarget
    : (result.reverseFull === null ? 0 : result.reverseFull);
  const maxTarget = Math.max(modelTargetValue, result.conservative, 1);
  $("modelBar").style.width = `${(modelTargetValue / maxTarget) * 100}%`;
  $("conservativeBar").style.width = `${(result.conservative / maxTarget) * 100}%`;

  if (result.safetyDifference === null) {
    $("safetyMessage").innerHTML = "当前收益率未跑赢通胀，无法计算同口径的永续反推目标。";
  } else if (Math.abs(result.safetyDifference) < 1) {
    $("safetyMessage").innerHTML = "你的方案与同口径的金鹅永续完整目标<strong>完全一致</strong>，40 倍年支出正好覆盖本金、储备与 10% 安全垫。";
  } else {
    const extraPercent = result.reverseFull > 0 ? (result.safetyDifference / result.reverseFull) * 100 : 0;
    $("safetyMessage").innerHTML = result.safetyDifference >= 0
      ? `你的方案比同口径反推目标多准备 <strong>${formatMoney(result.safetyDifference)}</strong>，约多出 ${extraPercent.toFixed(0)}% 的安全空间。`
      : `当前参数下，反推完整目标已高于保守方案 <strong>${formatMoney(Math.abs(result.safetyDifference))}</strong>，可适当检查收益率、通胀率与年限。`;
  }

  const reservePlan = result.reservePlan;
  if (reservePlan) {
    setText("reserveModeBadge", state.scenario === "endowment" ? "金鹅永续口径" : "细水长流口径", false);
    $("reserveTargetText").innerHTML = `按当前口径的起算本金 <strong>${formatMoney(result.activePrincipal)}</strong>，还需单独准备 <strong>${formatMoney(reservePlan.target)}</strong> 补充储备以凑齐 1.1 倍完整目标；FIRE 后医疗储备与 10% 安全垫每年产生利息 <strong>${formatMoney(reservePlan.annualReserveInterest)}</strong>，用于抵扣当年支出。`;
    setText("reserveMedical", formatMoney(reservePlan.medicalReserve));
    setText("reserveCash", formatMoney(reservePlan.cashReserve));
    setText("reserveSafetyPad", formatMoney(reservePlan.safetyPad));
    setText("reservePostFireInterest", formatMoney(reservePlan.annualReserveInterest));
    setText("reserveTarget", formatMoney(reservePlan.target));
    setText("homeDelay", formatDelay(reservePlan.homeMonths));
    setText("homeDelayDetail", `每月可存 ${formatMoney(reservePlan.homeMonthlySavings)}，金额按年通胀递增；积累阶段不计息。`);
    setText("sideDelay", formatDelay(reservePlan.sideMonths));
    setText("sideDelayDetail", reservePlan.sideIncomeMonthly > 0
      ? `每月存 ${formatMoney(reservePlan.sideIncomeMonthly)}；积累阶段不计息，不动投资本金。`
      : "请输入大于 0 的副业月收入。");
    setText("combinedDelay", formatDelay(reservePlan.combinedMonths));
    setText("combinedDelayDetail", `每月合计 ${formatMoney(reservePlan.combinedMonthlySavings)}，其中住家 ${formatMoney(reservePlan.homeMonthlySavings)}、副业 ${formatMoney(reservePlan.sideIncomeMonthly)}；积累阶段不计息。`);

    const methods = [
      { name: "住家储蓄", months: reservePlan.homeMonths },
      { name: "副业被动收入", months: reservePlan.sideMonths },
      { name: "住家 + 副业", months: reservePlan.combinedMonths }
    ].filter((method) => method.months !== null);
    if (methods.length === 0) {
      $("reserveConclusion").innerHTML = "当前无法完成补充储备：住家储蓄与副业收入均不可用。";
    } else {
      const fastestMonths = Math.min(...methods.map((method) => method.months));
      const fastestMethods = methods.filter((method) => method.months <= fastestMonths + 0.5);
      const singleFastestMonths = Math.min(
        ...methods.filter((method) => method.name !== "住家 + 副业").map((method) => method.months)
      );
      const combinedIsFaster = reservePlan.combinedMonths !== null
        && reservePlan.combinedMonths < singleFastestMonths - 0.5;
      const fastestLabel = fastestMethods.map((method) => method.name).join("、");
      const lead = combinedIsFaster
        ? `<strong>住家 + 副业</strong>最快，约 ${formatDelay(reservePlan.combinedMonths)}，比最快单项方式早约 <strong>${formatDelay(singleFastestMonths - reservePlan.combinedMonths)}</strong>。`
        : `最快方式：${fastestLabel}，约 <strong>${formatDelay(fastestMonths)}</strong>。`;
      $("reserveConclusion").innerHTML = lead;
    }
  } else {
    setText("reserveModeBadge", state.scenario === "endowment" ? "金鹅永续口径" : "细水长流口径", false);
    setText("reserveTargetText", state.scenario === "endowment" ? "当前收益未跑赢通胀，暂无法测算补充储备。" : "暂无法测算补充储备。", false);
    setText("reserveMedical", "—");
    setText("reserveCash", "—");
    setText("reserveSafetyPad", "—");
    setText("reservePostFireInterest", "—");
    setText("reserveTarget", "—");
    setText("homeDelay", "—");
    setText("sideDelay", "—");
    setText("combinedDelay", "—");
    setText("homeDelayDetail", "—");
    setText("sideDelayDetail", "—");
    setText("combinedDelayDetail", "—");
    $("reserveConclusion").innerHTML = "请先调整收益率与通胀率，使当前模式具备反推本金。";
  }

  const annualIncome = dividendActive && dividendPlan.mode === "dividendPrincipal"
    ? dividendPlan.annualPayment
    : result.fundAnnualDividend;
  const monthlyIncome = annualIncome / 12;
  const incomeCoverage = result.monthly > 0 ? monthlyIncome / result.monthly : null;

  setText("fundModeBadge", !state.dividendEnabled
    ? "未启用"
    : state.dividendMode === "dividendOnly" ? "已启用 · 仅股息" : "已启用 · 股息+本金", false);
  setText("fundLead", !state.dividendEnabled
    ? "红利定投未启用；以下测算仅作参考，不会影响反推本金、现金流曲线或支出抵扣。"
    : state.dividendMode === "dividendOnly"
      ? "红利定投已启用：定投期结束后从 FIRE 对应年份开始仅领取股息，本金保留并抵扣当年支出。"
      : "红利定投已启用：定投期结束后从 FIRE 对应年份开始领取股息+本金，按定投收益率年金化，到测算期末归零。", false);

  if (dividendPlan?.startYear !== null && dividendPlan?.startYear !== undefined) {
    setText("dividendStartNote", dividendPlan.startYear > state.years
      ? `定投 ${state.dcaYears} 年已超过当前 ${state.years} 年测算期，本周期内暂无领取年份。`
      : `已按定投年限锁定领取起点：FIRE 第 ${dividendPlan.startYear} 年开始领取。`, false);
  } else {
    setText("dividendStartNote", `未启用；启用后将按定投年限从 FIRE 第 ${state.dcaYears} 年开始领取。`, false);
  }

  const powerNote = dividendActive && Number.isFinite(dividendPlan?.annualIncomeReal)
    ? `斜杠后为折算回 FIRE 起点（第 0 年）的购买力，按 ${formatPercent(state.inflationRate)} 通胀、第 ${dividendPlan.startYear} 年折现。`
    : "";
  setText("fundValue", formatMoney(result.fundValue));
  setText("fundValueDetail", result.dcaInflationAdjust
    ? `定投 ${state.dcaYears} 年，首年每月 ${formatMoney(result.dcaMonthly)}、末年每月 ${formatMoney(result.dcaFinalMonthly)}（按 ${formatPercent(state.inflationRate)} 通胀逐年递增），累计投入 ${formatMoney(result.dcaTotalContributed)}。`
    : `定投 ${state.dcaYears} 年，每月 ${formatMoney(result.dcaMonthly)}，累计投入 ${formatMoney(result.dcaTotalContributed)}。`);
  setMoneyWithRealPurchasingPower("fundAnnualDividend",
    dividendActive ? dividendPlan.annualIncome : result.fundAnnualDividend,
    dividendActive ? dividendPlan.annualIncomeReal : null);
  setText("fundAnnualDividendDetail", (!dividendActive
    ? `按股息率 ${formatPercent(state.dividendYield)} 计算，仅供测算参考。`
    : dividendPlan.mode === "dividendOnly"
      ? `按股息率 ${formatPercent(state.dividendYield)} 计算，不卖出本金。`
      : `按 ${formatPercent(state.dcaReturnRate)} 收益率年金化，领取 ${dividendPlan.remainingYears} 年后归零。`) + powerNote);
  setMoneyWithRealPurchasingPower("fundMonthlyDividend",
    dividendActive ? dividendPlan.monthlyIncome : result.fundMonthlyDividend,
    dividendActive ? dividendPlan.monthlyIncomeReal : null);
  setText("fundMonthlyDividendDetail", !dividendActive
    ? (result.fundCoverage === null
      ? "当前月支出为 0，无法计算覆盖比例。"
      : `相当于当前月支出的 ${(result.fundCoverage * 100).toFixed(1)}%，仅供测算参考。`)
    : (incomeCoverage === null
      ? "当前月支出为 0，无法计算覆盖比例。"
      : `相当于当前月支出的 ${(incomeCoverage * 100).toFixed(1)}%，${dividendPlan.mode === "dividendOnly" ? "只提取股息" : "领取股息+本金"}。`));
  $("fundScenarioRows").innerHTML = result.fundScenarios.map((scenario) => `
    <tr>
      <td>${scenario.label}</td>
      <td>${formatPercent(scenario.rate)}</td>
      <td>${formatMoney(scenario.value)}</td>
      <td>${formatMoney(scenario.monthlyDividend)}</td>
    </tr>
  `).join("");

  $("dividendLegend").hidden = !dividendActive || !projection.points.some((point) => point.dividendOffset > 0);
  $("reserveLegend").hidden = !projection.points.some((point) => point.reserveOffset > 0);
  $("turningLegend").hidden = !projection.turningPoint;

  // 模型列跟随全盘口径：反推目标口径用反推值，我的本金口径用用户输入的本金，
  // 此时各分项按 activePrincipal + 储备 + 10% 安全垫重新拆解，与现金流/MC 同源。
  const useMyPrincipal = state.curveSource === "principal";
  const modelPrincipal = useMyPrincipal ? result.activePrincipal : result.reverse;
  const modelSafetyPad = useMyPrincipal
    ? result.activeFullTarget / 1.1 * 0.1
    : (result.reverseBase === null ? null : result.reverseBase * 0.1);
  const modelFull = useMyPrincipal ? result.activeFullTarget : result.reverseFull;
  const rows = [
    { label: state.scenario === "endowment" ? "永续投资本金" : "投资本金 / 40 倍年支出", model: modelPrincipal, conservative: result.annual * 40 },
    { label: "医疗储备", model: result.medicalReserve, conservative: result.medicalReserve },
    { label: "36 个月现金储备", model: result.cashReserve, conservative: result.cashReserve },
    { label: "10% 安全垫", model: modelSafetyPad, conservative: result.conservativeBase * 0.1, subtle: true },
    { label: "完整目标合计", model: modelFull, conservative: result.conservative, total: true }
  ];
  $("breakdownRows").innerHTML = rows.map((row) => `
    <tr class="${row.total ? "total-row" : ""} ${row.subtle ? "subtle-row" : ""}">
      <td>${row.label}</td><td>${formatOptionalMoney(row.model)}</td><td>${formatMoney(row.conservative)}</td>
    </tr>
  `).join("");

  renderChart(projection.points, result.chartStart, result);
  // 首次加载同步渲染压力测试与蒙特卡洛，避免面板打开瞬间空白；后续参数变动再防抖。
  renderStressIfReady();
  if (!mcInitialized) {
    mcInitialized = true;
    renderMonteCarlo(result);
  } else {
    scheduleMonteCarlo();
  }
}

function formatEvidenceValue(value, unit) {
  const numeric = Number(value);
  if (value === null || value === undefined || !Number.isFinite(numeric)) return "—";
  if (unit === "CNY") return formatMoney(numeric);
  if (unit === "%") return `${numeric.toFixed(2)}%`;
  if (unit === "个月") return `${numeric.toFixed(1)} 个月`;
  if (unit === "年") return `${numeric} 年`;
  return `${numeric} ${unit}`.trim();
}

function renderRisk(risk) {
  setText("riskEngineVersion", risk.riskEngineVersion, false);
  setText("riskSummary", risk.triggeredCount === 0
    ? `已检查 ${risk.totalRules} 条规则，未触发风险提示。`
    : `已检查 ${risk.totalRules} 条规则，触发 ${risk.triggeredCount} 条风险提示。`, false);

  const triggered = risk.results.filter((item) => item.triggered);
  $("riskCards").innerHTML = triggered.length === 0
    ? `<article class="risk-card empty">
        <div class="risk-card-top"><span>状态</span><h3>未触发规则</h3></div>
        <p>当前假设未命中 MVP 风险规则。仍请注意这是确定性测算，不是收益承诺。</p>
      </article>`
    : triggered.map((card) => `
      <article class="risk-card severity-${card.severity}">
        <div class="risk-card-top">
          <span>${card.severity === "critical" ? "风险" : card.severity === "warning" ? "注意" : "提示"}</span>
          <h3>${card.title}</h3>
        </div>
        <p>${card.message}</p>
        <div class="risk-evidence">
          ${card.evidence.map((item) => `<span>${item.label}：${formatEvidenceValue(item.value, item.unit)}</span>`).join("")}
        </div>
        <small>建议：${card.recommendation}</small>
      </article>
    `).join("");
}

function setSnapshotStatus(kind, message) {
  const status = $("snapshotStatus");
  status.className = `snapshot-status ${kind}`;
  status.innerHTML = message;
  status.hidden = !message;
}

function renderSnapshotMetrics(snapshot) {
  const rows = snapshot.metrics.map((metric) => `
    <tr>
      <td>${metric.metricId}</td>
      <td>${metric.value} ${metric.unit}</td>
      <td>${metric.date}</td>
      <td>${metric.sourceId}</td>
      <td>${metric.fetchedAt}</td>
    </tr>
  `).join("");
  $("snapshotMetricsRows").innerHTML = rows;
  $("snapshotTableWrap").hidden = false;
}

function validateDataSnapshot() {
  const textarea = $("dataSnapshotInput");
  const parsed = normalizeManualSnapshot(JSON.parse(textarea.value || "{}"));
  if (!parsed.valid) {
    latestSnapshot = null;
    $("snapshotTableWrap").hidden = true;
    setSnapshotStatus("error", `<strong>快照校验失败</strong><br>${parsed.errors.map((error) => `· ${error}`).join("<br>")}`);
    return;
  }
  latestSnapshot = parsed.snapshot;
  renderSnapshotMetrics(latestSnapshot);
  setSnapshotStatus("ok", `<strong>快照校验通过</strong><br>共 ${latestSnapshot.metrics.length} 条指标，全部只在本地展示。`);
}

function clearDataSnapshot() {
  latestSnapshot = null;
  $("dataSnapshotInput").value = "";
  $("snapshotMetricsRows").innerHTML = "";
  $("snapshotTableWrap").hidden = true;
  $("snapshotStatus").hidden = true;
}

function downloadSnapshotPayload(payload) {
  const blob = new Blob(["\ufeff", JSON.stringify(payload, null, 2)], { type: "application/json;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `FIRE方案快照_${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, "")}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

function exportSnapshot() {
  if (!latestResult || !latestRisk) {
    showToast("请等待方案计算完成");
    return;
  }
  const payload = createSnapshotPayload({ state, result: latestResult, risk: latestRisk });
  downloadSnapshotPayload(payload);
  showToast("方案快照已导出");
}

function applySnapshotPayload(payload) {
  const snapshotState = payload.state;
  Object.keys(DEFAULT_STATE).forEach((key) => {
    if (key in snapshotState) state[key] = snapshotState[key];
  });
  if (Array.isArray(snapshotState.expenses) && snapshotState.expenses.length > 0) {
    state.expenses = snapshotState.expenses.map((item) => ({
      ...item,
      amount: clamp(Number(item.amount) || 0, 0, Number(item.max) || 0)
    }));
  }
  // 自定义组合随快照迁移：覆盖本地列表并重建按钮；快照未带该字段时保留本地组合。
  if (Array.isArray(snapshotState.mcCustomProfiles)) {
    state.mcCustomProfiles = snapshotState.mcCustomProfiles.filter((item) => item && item.key && item.label);
    saveCustomProfiles();
    renderCustomProfileButtons();
  }
  if (String(state.mcProfile).startsWith("custom-")
    && !state.mcCustomProfiles.some((profile) => profile.key === state.mcProfile)) {
    state.mcProfile = "portfolioA";
  }
  buildExpenseControls();
  syncControls();
  updateAll();
  showToast("方案快照已导入");
}

function importSnapshotFile(file) {
  const reader = new FileReader();
  reader.onload = () => {
    const parsed = parseSnapshotPayload(String(reader.result || ""));
    if (!parsed.valid) {
      showToast(parsed.errors[0] || "方案快照校验失败");
      return;
    }
    applySnapshotPayload(parsed.value);
  };
  reader.onerror = () => showToast("快照文件读取失败");
  reader.readAsText(file, "utf-8");
}

function niceMaximum(value) {
  if (!Number.isFinite(value) || value <= 0) return 100000;
  const exponent = Math.pow(10, Math.floor(Math.log10(value)));
  const fraction = value / exponent;
  const niceFraction = fraction <= 1 ? 1 : fraction <= 2 ? 2 : fraction <= 2.5 ? 2.5 : fraction <= 5 ? 5 : 10;
  return niceFraction * exponent;
}

function renderChart(points, principal, result = null) {
  const svg = $("cashflowChart");
  const wrap = $("chartWrap");
  const tooltip = $("chartTooltip");
  const width = Math.max(320, wrap.clientWidth || 700);
  const height = window.innerWidth <= 580 ? 310 : 360;
  const compact = width < 560;
  // 右轴留给现金流刻度标签
  const margin = { top: 24, right: compact ? 46 : 58, bottom: 38, left: width < 430 ? 46 : 56 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const years = points.length - 1;
  const dividendOffsets = points.map((point) => point.dividendOffset || 0);
  const reserveOffsets = points.map((point) => point.reserveOffset || 0);
  const showDividendCurve = Boolean(result?.dividendPlan?.enabled) && dividendOffsets.some((value) => value > 0);
  const showReserveCurve = reserveOffsets.some((value) => value > 0);

  // 左轴：资产（金色）；右轴：现金流（毛支出/实际提取/抵扣）。两轴独立刻度，避免小额线贴底看不清。
  const rawAssetMax = Math.max(principal, ...points.map((point) => point.balance), 1) * 1.08;
  const assetMax = niceMaximum(rawAssetMax);
  const flowValues = points.flatMap((point) => [
    point.grossExpense || 0, point.expense || 0, point.withdrawal || 0,
    point.investmentReturn || 0, point.dividendOffset || 0, point.reserveOffset || 0
  ]);
  const flowMax = niceMaximum(Math.max(...flowValues, 1) * 1.08);

  const x = (year) => margin.left + (year / years) * plotWidth;
  const yAsset = (value) => margin.top + (1 - clamp(value / assetMax, 0, 1)) * plotHeight;
  const yFlow = (value) => margin.top + (1 - clamp(value / flowMax, 0, 1)) * plotHeight;
  const zeroY = yAsset(0);
  const assetPoints = points.map((point) => [x(point.year), yAsset(point.balance)]);
  const linePath = (coordinates) => coordinates.map((point, index) => `${index === 0 ? "M" : "L"}${point[0].toFixed(2)},${point[1].toFixed(2)}`).join(" ");
  const assetPath = linePath(assetPoints);
  const areaPath = `${assetPath} L${x(years).toFixed(2)},${zeroY.toFixed(2)} L${x(0).toFixed(2)},${zeroY.toFixed(2)} Z`;
  const fy = (key) => linePath(points.slice(1).map((point) => [x(point.year), yFlow(point[key] || 0)]));
  const turningPoint = result?.projection?.turningPoint || null;
  const dividendStartYear = result?.dividendPlan?.enabled && result.dividendPlan.startYear !== null
    ? result.dividendPlan.startYear
    : null;

  let dividendStartMarkup = "";
  if (dividendStartYear !== null && dividendStartYear <= years) {
    const startX = x(dividendStartYear);
    const labelAnchor = startX > width - 92 ? "end" : "start";
    const labelX = startX + (labelAnchor === "start" ? 7 : -7);
    dividendStartMarkup = `
      <g class="chart-dividend-start">
        <line x1="${startX.toFixed(2)}" y1="${margin.top}" x2="${startX.toFixed(2)}" y2="${zeroY.toFixed(2)}"/>
        <text x="${labelX.toFixed(2)}" y="${margin.top + 10}" text-anchor="${labelAnchor}">领取起点</text>
      </g>`;
  }

  let turningMarkup = "";
  if (turningPoint) {
    const turningX = x(turningPoint.year);
    const turningY = yAsset(turningPoint.balance);
    const labelAnchor = turningX > width - 118 ? "end" : turningX < 118 ? "start" : "middle";
    const labelX = turningX + (labelAnchor === "start" ? 8 : labelAnchor === "end" ? -8 : 0);
    const labelY = Math.max(margin.top + 24, turningY - 11);
    turningMarkup = `
      <g class="chart-turning">
        <line x1="${turningX.toFixed(2)}" y1="${margin.top}" x2="${turningX.toFixed(2)}" y2="${zeroY.toFixed(2)}"/>
        <circle cx="${turningX.toFixed(2)}" cy="${turningY.toFixed(2)}" r="4.5"/>
        <text x="${labelX.toFixed(2)}" y="${labelY.toFixed(2)}" text-anchor="${labelAnchor}">拐点 · 第 ${turningPoint.year} 年</text>
      </g>`;
  }

  const yTicks = Array.from({ length: 6 }, (_, index) => (assetMax / 5) * index);
  const flowTicks = Array.from({ length: 6 }, (_, index) => (flowMax / 5) * index);
  const candidateSteps = [5, 10, 20, 50];
  const xStep = candidateSteps.find((step) => years / step <= 5) || 20;
  const xTicks = [];
  for (let year = 0; year < years; year += xStep) xTicks.push(year);
  if (xTicks[xTicks.length - 1] !== years) xTicks.push(years);

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="assetGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#a5772a" stop-opacity=".20"/>
        <stop offset="100%" stop-color="#a5772a" stop-opacity=".015"/>
      </linearGradient>
    </defs>
    <g aria-hidden="true">
      ${yTicks.map((tick, index) => `
        <line class="chart-grid" x1="${margin.left}" y1="${yAsset(tick)}" x2="${width - margin.right}" y2="${yAsset(tick)}"/>
        <text class="chart-axis-label" x="${margin.left - 8}" y="${yAsset(tick) + 3}" text-anchor="end">${formatAxis(tick)}</text>
        <text class="chart-axis-label chart-axis-right" x="${width - margin.right + 8}" y="${yFlow(flowTicks[index]) + 3}" text-anchor="start">${formatAxis(flowTicks[index])}</text>
      `).join("")}
      ${xTicks.map((tick) => `<text class="chart-axis-label" x="${x(tick)}" y="${height - 13}" text-anchor="middle">${tick === 0 ? "现在" : `${tick} 年`}</text>`).join("")}
      <path class="chart-area" d="${areaPath}"/>
      <line class="chart-principal-path" x1="${margin.left}" y1="${yAsset(principal)}" x2="${width - margin.right}" y2="${yAsset(principal)}"/>
      <path class="chart-gross-path" d="${fy("grossExpense")}"/>
      ${showReserveCurve ? `<path class="chart-reserve-path" d="${fy("reserveOffset")}"/>` : ""}
      ${showDividendCurve ? `<path class="chart-dividend-path" d="${fy("dividendOffset")}"/>` : ""}
      <path class="chart-expense-path" d="${fy("withdrawal")}"/>
      <path class="chart-asset-path" d="${assetPath}"/>
      ${dividendStartMarkup}
      ${turningMarkup}
      <g id="chartHover" visibility="hidden">
        <line id="chartHoverLine" class="chart-hover-line" y1="${margin.top}" y2="${zeroY}"/>
        <circle id="chartAssetDot" class="chart-hover-dot-asset" r="4.5"/>
        <circle id="chartExpenseDot" class="chart-hover-dot-expense" r="3.5"/>
      </g>
      <rect id="chartOverlay" x="${margin.left}" y="${margin.top}" width="${plotWidth}" height="${plotHeight}" fill="transparent" style="cursor:crosshair"/>
    </g>
  `;

  const overlay = svg.querySelector("#chartOverlay");
  const hover = svg.querySelector("#chartHover");
  const hoverLine = svg.querySelector("#chartHoverLine");
  const assetDot = svg.querySelector("#chartAssetDot");
  const expenseDot = svg.querySelector("#chartExpenseDot");

  const hideTooltip = () => {
    tooltip.hidden = true;
    hover.setAttribute("visibility", "hidden");
  };

  overlay.addEventListener("pointermove", (event) => {
    const rect = svg.getBoundingClientRect();
    const svgX = ((event.clientX - rect.left) / rect.width) * width;
    const year = clamp(Math.round(((svgX - margin.left) / plotWidth) * years), 0, years);
    const point = points[year];
    const hoverX = x(year);
    const assetY = yAsset(point.balance);
    const expenseY = yFlow(point.withdrawal || 0);
    hover.setAttribute("visibility", "visible");
    hoverLine.setAttribute("x1", hoverX);
    hoverLine.setAttribute("x2", hoverX);
    assetDot.setAttribute("cx", hoverX);
    assetDot.setAttribute("cy", assetY);
    expenseDot.setAttribute("cx", hoverX);
    expenseDot.setAttribute("cy", expenseY);
    expenseDot.setAttribute("visibility", year === 0 ? "hidden" : "visible");

    if (year === 0) {
      tooltip.innerHTML = `<strong>期初</strong><span>起始本金 <b>${formatMoney(point.balance)}</b></span>`;
    } else {
      const reserveOffset = point.reserveOffset || 0;
      const dividendOffset = point.dividendOffset || 0;
      const totalOffset = reserveOffset + dividendOffset;
      tooltip.innerHTML = `
        <strong>第 ${year} 年</strong>
        <span>期初资产 <b>${formatMoney(point.startBalance)}</b></span>
        <span>投资收益 <b>${formatMoney(point.investmentReturn)}</b></span>
        <span class="tt-divider">当年毛支出 <b>${formatMoney(point.grossExpense)}</b></span>
        ${reserveOffset > 0 ? `<span class="tt-offset">储备利息抵扣 <b>−${formatMoney(reserveOffset)}</b></span>` : ""}
        ${dividendOffset > 0 ? `<span class="tt-offset">红利抵扣 <b>−${formatMoney(dividendOffset)}</b></span>` : ""}
        <span>实际提取 <b>${formatMoney(point.withdrawal)}</b></span>
        ${totalOffset > 0 ? `<span class="tt-total">两项抵扣合计 <b>${formatMoney(totalOffset)}</b></span>` : ""}
        <span class="tt-divider">年末资产 <b>${formatMoney(point.balance)}</b></span>`;
    }
    tooltip.hidden = false;
    const pixelX = (hoverX / width) * rect.width;
    const pixelY = (Math.min(assetY, year === 0 ? assetY : expenseY) / height) * rect.height;
    tooltip.style.left = `${clamp(pixelX, 82, rect.width - 82)}px`;
    tooltip.style.top = `${Math.max(88, pixelY)}px`;
  });
  overlay.addEventListener("pointerleave", hideTooltip);
  overlay.addEventListener("pointercancel", hideTooltip);
}

// 参数变动频繁，蒙特卡洛做短防抖，避免拖动滑杆时反复计算数千条路径。
function scheduleMonteCarlo() {
  window.clearTimeout(mcTimer);
  const token = ++mcSequence;
  mcTimer = window.setTimeout(() => {
    if (token !== mcSequence || !latestResult) return;
    renderMonteCarlo(latestResult);
  }, 180);
}

// ===== 耗尽年份分桶 · 典型现金流曲线弹窗 =====

function average(values) {
  const list = values.filter((value) => Number.isFinite(value));
  if (list.length === 0) return null;
  return list.reduce((sum, value) => sum + value, 0) / list.length;
}

function formatYearSpan(months) {
  if (!Number.isFinite(months)) return "—";
  const years = Math.floor(months / 12);
  const rest = Math.round(months % 12);
  if (years === 0) return `${rest} 个月`;
  if (rest === 0) return `${years} 年`;
  return `${years} 年 ${rest} 个月`;
}

// 生成该桶典型路径的解读：起点对比、收益结构、失败时点、抵扣结构与周期位置。
function buildBucketInsight(bucket, mc) {
  const points = bucket.points;
  const depletionYear = bucket.depletionYear;
  const medianGeo = geometricMeanClient(bucket.medianPath);
  const earlyHalf = geometricMeanClient(bucket.medianPath.slice(0, Math.floor(bucket.medianPath.length / 2)));
  const lateHalf = geometricMeanClient(bucket.medianPath.slice(Math.floor(bucket.medianPath.length / 2)));
  const worstYearReturn = Math.min(...bucket.medianPath);
  const worstYearIndex = bucket.medianPath.indexOf(worstYearReturn) + 1;
  const bestYearReturn = Math.max(...bucket.medianPath);
  const peakPoint = points.reduce((best, point) => (point.balance > best.balance ? point : best), points[0]);
  const fullTarget = latestResult ? latestResult.activeFullTarget : null;
  const principalShare = fullTarget && fullTarget > 0 ? mc.startingPrincipal / fullTarget : null;

  const reserveRows = points.filter((point) => point.reserveOffset > 0.5);
  const dividendRows = points.filter((point) => point.dividendOffset > 0.5);
  const flexRows = points.filter((point) => point.flexApplied);
  const totalReserveOffset = points.reduce((sum, point) => sum + point.reserveOffset, 0);
  const totalDividendOffset = points.reduce((sum, point) => sum + point.dividendOffset, 0);
  const totalWithdrawn = points.slice(0, depletionYear).reduce((sum, point) => sum + point.withdrawal, 0);

  const positionText = principalShare !== null
    ? (principalShare >= 0.999
      ? "当前起点已达到 1.1 倍完整保守目标，这类失败主要由极端市场顺序触发，属于低概率尾部情形。"
      : principalShare >= 0.75
        ? "当前起点接近完整保守目标（约 " + (principalShare * 100).toFixed(0) + "%），但确定性目标里的安全垫在本模拟中同样承担提取，失败多出现在连续不佳年份之后。"
        : principalShare >= 0.5
          ? "当前起点约为完整保守目标的一半（" + (principalShare * 100).toFixed(0) + "%），中等波动即可显著缩短存续年限。"
          : "当前起点明显低于完整保守目标（仅 " + (principalShare * 100).toFixed(0) + "%），失败更像是结构性本金不足而非运气问题。")
    : "";

  const orderText = lateHalf - earlyHalf >= 0.01
    ? `收益顺序不利：前半段年化约 <strong>${formatPercent(earlyHalf * 100)}</strong>，后半段才回升到 <strong>${formatPercent(lateHalf * 100)}</strong>——钱在资产已经很薄时才遇到好年份，来不及修复缺口。`
    : (lateHalf - earlyHalf <= -0.01
      ? `收益前高后低：前半段年化 <strong>${formatPercent(earlyHalf * 100)}</strong>，后半段降至 <strong>${formatPercent(lateHalf * 100)}</strong>，后期提取压力直接击穿本金。`
      : `前后半段收益接近（约 <strong>${formatPercent(earlyHalf * 100)}</strong> / <strong>${formatPercent(lateHalf * 100)}</strong>），失败更源于整体收益中枢低于提取需求，而非特定顺序。`);

  const tailText = worstYearReturn <= -0.2
    ? `路径中出现过单年 <strong>${formatPercent(worstYearReturn * 100)}</strong> 的极端亏损（第 ${worstYearIndex} 年），叠加通胀增长后的支出提取，显著加速了资产消耗。`
    : `最差单年亏损 <strong>${formatPercent(worstYearReturn * 100)}</strong>（第 ${worstYearIndex} 年），未出现极端尾部亏损，失败更多是慢性消耗而非一次性冲击。`;

  const offsetParts = [];
  if (totalReserveOffset > 1) offsetParts.push(`储备利息累计抵扣支出 <strong>${formatMoney(totalReserveOffset)}</strong>`);
  if (totalDividendOffset > 1) offsetParts.push(`红利累计抵扣 <strong>${formatMoney(totalDividendOffset)}</strong>`);
  if (flexRows.length > 0) offsetParts.push(`支出弹性触发 <strong>${flexRows.length}</strong> 次`);
  const offsetText = offsetParts.length > 0
    ? `期内${offsetParts.join("、")}；即便如此仍未能阻止缺口出现。`
    : "期内没有储备利息、红利或支出弹性参与抵扣，资产完全靠本金与收益覆盖逐年增长的支出。";

  const peakText = peakPoint.year > 0
    ? `资产峰值出现在第 ${peakPoint.year} 年（${formatMoney(peakPoint.balance)}），随后${depletionYear - peakPoint.year <= 3 ? "迅速" : "逐步"}回落，第 ${depletionYear} 年出现资金缺口。`
    : `资产从起点即开始回落，第 ${depletionYear} 年出现资金缺口。`;

  const sections = [
    `<span class="mc-modal-sec"><strong>这条曲线怎么来的：</strong>把该区间 ${bucket.sampleCount.toLocaleString("zh-CN")} 条失败路径的收益率逐取中位数，形成一条典型路径，再按与主现金流完全相同的引擎重放。它代表「这个区间的失败通常长什么样」，不是任何一条真实路径。</span>`,
    `<span class="mc-modal-sec"><strong>收益结构：</strong>典型路径几何年化 <strong>${formatPercent(medianGeo * 100)}</strong>，低于模拟中枢 <strong>${formatPercent(mc.mu * 100)}</strong>${mc.sigma > 0 ? `（波动率 ${formatPercent(mc.sigma * 100)} 的拖累清晰可见）` : ""}。${orderText}${tailText}</span>`,
    `<span class="mc-modal-sec"><strong>耗尽过程：</strong>${peakText}期内累计实际提取 <strong>${formatMoney(totalWithdrawn)}</strong>。${offsetText}</span>`,
    `<span class="mc-modal-sec"><strong>周期位置：</strong>${positionText}</span>`
  ];
  return sections.join("");
}

// 客户端版几何平均（monte-carlo.js 内的同名函数未导出，这里保持口径一致）。
function geometricMeanClient(returnPath) {
  if (!Array.isArray(returnPath) || returnPath.length === 0) return 0;
  let logSum = 0;
  for (const r of returnPath) {
    const safe = Math.min(Math.max(r, -0.9999), 100);
    logSum += Math.log(1 + (Number.isFinite(safe) ? safe : 0));
  }
  return Math.exp(logSum / returnPath.length) - 1;
}

function renderBucketModalChart(bucket, mc) {
  const svg = $("mcModalChart");
  const wrap = svg.closest(".chart-wrap");
  const width = Math.max(320, wrap.clientWidth || 660);
  const height = window.innerWidth <= 580 ? 280 : 330;
  const compact = width < 560;
  const margin = { top: 22, right: compact ? 44 : 54, bottom: 34, left: width < 430 ? 44 : 52 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const years = mc.years;
  const points = bucket.points;

  const assetMax = niceMaximum(Math.max(mc.startingPrincipal, ...points.map((p) => p.balance), 1) * 1.08);
  const flowValues = points.flatMap((p) => [p.grossExpense || 0, p.withdrawal || 0]);
  const flowMax = niceMaximum(Math.max(...flowValues, 1) * 1.08);
  const x = (year) => margin.left + (year / years) * plotWidth;
  const yAsset = (value) => margin.top + (1 - clamp(value / assetMax, 0, 1)) * plotHeight;
  const yFlow = (value) => margin.top + (1 - clamp(value / flowMax, 0, 1)) * plotHeight;
  const zeroY = yAsset(0);
  const linePath = (coords) => coords.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");
  const assetPath = linePath(points.map((p) => [x(p.year), yAsset(p.balance)]));
  const areaPath = `${assetPath} L${x(years).toFixed(2)},${zeroY.toFixed(2)} L${x(0).toFixed(2)},${zeroY.toFixed(2)} Z`;
  const withdrawalPath = linePath(points.slice(1).map((p) => [x(p.year), yFlow(p.withdrawal || 0)]));
  const depletionX = x(bucket.depletionYear);

  const yTicks = Array.from({ length: 5 }, (_, i) => (assetMax / 4) * i);
  const flowTicks = Array.from({ length: 5 }, (_, i) => (flowMax / 4) * i);
  const candidateSteps = [5, 10, 20];
  const xStep = candidateSteps.find((step) => years / step <= 6) || 20;
  const xTicks = [];
  for (let year = 0; year < years; year += xStep) xTicks.push(year);
  if (xTicks[xTicks.length - 1] !== years) xTicks.push(years);

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="mcModalGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#a5772a" stop-opacity=".18"/>
        <stop offset="100%" stop-color="#a5772a" stop-opacity=".015"/>
      </linearGradient>
    </defs>
    <g aria-hidden="true">
      ${yTicks.map((tick, i) => `
        <line class="chart-grid" x1="${margin.left}" y1="${yAsset(tick)}" x2="${width - margin.right}" y2="${yAsset(tick)}"/>
        <text class="chart-axis-label" x="${margin.left - 8}" y="${yAsset(tick) + 3}" text-anchor="end">${formatAxis(tick)}</text>
        <text class="chart-axis-label chart-axis-right" x="${width - margin.right + 8}" y="${yFlow(flowTicks[i]) + 3}" text-anchor="start">${formatAxis(flowTicks[i])}</text>
      `).join("")}
      ${xTicks.map((tick) => `<text class="chart-axis-label" x="${x(tick)}" y="${height - 12}" text-anchor="middle">${tick === 0 ? "现在" : `${tick} 年`}</text>`).join("")}
      <path class="chart-area" d="${areaPath}"/>
      <line class="chart-principal-path" x1="${margin.left}" y1="${yAsset(mc.startingPrincipal)}" x2="${width - margin.right}" y2="${yAsset(mc.startingPrincipal)}"/>
      <path class="chart-expense-path" d="${withdrawalPath}"/>
      <path class="chart-asset-path" d="${assetPath}"/>
      <line class="mc-modal-depletion" x1="${depletionX.toFixed(2)}" y1="${margin.top}" x2="${depletionX.toFixed(2)}" y2="${zeroY.toFixed(2)}"/>
      <circle class="mc-modal-depletion-dot" cx="${depletionX.toFixed(2)}" cy="${yAsset(points[bucket.depletionYear].balance).toFixed(2)}" r="4.5"/>
      <text class="mc-modal-depletion-text" x="${(depletionX > width - 110 ? depletionX - 8 : depletionX + 8).toFixed(2)}" y="${(margin.top + 12).toFixed(2)}" text-anchor="${depletionX > width - 110 ? "end" : "start"}">第 ${bucket.depletionYear} 年缺口</text>
      ${points.some((p) => p.flexApplied) ? `<g>${points.filter((p) => p.flexApplied).map((p) => `<circle class="mc-modal-flex-dot" cx="${x(p.year).toFixed(2)}" cy="${yAsset(p.balance).toFixed(2)}" r="3.2"/>`).join("")}</g>` : ""}
    </g>
  `;
}

function openBucketModal(bucketIndex) {
  const overlay = $("mcModalOverlay");
  if (!overlay || !latestMc || !latestResult) return;
  const bucket = latestMc.bucketPaths?.[bucketIndex];
  if (!bucket) return;

  setText("mcModalTitle", `第 ${bucket.start}–${bucket.end} 年耗尽区间的典型现金流`, false);
  $("mcModalKpis").innerHTML = [
    ["区间失败路径", `${bucket.sampleCount.toLocaleString("zh-CN")} 条`],
    ["占全部失败", `${latestMc.failedCount > 0 ? ((bucket.sampleCount / latestMc.failedCount) * 100).toFixed(0) : 0}%`],
    ["典型缺口时点", `第 ${bucket.depletionYear} 年`],
    ["起点本金", formatMoney(latestMc.startingPrincipal)]
  ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("");

  renderBucketModalChart(bucket, latestMc);
  $("mcModalFlexLegend").hidden = !bucket.points.some((point) => point.flexApplied);
  $("mcModalInsight").innerHTML = buildBucketInsight(bucket, latestMc);
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  $("mcModalClose").focus();
}

function closeBucketModal() {
  const overlay = $("mcModalOverlay");
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  document.body.style.overflow = "";
}

// ===== 定投金额 · 每月定投额阶梯曲线弹窗 =====

// 每年 12 个月的月投额：定投随通胀每年年初上调一次，年内 12 个月保持不变。
// 与 fire-engine 的 futureValueGrowingDca 完全同口径：第 y 年（0 起）月投额 = 基准 × (1+通胀)^y。
function buildMonthlyDcaSchedule(baseMonthly, years, inflationAdjust, inflationRate) {
  const months = Math.max(0, Math.round(years * 12));
  const schedule = new Array(months);
  for (let month = 1; month <= months; month += 1) {
    const yearIndex = Math.floor((month - 1) / 12);
    schedule[month - 1] = inflationAdjust
      ? baseMonthly * Math.pow(1 + inflationRate, yearIndex)
      : baseMonthly;
  }
  return schedule;
}

// 把逐月序列压缩为阶梯折线点：每段记录 [起始月索引, 金额]，月份按 0 基准。
function compressMonthlySteps(schedule) {
  const steps = [];
  for (let i = 0; i < schedule.length; i += 1) {
    if (steps.length === 0 || schedule[i] !== steps[steps.length - 1].value) {
      steps.push({ startMonth: i, value: schedule[i] });
    }
  }
  return steps;
}

function renderDcaModalChart(schedule, baseMonthly, inflationAdjust) {
  const svg = $("dcaModalChart");
  const wrap = svg.closest(".chart-wrap");
  const width = Math.max(320, wrap.clientWidth || 660);
  const height = window.innerWidth <= 580 ? 270 : 320;
  const compact = width < 560;
  const margin = { top: 20, right: compact ? 16 : 24, bottom: 32, left: width < 430 ? 46 : 56 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const months = schedule.length;
  const maxValue = niceMaximum(Math.max(...schedule, baseMonthly, 1) * 1.08);
  const x = (month) => margin.left + (month / Math.max(1, months)) * plotWidth;
  const y = (value) => margin.top + (1 - clamp(value / maxValue, 0, 1)) * plotHeight;
  const steps = compressMonthlySteps(schedule);

  // 阶梯路径：每段水平线 + 跳变时垂直连线；末尾补一段到 months。
  let path = "";
  steps.forEach((step, index) => {
    const endMonth = index + 1 < steps.length ? steps[index + 1].startMonth : months;
    path += `${index === 0 ? "M" : "L"}${x(step.startMonth).toFixed(2)},${y(step.value).toFixed(2)}`;
    path += `L${x(endMonth).toFixed(2)},${y(step.value).toFixed(2)}`;
  });
  const areaPath = `${path}L${x(months).toFixed(2)},${(y(0)).toFixed(2)}L${x(0).toFixed(2)},${(y(0)).toFixed(2)}Z`;
  const flatY = y(baseMonthly);
  const yearStep = months > 240 ? 60 : months > 120 ? 24 : 12;
  const xTicks = [];
  for (let month = 0; month < months; month += yearStep) xTicks.push(month);
  if (xTicks[xTicks.length - 1] !== months) xTicks.push(months);
  const yTicks = Array.from({ length: 5 }, (_, i) => (maxValue / 4) * i);
  // 跳变点圆点：只在通胀调整模式下、且数量可控时展示。
  const showDots = inflationAdjust && steps.length <= 50;
  const dotEvery = steps.length > 26 ? 5 : 1;

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="dcaGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#a5772a" stop-opacity=".16"/>
        <stop offset="100%" stop-color="#a5772a" stop-opacity=".015"/>
      </linearGradient>
    </defs>
    <g aria-hidden="true">
      ${yTicks.map((tick) => `
        <line class="chart-grid" x1="${margin.left}" y1="${y(tick)}" x2="${width - margin.right}" y2="${y(tick)}"/>
        <text class="chart-axis-label" x="${margin.left - 8}" y="${y(tick) + 3}" text-anchor="end">${formatAxis(tick)}</text>
      `).join("")}
      ${xTicks.map((month) => `<text class="chart-axis-label" x="${x(month)}" y="${height - 10}" text-anchor="middle">${month === 0 ? "第 1 月" : `第 ${month + 1} 月`}</text>`).join("")}
      ${inflationAdjust ? `<line class="dca-flat-path" x1="${margin.left}" y1="${flatY}" x2="${width - margin.right}" y2="${flatY}"/>` : ""}
      <path class="dca-step-area" d="${areaPath}"/>
      <path class="dca-step-path" d="${path}"/>
      ${showDots ? steps.map((step, index) => index % dotEvery === 0
        ? `<circle class="dca-step-dot" cx="${x(step.startMonth).toFixed(2)}" cy="${y(step.value).toFixed(2)}" r="3"/>` : "").join("") : ""}
    </g>
  `;
}

function openDcaModal() {
  const overlay = $("dcaModalOverlay");
  if (!overlay || !latestResult) return;
  const baseMonthly = Number(state.dcaMonthly) || 0;
  const years = Math.round(clamp(state.dcaYears, 1, 50));
  const inflationAdjust = state.dcaInflationAdjust === true;
  const inflationRate = (Number(state.inflationRate) || 0) / 100;
  const schedule = buildMonthlyDcaSchedule(baseMonthly, years, inflationAdjust, inflationRate);
  if (schedule.length === 0) return;

  setText("dcaModalTitle", inflationAdjust
    ? `每月定投金额曲线（按 ${formatPercent(state.inflationRate)} 通胀逐年上调）`
    : "每月定投金额曲线（固定）", false);
  const finalMonthly = schedule[schedule.length - 1];
  const firstMonthly = schedule[0];
  const totalContributed = schedule.reduce((sum, value) => sum + value, 0);
  const growth = firstMonthly > 0 ? ((finalMonthly / firstMonthly) - 1) * 100 : 0;
  $("dcaModalKpis").innerHTML = [
    ["首月定投", formatMoney(firstMonthly)],
    inflationAdjust ? ["末月定投", formatMoney(finalMonthly)] : ["每月定投", formatMoney(finalMonthly)],
    ["累计投入", formatMoney(totalContributed)],
    inflationAdjust ? ["累计上调幅度", `+${formatPercent(growth)}`] : ["定投月数", `${schedule.length} 个月`]
  ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("");

  renderDcaModalChart(schedule, baseMonthly, inflationAdjust);
  $("dcaModalInflationLegend").hidden = !inflationAdjust;
  $("dcaModalInsight").innerHTML = inflationAdjust
    ? `<span class="mc-modal-sec"><strong>口径说明：</strong>开启「定投随通胀」后，<strong>每年年初上调一次</strong>——第 y 年月投额 = 基准 ${formatMoney(baseMonthly)} × (1 + ${formatPercent(state.inflationRate)})<sup>y</sup>，年内 12 个月保持不变，不是逐月连续上涨。图中灰色虚线为「不随通胀」的固定对照线；阶梯间的落差就是每年的跳涨幅度，最后一个月月投额为首月的 <strong>${formatPercent(growth + 100)}</strong>。</span><span class="mc-modal-sec"><strong>对结果的影响：</strong>累计投入 <strong>${formatMoney(totalContributed)}</strong>，高于固定定投的 ${formatMoney(baseMonthly * schedule.length)}；多投入的部分按月复利滚存，因此期末基金市值与股息也会相应提高。</span>`
    : `<span class="mc-modal-sec"><strong>口径说明：</strong>「定投随通胀」当前为关闭状态，<strong>${state.dcaYears} 年内每月固定投入 ${formatMoney(baseMonthly)}</strong>，金额不随时间变化。若开启「定投随通胀」，月投额将按当前通胀率 ${formatPercent(state.inflationRate)} 每年年初上调一次（年内不变），累计投入与期末市值都会相应提高。</span>`;
  overlay.hidden = false;
  document.body.style.overflow = "hidden";
  $("dcaModalClose").focus();
}

function closeDcaModal() {
  const overlay = $("dcaModalOverlay");
  if (!overlay || overlay.hidden) return;
  overlay.hidden = true;
  document.body.style.overflow = "";
}

// ===== 黑天鹅压力测试面板 =====

function stressShockParams() {
  return {
    depth: clamp(Number($("stressDepth")?.value) || 30, 1, 90),
    length: clamp(Math.round(Number($("stressLength")?.value) || 2), 1, 10),
    inflation: clamp(Number($("stressInflation")?.value) || 0, -5, 15)
  };
}

function isCustomStressScenario() {
  return state.stressScenario === "custom";
}

function syncStressControls() {
  document.querySelectorAll("[data-stress-scenario]").forEach((button) => {
    const active = button.dataset.stressScenario === state.stressScenario;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  document.querySelectorAll("[data-stress-gk]").forEach((button) => {
    const active = (button.dataset.stressGk === "true") === state.stressGuytonKlinger;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const customWrap = $("stressCustom");
  if (customWrap) customWrap.hidden = !isCustomStressScenario();
}

function formatStressSurvival(item, years) {
  if (item.scenarioId === "baseline") return "基准";
  if (item.depletionYear === null) return item.survived ? "撑过" : `撑过（购买力下降）`;
  return `第 ${item.depletionYear} 年`;
}

function renderStressKpis(scenario) {
  const alerts = scenario.alerts;
  const levelText = alerts.level === "critical" ? "红色警报" : alerts.level === "warning" ? "黄色预警" : "安全";
  const levelClass = alerts.level === "critical" ? "warn" : alerts.level === "warning" ? "" : "good";
  const kpis = $("stressKpis");
  kpis.className = `stress-kpis ${levelClass}`;
  kpis.innerHTML = `
    <article><span>危机期组合回撤</span><strong>${formatPercent(scenario.crisisReturn * 100)}</strong><p>${scenario.crisisYears} 年冲击段的纯市场跌幅</p></article>
    <article><span>路径最深回撤</span><strong>${formatPercent(alerts.maxDrawdown * 100)}</strong><p>含提取消耗的资产峰值回撤</p></article>
    <article><span>${scenario.years} 年后剩余资产</span><strong>${formatMoney(scenario.endBalance)}</strong><p>名义金额${scenario.isEndowment ? " · 永续口径要求购买力不减" : ""}</p></article>
    <article><span>危机提取占比</span><strong>${formatPercent((scenario.startingPrincipal > 0 ? scenario.totalWithdrawals / scenario.startingPrincipal : 0) * 100)}</strong><p>期内累计提取 ÷ 起点本金</p></article>`;
}

function renderStressAlert(scenario) {
  const alert = $("stressAlert");
  const alerts = scenario.alerts;
  let icon = "";
  let title = "";
  let message = "";
  if (alerts.level === "critical") {
    icon = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="M10 3 18 16H2Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M10 8v4.2M10 14.6v.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    title = "红色警报";
    message = `最深回撤 ${formatPercent(alerts.maxDrawdown * 100)} 已越过 −25% 红线${alerts.criticalYear ? `（第 ${alerts.criticalYear} 年触及）` : ""}。按预案应：启用减提/弹性支出、暂停买入、只从现金桶取钱。`;
  } else if (alerts.level === "warning") {
    icon = `<svg viewBox="0 0 20 20" aria-hidden="true"><circle cx="10" cy="10" r="7.2" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M10 6.2v4.6M10 13.2v.1" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>`;
    title = "黄色预警";
    message = `最深回撤 ${formatPercent(alerts.maxDrawdown * 100)} 已越过 −15% 预警线${alerts.warningYear ? `（第 ${alerts.warningYear} 年触及）` : ""}。按预案应：降低非必要支出，暂停加仓，静观市场。`;
  } else {
    icon = `<svg viewBox="0 0 20 20" aria-hidden="true"><path d="m4.5 10.5 3.6 3.6 7.4-8" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    title = "当前安全";
    message = `该场景下最深回撤 ${formatPercent(alerts.maxDrawdown * 100)}，未触发 −15% 预警线，水桶结构足以覆盖危机期提取。`;
  }
  alert.className = `stress-alert level-${alerts.level}`;
  alert.innerHTML = `${icon}<div><strong>${title}</strong><p>${message}</p></div>`;
}

function renderStressBuckets(scenario) {
  const buckets = scenario.buckets;
  setText("bucketCash", formatMoney(buckets.cash), false);
  setText("bucketBond", formatMoney(buckets.bond), false);
  setText("bucketEquity", formatMoney(buckets.equity), false);
  setText("bucketCashNote", `≈ ${buckets.cashMonths} 个月开销 · 危机时只从这里取钱`, false);
}

function renderStressTable(comparison) {
  $("stressTable").innerHTML = `
    <thead><tr><th>场景</th><th>危机回撤</th><th>撑到</th><th>期末资产</th><th>最深回撤</th></tr></thead>
    <tbody>${comparison.scenarios.map((item) => {
      const isWorst = comparison.worst && item.scenarioId === comparison.worst.scenarioId;
      const isBaseline = item.scenarioId === "baseline";
      return `<tr class="${isWorst ? "worst-row" : ""}${isBaseline ? " baseline-row" : ""}">
        <td>${item.scenario.label}</td>
        <td>${item.scenarioId === "baseline" ? "—" : formatPercent(item.crisisReturn * 100)}</td>
        <td>${formatStressSurvival(item, item.years)}</td>
        <td>${formatMoney(item.endBalance)}</td>
        <td>${formatPercent(item.alerts.maxDrawdown * 100)}</td>
      </tr>`;
    }).join("")}</tbody>`;
}

// 压力场景资产曲线：与主现金流图同风格，双轴（资产左轴 / 当年提取右轴）。
function renderStressChart(scenario) {
  const svg = $("stressChart");
  if (!svg) return;
  const wrap = svg.closest(".chart-wrap");
  const width = Math.max(300, wrap.clientWidth || 640);
  const height = window.innerWidth <= 580 ? 250 : 280;
  const compact = width < 560;
  const margin = { top: 22, right: compact ? 44 : 54, bottom: 30, left: width < 430 ? 44 : 52 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const years = scenario.years;
  const points = scenario.points;

  const assetMax = niceMaximum(Math.max(scenario.startingPrincipal, ...points.map((p) => p.balance), 1) * 1.08);
  const flowMax = niceMaximum(Math.max(...points.map((p) => p.withdrawal || 0), 1) * 1.08);
  const x = (year) => margin.left + (year / years) * plotWidth;
  const yAsset = (value) => margin.top + (1 - clamp(value / assetMax, 0, 1)) * plotHeight;
  const yFlow = (value) => margin.top + (1 - clamp(value / flowMax, 0, 1)) * plotHeight;
  const zeroY = yAsset(0);
  const linePath = (coords) => coords.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(2)},${p[1].toFixed(2)}`).join(" ");
  const assetPath = linePath(points.map((p) => [x(p.year), yAsset(p.balance)]));
  const areaPath = `${assetPath} L${x(years).toFixed(2)},${zeroY.toFixed(2)} L${x(0).toFixed(2)},${zeroY.toFixed(2)} Z`;
  const withdrawalPath = linePath(points.slice(1).map((p) => [x(p.year), yFlow(p.withdrawal || 0)]));

  const yTicks = Array.from({ length: 5 }, (_, i) => (assetMax / 4) * i);
  const flowTicks = Array.from({ length: 5 }, (_, i) => (flowMax / 4) * i);
  const candidateSteps = [5, 10, 20, 50];
  const xStep = candidateSteps.find((step) => years / step <= 6) || 20;
  const xTicks = [];
  for (let year = 0; year < years; year += xStep) xTicks.push(year);
  if (xTicks[xTicks.length - 1] !== years) xTicks.push(years);

  const depletionX = scenario.depletionYear !== null ? x(scenario.depletionYear) : null;
  const crisisEndX = Math.min(scenario.crisisYears, years);
  const gkDots = points.filter((p) => p.gkApplied).map((p) =>
    `<circle class="stress-gk-dot" cx="${x(p.year).toFixed(2)}" cy="${yAsset(p.balance).toFixed(2)}" r="3.2"/>`).join("");

  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <defs>
      <linearGradient id="stressGradient" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#a5772a" stop-opacity=".18"/>
        <stop offset="100%" stop-color="#a5772a" stop-opacity=".015"/>
      </linearGradient>
    </defs>
    <g aria-hidden="true">
      ${yTicks.map((tick, i) => `
        <line class="chart-grid" x1="${margin.left}" y1="${yAsset(tick)}" x2="${width - margin.right}" y2="${yAsset(tick)}"/>
        <text class="chart-axis-label" x="${margin.left - 8}" y="${yAsset(tick) + 3}" text-anchor="end">${formatAxis(tick)}</text>
        <text class="chart-axis-label chart-axis-right" x="${width - margin.right + 8}" y="${yFlow(flowTicks[i]) + 3}" text-anchor="start">${formatAxis(flowTicks[i])}</text>
      `).join("")}
      ${xTicks.map((tick) => `<text class="chart-axis-label" x="${x(tick)}" y="${height - 10}" text-anchor="middle">${tick === 0 ? "现在" : `${tick} 年`}</text>`).join("")}
      ${crisisEndX > 0 ? `<rect class="stress-crisis-band" x="${x(0).toFixed(2)}" y="${margin.top}" width="${(x(crisisEndX) - x(0)).toFixed(2)}" height="${plotHeight}"/>` : ""}
      <path class="chart-area" d="${areaPath}"/>
      <line class="chart-principal-path" x1="${margin.left}" y1="${yAsset(scenario.startingPrincipal)}" x2="${width - margin.right}" y2="${yAsset(scenario.startingPrincipal)}"/>
      <path class="chart-expense-path" d="${withdrawalPath}"/>
      <path class="chart-asset-path" d="${assetPath}"/>
      ${depletionX !== null ? `
        <line class="stress-depletion-line" x1="${depletionX.toFixed(2)}" y1="${margin.top}" x2="${depletionX.toFixed(2)}" y2="${zeroY.toFixed(2)}"/>
        <circle class="stress-depletion-dot" cx="${depletionX.toFixed(2)}" cy="${zeroY.toFixed(2)}" r="4.5"/>
        <text class="stress-depletion-text" x="${(depletionX > width - 120 ? depletionX - 8 : depletionX + 8).toFixed(2)}" y="${(margin.top + 12).toFixed(2)}" text-anchor="${depletionX > width - 120 ? "end" : "start"}">第 ${scenario.depletionYear} 年耗尽</text>` : ""}
      ${gkDots}
      ${scenario.crisisYears > 0 ? `<text class="stress-crisis-label" x="${(x(crisisEndX / 2)).toFixed(2)}" y="${(margin.top + 12).toFixed(2)}" text-anchor="middle">危机期</text>` : ""}
    </g>
  `;
}

function renderStressInsight(scenario, comparison) {
  const insight = $("stressInsight");
  const alerts = scenario.alerts;
  const survivalText = scenario.depletionYear === null
    ? `全程无缺口${scenario.isEndowment && !scenario.survived ? "，但期末购买力已低于起点" : ""}`
    : `资产在第 <strong>${scenario.depletionYear} 年</strong>耗尽`;
  const worstText = comparison.worst
    ? `全部场景中最严峻的是「${comparison.worst.scenario.label}」：期末仅剩 <strong>${formatMoney(comparison.worst.endBalance)}</strong>${comparison.worst.depletionYear !== null ? `（第 ${comparison.worst.depletionYear} 年耗尽）` : ""}。`
    : "";
  const gkText = scenario.gkAppliedCount > 0
    ? `提取率护栏在危机中共触发 <strong>${scenario.gkAppliedCount} 次</strong>减提，为路径省下了宝贵的资产。`
    : (state.stressGuytonKlinger ? "提取率护栏已开启，本场景未触发减提（提取率未超标）。" : "");
  const baselineDelta = comparison.baseline ? scenario.endBalance - comparison.baseline.endBalance : 0;
  insight.innerHTML = `
    <strong>${scenario.scenario.label}</strong>：${scenario.scenario.description}
    当前方案在此冲击下${survivalText}，期末资产 ${formatMoney(scenario.endBalance)}（比无冲击基线${baselineDelta >= 0 ? "高" : "低"} ${formatMoney(Math.abs(baselineDelta))}）。${gkText} ${worstText}
    <span class="stress-insight-note">${scenario.scenario.note}</span>`;
}

function renderStress(result) {
  if (!$("stressChart")) return;
  const comparison = runStressComparison({
    fireResult: result,
    fireInput: state,
    startingPrincipal: result.chartStart,
    guytonKlinger: state.stressGuytonKlinger,
    customShock: isCustomStressScenario() ? stressShockParams() : null
  });
  latestStress = comparison;

  // 详情区展示当前选中场景；自定义时取 custom，否则取对应预设。
  const scenario = isCustomStressScenario()
    ? comparison.scenarios.find((item) => item.scenarioId === "custom")
    : comparison.scenarios.find((item) => item.scenarioId === state.stressScenario);
  if (!scenario) return;

  setText("stressBadge", `${STRESS_ENGINE_VERSION} · ${scenario.scenario.label}`, false);
  setText("stressLead", `危机统一假设从 FIRE 第 1 年爆发——这是顺序风险最不利的情形：资产在最厚的时刻遭遇最深的跌幅。${scenario.isEndowment ? "当前为金鹅永续口径：存续同时要求期末购买力不减。" : ""}`, false);

  renderStressKpis(scenario);
  renderStressAlert(scenario);
  renderStressBuckets(scenario);
  renderStressTable(comparison);
  renderStressChart(scenario);
  renderStressInsight(scenario, comparison);
}

function renderStressIfReady() {
  if (!stressInitialized) {
    stressInitialized = true;
    renderStress(latestResult);
  } else {
    // 与蒙特卡洛同款防抖：拖动滑杆时不反复回放 50 年路径。
    window.clearTimeout(stressTimer);
    const token = ++stressSequence;
    stressTimer = window.setTimeout(() => {
      if (token === stressSequence && latestResult) renderStress(latestResult);
    }, 180);
  }
}

function renderFailureAttribution(mc) {
  const wrap = $("mcAttribution");
  if (!wrap) return;
  const attr = mc.failureAttribution;
  if (!attr || attr.failedCount === 0) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;

  const gapText = attr.geoGap !== null && attr.geoGap > 0
    ? `失败路径的几何年化收益平均为 <strong>${formatPercent(attr.geoFailed * 100)}</strong>，明显低于成功路径的 <strong>${formatPercent(attr.geoSuccess * 100)}</strong>（差 ${(attr.geoGap * 100).toFixed(1)} 个百分点）。`
    : `失败与成功路径的收益水平接近，失败更多源于发生时点而非平均收益。`;
  $("mcAttrLead").innerHTML = `${attr.failedCount.toLocaleString("zh-CN")} 条路径未能走完。${gapText}主因分布如下（每条失败路径只归入一类，合计 100%）：`;

  const primaryColors = {
    return: "var(--ink-soft)", order: "var(--red)", tail: "var(--orange)",
    expense: "var(--gold)", principal: "var(--teal)"
  };
  const renderBars = (items, colorOf, labelOf, noteOf) => items
    .filter((item) => item.share > 0.0005)
    .map((item) => {
      const pct = (item.share * 100).toFixed(0);
      const color = colorOf(item);
      return `<div class="mc-attr-row">
        <div class="mc-attr-row-head"><span>${labelOf(item)}</span><strong>${pct}%</strong></div>
        <div class="mc-attr-track"><div class="mc-attr-fill" style="width:${Math.max(1, item.share * 100).toFixed(1)}%;background:${color}"></div></div>
        ${noteOf(item) ? `<div class="mc-attr-note">${noteOf(item)}</div>` : ""}
      </div>`;
    }).join("") || '<div class="mc-attr-none">无显著项</div>';

  $("mcAttrPrimary").innerHTML = renderBars(
    attr.primary,
    (item) => primaryColors[item.key] || "var(--ink-soft)",
    (item) => item.label,
    () => ""
  );
  // 可控杠杆排在前面，市场类假设排在后面；各自组内按救活率排序。
  const controlRank = { expense: 0, principal: 1, volatility: 2, order: 3 };
  const orderedRemedies = [...attr.remedies].sort(
    (a, b) => controlRank[a.key] - controlRank[b.key] || b.share - a.share
  );
  $("mcAttrRemedies").innerHTML = orderedRemedies.map((item) => {
    const pct = (item.share * 100).toFixed(0);
    const controllable = item.key === "expense" || item.key === "principal";
    const badge = controllable ? '<span class="mc-attr-badge">可主动调整</span>' : '<span class="mc-attr-badge muted">市场假设</span>';
    return `<div class="mc-attr-row">
      <div class="mc-attr-row-head"><span>${item.label}${badge}</span><strong>${pct}%</strong></div>
      <div class="mc-attr-track"><div class="mc-attr-fill" style="width:${Math.max(1, item.share * 100).toFixed(1)}%;background:var(--teal)"></div></div>
      <div class="mc-attr-note">${item.note} · 救回 ${item.rescued.toLocaleString("zh-CN")} 条</div>
    </div>`;
  }).join("");

  const top = attr.primary[0];
  const actionable = attr.remedies.filter((r) => r.key === "expense" || r.key === "principal");
  const bestActionable = actionable.sort((a, b) => b.share - a.share)[0];
  setText("mcAttrFoot", `最主要失败原因：${top.label}（${(top.share * 100).toFixed(0)}%）。收益与顺序属市场不可控；可主动调整的杠杆中，${bestActionable.label}可救回约 ${(bestActionable.share * 100).toFixed(0)}% 的失败路径。此归因仅为诊断，不代表收益可被人为调节。`, false);
}

// ===== 页面自定义组合：存 localStorage、随方案快照导出，新增组合无需改代码 =====
// （CUSTOM_PROFILES_STORAGE_KEY 与 BUILTIN_HOLDINGS_NOTE 声明在文件顶部，避免 TDZ）

function loadCustomProfiles() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CUSTOM_PROFILES_STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item && item.key && item.label) : [];
  } catch (error) {
    return [];
  }
}

function saveCustomProfiles() {
  try {
    localStorage.setItem(CUSTOM_PROFILES_STORAGE_KEY, JSON.stringify(state.mcCustomProfiles));
  } catch (error) {
    // 持久化失败时组合仍在当前页面生效，仅不写入浏览器存储。
  }
}

function customProfileMap() {
  return Object.fromEntries(state.mcCustomProfiles.map((profile) => [profile.key, profile]));
}

// 组装自定义组合 profile：calibrated 口径，模拟只用 cagr 与 volatility，其余字段仅展示。
function buildCustomProfile({ key, name, cagr, volatility, maxDrawdown, sharpe, period, holdings }) {
  const profile = {
    key,
    label: name,
    calibrated: true,
    custom: true,
    note: "页面自定义组合",
    sigma: volatility,
    backtest: { period: period || "自定义参数", cagr, volatility }
  };
  if (Number.isFinite(maxDrawdown)) profile.backtest.maxDrawdown = maxDrawdown;
  if (Number.isFinite(sharpe)) profile.backtest.sharpe = sharpe;
  const rows = (Array.isArray(holdings) ? holdings : [])
    .map((row) => ({ name: row.name, fund: row.fund || "自定义持仓", group: "custom", weight: row.weight }))
    .filter((row) => row.name && Number.isFinite(row.weight) && row.weight > 0);
  if (rows.length > 0) profile.holdings = rows;
  return profile;
}

function renderCustomProfileButtons() {
  const wrap = $("mcCustomProfileButtons");
  if (!wrap) return;
  wrap.innerHTML = state.mcCustomProfiles.map((profile) => `
    <button type="button" data-mc-profile="${profile.key}" title="自定义组合：${profile.label}">${profile.label}</button>`).join("");
  wrap.querySelectorAll("[data-mc-profile]").forEach((button) => {
    button.addEventListener("click", () => {
      state.mcProfile = button.dataset.mcProfile;
      syncMonteCarloControls();
      scheduleMonteCarlo();
    });
  });
  syncMonteCarloControls();
}

function renderSavedProfiles() {
  const block = $("cpSavedBlock");
  const list = $("cpSavedList");
  if (!block || !list) return;
  block.hidden = state.mcCustomProfiles.length === 0;
  list.innerHTML = state.mcCustomProfiles.map((profile) => {
    const backtest = profile.backtest || {};
    return `<div class="cp-saved-row">
      <span class="cp-saved-name">${profile.label}</span>
      <span class="cp-saved-stats">CAGR ${formatPercent(backtest.cagr ?? 0)} · σ ${formatPercent(backtest.volatility ?? 0)}</span>
      <button type="button" class="cp-saved-delete" data-cp-delete="${profile.key}">删除</button>
    </div>`;
  }).join("");
}

function deleteCustomProfile(key) {
  const target = state.mcCustomProfiles.find((profile) => profile.key === key);
  if (!target) return;
  state.mcCustomProfiles = state.mcCustomProfiles.filter((profile) => profile.key !== key);
  saveCustomProfiles();
  if (state.mcProfile === key) {
    state.mcProfile = "portfolioA";
    scheduleMonteCarlo();
  }
  renderCustomProfileButtons();
  renderSavedProfiles();
  showToast(`已删除「${target.label}」`);
}

function addCpHoldingRow(name = "", weight = "") {
  const row = document.createElement("div");
  row.className = "cp-holding-row";
  row.innerHTML = `
    <input type="text" class="cp-holding-name" maxlength="30" placeholder="资产名称" value="${name}">
    <input type="number" class="cp-holding-weight" min="0" max="100" step="0.1" placeholder="权重 %" value="${weight}">
    <button type="button" class="cp-holding-remove" aria-label="删除该行">✕</button>`;
  row.querySelector(".cp-holding-remove").addEventListener("click", () => row.remove());
  $("cpHoldingsRows").appendChild(row);
}

function openCpModal() {
  $("cpName").value = "";
  $("cpCagr").value = "";
  $("cpVol").value = "";
  $("cpMdd").value = "";
  $("cpSharpe").value = "";
  $("cpPeriod").value = "";
  $("cpHoldingsRows").innerHTML = "";
  renderSavedProfiles();
  $("cpModalOverlay").hidden = false;
}

function closeCpModal() {
  const overlay = $("cpModalOverlay");
  if (overlay) overlay.hidden = true;
}

function saveCustomProfileFromForm() {
  const name = $("cpName").value.trim();
  const cagr = Number($("cpCagr").value);
  const volatility = Number($("cpVol").value);
  if (!name) {
    showToast("请填写组合名称");
    return;
  }
  if (!Number.isFinite(cagr) || cagr <= -100 || cagr > 100) {
    showToast("请填写有效的年化收益 CAGR（%）");
    return;
  }
  if (!Number.isFinite(volatility) || volatility < 0 || volatility > 100) {
    showToast("请填写有效的年化波动率 σ（%），可由夏普反推：σ ≈ (CAGR − 无风险利率) ÷ 夏普");
    return;
  }
  const mddText = $("cpMdd").value.trim();
  const sharpeText = $("cpSharpe").value.trim();
  const mdd = mddText !== "" ? Number(mddText) : NaN;
  const sharpe = sharpeText !== "" ? Number(sharpeText) : NaN;
  const holdings = [...$("cpHoldingsRows").querySelectorAll(".cp-holding-row")].map((row) => ({
    name: row.querySelector(".cp-holding-name").value.trim(),
    weight: Number(row.querySelector(".cp-holding-weight").value)
  })).filter((row) => row.name && Number.isFinite(row.weight) && row.weight > 0);
  const key = `custom-${Date.now()}`;
  const profile = buildCustomProfile({
    key,
    name,
    cagr,
    volatility,
    maxDrawdown: Number.isFinite(mdd) ? mdd : null,
    sharpe: Number.isFinite(sharpe) ? sharpe : null,
    period: $("cpPeriod").value.trim(),
    holdings
  });
  state.mcCustomProfiles.push(profile);
  saveCustomProfiles();
  renderCustomProfileButtons();
  state.mcProfile = key;
  syncMonteCarloControls();
  scheduleMonteCarlo();
  closeCpModal();
  showToast(`自定义组合「${name}」已保存并启用`);
}

function renderMonteCarlo(result) {
  if (!$("mcHistogram")) return;
  const mc = runMonteCarlo({
    fireResult: result,
    fireInput: state,
    profileKey: state.mcProfile,
    runs: state.mcRuns,
    seed: 20261119,
    startingPrincipal: result.chartStart,
    expenseFlexibility: state.mcFlexibility,
    withAttribution: true,
    withBucketPaths: true,
    customProfiles: customProfileMap()
  });
  latestMc = mc;

  setText("mcBadge", `${mc.runs.toLocaleString("zh-CN")} 次模拟 · ${mc.profile.label}`, false);
  const dividendTag = state.dividendEnabled
    ? "已计入页面红利退休金；"
    : "未计入页面红利退休金（红利面板当前 Disable）；";
  const leadByCurve = `全盘口径起点取${state.curveSource === "target" ? "反推目标" : "我的本金"} ${formatMoney(mc.startingPrincipal)}。固定种子 ${mc.seed}，结果可完全复现。`;
  const genericLead = `以当前年化 ${formatPercent(state.returnRate)} 为收益中枢，按 ${mc.profile.label} 的波动率 ${formatPercent(mc.sigma * 100)} 生成 ${mc.years} 年随机路径。${dividendTag}${leadByCurve}`;
  const bt = mc.profile.backtest || {};
  const periodLead = mc.profile.custom
    ? `按自定义参数校准${bt.period && bt.period !== "自定义参数" ? `（${bt.period}）` : ""}`
    : `按 ${bt.period} 回测校准`;
  const histParts = [`历史组合 CAGR ${formatPercent(bt.cagr ?? mc.mu * 100)}`];
  if (Number.isFinite(bt.maxDrawdown)) histParts.push(`最大回撤 ${formatPercent(bt.maxDrawdown)}`);
  if (Number.isFinite(bt.sharpe)) histParts.push(`夏普 ${bt.sharpe.toFixed(2)}`);
  const etfHint = bt.period === MC_PROFILE_GROUPS.etfSample ? "该组合采用 ETF 上市以来短样本，与 2011 年起样本的版本不可直接横比；" : "";
  const customHint = mc.profile.custom ? "该组合参数由页面填写，模拟只用年化收益与波动率两个数字；" : "";
  setText("mcLead", mc.holdings
    ? (mc.profile.calibrated
      ? `${periodLead}：组合年化中枢 ${formatPercent(mc.mu * 100)}、年波动率 ${formatPercent(mc.sigma * 100)}；${histParts.join("、")}。${customHint}${etfHint}${dividendTag}${leadByCurve}`
      : genericLead)
    : genericLead, false);

  const holdingsWrap = $("mcHoldings");
  if (mc.holdings) {
    holdingsWrap.hidden = false;
    const showAssumptions = !mc.profile.calibrated;
    $("mcHoldingsTable").innerHTML = `
      <thead><tr><th>持仓</th><th>标的 / 基金</th><th>权重</th>${showAssumptions ? "<th>示意年化</th><th>示意波动</th>" : ""}</tr></thead>
      <tbody>${mc.holdings.map((item) => `
        <tr>
          <td>${item.name}</td>
          <td>${item.fund}</td>
          <td>${item.weight.toFixed(1)}%</td>
          ${showAssumptions ? `<td>${formatPercent(item.mu)}</td><td>${formatPercent(item.sigma)}</td>` : ""}
        </tr>`).join("")}</tbody>`;
    const holdingsNote = $("mcHoldingsNote");
    if (holdingsNote) {
      holdingsNote.textContent = mc.profile.custom
        ? "持仓权重仅作展示，模拟按上方组合级参数（年化收益 + 年化波动率）进行；权重按填写值显示，未强制合计 100%。"
        : BUILTIN_HOLDINGS_NOTE;
    }
  } else {
    holdingsWrap.hidden = true;
    $("mcHoldingsTable").innerHTML = "";
  }

  $("mcParams").innerHTML = [
    ["收益中枢 μ", formatPercent(mc.mu * 100)],
    ["年波动率 σ", formatPercent(mc.sigma * 100)],
    ["失败路径", `${mc.failedCount.toLocaleString("zh-CN")} 条`],
    ["引擎版本", MC_ENGINE_VERSION]
  ].map(([label, value]) => `<article><span>${label}</span><strong>${value}</strong></article>`).join("");

  const successRate = mc.successRate;
  const rateClass = successRate >= 0.9 ? "good" : successRate < 0.75 ? "warn" : "";
  $("mcKpis").className = `fund-results mc-kpis ${rateClass}`;
  $("mcKpis").innerHTML = `
    <article><span>${mc.years} 年存续成功率</span><strong>${(successRate * 100).toFixed(1)}%</strong><p>金鹅永续模式同时要求期末购买力不减</p></article>
    <article><span>P10 期末资产</span><strong>${formatMoney(mc.p10End)}</strong><p>较差 10% 路径的期末资产</p></article>
    <article><span>P50 期末资产</span><strong>${formatMoney(mc.p50End)}</strong><p>中位数路径的期末资产</p></article>
    <article><span>P90 期末资产</span><strong>${formatMoney(mc.p90End)}</strong><p>较好 10% 路径的期末资产</p></article>`;

  $("mcDistTable").innerHTML = `
    <thead><tr><th>分位</th><th>期末资产</th><th>路径最低资产</th></tr></thead>
    <tbody>
      <tr><td>P1（最差 1%）</td><td>${formatMoney(mc.p1End)}</td><td>—</td></tr>
      <tr><td>P5（压力情景）</td><td>${formatMoney(mc.p5End)}</td><td>—</td></tr>
      <tr><td>P10（较差 10%）</td><td>${formatMoney(mc.p10End)}</td><td>${formatMoney(mc.p10Min)}</td></tr>
      <tr><td>P25（偏保守）</td><td>${formatMoney(mc.p25End)}</td><td>${formatMoney(mc.p25Min)}</td></tr>
      <tr><td>P50（中位数）</td><td>${formatMoney(mc.p50End)}</td><td>${formatMoney(mc.p50Min)}</td></tr>
      <tr><td>P75（偏好）</td><td>${formatMoney(mc.p75End)}</td><td>${formatMoney(mc.p75Min)}</td></tr>
      <tr><td>P90（较好 10%）</td><td>${formatMoney(mc.p90End)}</td><td>${formatMoney(mc.p90Min)}</td></tr>
    </tbody>`;

  const pctTip = $("mcPercentileTip");
  if (pctTip) {
    pctTip.innerHTML = `
      <strong>怎么读这些分位数</strong>
      <p>每一行都是「第 ${mc.years} 年最后一天」的资产快照：把 ${mc.runs.toLocaleString("zh-CN")} 条路径的期末余额排序后取对应位置。<strong>P10</strong> 决定这套方案能否承受较差情景（安全边际）；<strong>P25</strong> 判断抗风险能力是否充足；<strong>P50</strong> 评估正常情况下的退休生活水平；<strong>P5</strong> 用于压力测试——它比 P10 更接近最坏结局；<strong>P90</strong> 则展示运气偏好时的上行空间。</p>
      <p>两点口径提醒：失败路径从耗尽那年起期末余额为 0，因此当失败率 ≥ 10% 时 P10、≥ 25% 时 P25 会显示为 0，此时请结合「${mc.years} 年存续成功率」与耗尽年份分布解读；「路径最低资产」是该分位路径<b>历史上最深跌到的低点</b>，比期末值更能反映过程中的持有体验。</p>
    `;
  }

  const svg = $("mcHistogram");
  const width = Math.max(260, svg.clientWidth || 420);
  const height = 180;
  const margin = { top: 14, right: 10, bottom: 26, left: 34 };
  const maxCount = Math.max(...mc.buckets.map((bucket) => bucket.count), 1);
  const barWidth = (width - margin.left - margin.right) / mc.buckets.length;
  svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
  svg.innerHTML = `
    <line x1="${margin.left}" y1="${height - margin.bottom}" x2="${width - margin.right}" y2="${height - margin.bottom}" stroke="var(--line)"/>
    ${mc.buckets.map((bucket, index) => {
      const barHeight = (height - margin.top - margin.bottom) * (bucket.count / maxCount);
      const barX = margin.left + index * barWidth + barWidth * 0.15;
      const centerX = margin.left + index * barWidth + barWidth / 2;
      const clickable = bucket.count > 0 && mc.bucketPaths?.[index];
      const barClass = clickable ? 'class="mc-hist-bar" tabindex="0" role="button" aria-label="查看${bucket.label}区间典型失败路径"' : "";
      const clickAttr = clickable ? ` data-bucket="${index}"` : "";
      return `<g ${barClass}${clickAttr}>
        <rect x="${barX.toFixed(1)}" y="${(height - margin.bottom - barHeight).toFixed(1)}" width="${(barWidth * 0.7).toFixed(1)}" height="${Math.max(0, barHeight).toFixed(1)}" fill="var(--red)" opacity=".7" rx="3"/>
        <text x="${centerX.toFixed(1)}" y="${height - 8}" text-anchor="middle" fill="var(--muted)" font-size="9">${bucket.label}</text>
        ${bucket.count > 0 ? `<text x="${centerX.toFixed(1)}" y="${(height - margin.bottom - barHeight - 4).toFixed(1)}" text-anchor="middle" fill="var(--ink-soft)" font-size="9">${bucket.count}</text>` : ""}
      </g>`;
    }).join("")}`;

  svg.querySelectorAll(".mc-hist-bar").forEach((node) => {
    const open = () => openBucketModal(Number(node.dataset.bucket));
    node.addEventListener("click", open);
    node.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        open();
      }
    });
  });

  renderFailureAttribution(mc);

  const error = mc.conservationMaxError;
  const conservation = $("mcConservation");
  conservation.className = `mc-conservation ${error < 0.01 ? "ok" : "bad"}`;
  let note = successRate >= 0.9
    ? "成功率较高，当前起点对该波动假设有较厚安全边际。"
    : successRate >= 0.75
      ? "成功率中等，可考虑提高本金、降低支出或开启支出弹性。"
      : "成功率偏低：按该波动假设，较多路径会在测算期内耗尽，需要重点审视。";
  if (state.mcFlexibility && mc.flexAppliedCount > 0) {
    note += ` 支出弹性共触发 ${mc.flexAppliedCount} 次。`;
  }
  conservation.textContent = `${note} 资金守恒校验：${mc.runs.toLocaleString("zh-CN")} 条路径逐年误差最大 ${error.toFixed(4)} 元。`;
  if (!leverInitialized) {
    leverInitialized = true;
    window.setTimeout(() => runLeverAnalysis(800, { prefillGap: true }), 60);
  }
}

function runLeverAnalysis(runs = 1500, { prefillGap = false } = {}) {
  if (leverBusy || !latestResult || !$("runLeverAnalysis")) return;
  leverBusy = true;
  const button = $("runLeverAnalysis");
  button.disabled = true;
  button.textContent = "计算中…";
  window.setTimeout(() => {
    try {
      const analysis = analyzeSuccessLevers({
        fireResult: latestResult,
        fireInput: state,
        targetRate: state.mcTargetRate,
        runs,
        seed: 20261119,
        startingPrincipal: latestResult.chartStart,
        profileKey: state.mcProfile,
        customProfiles: customProfileMap(),
        selection: {
          params: leverSelection.params,
          checked: leverSelection.checked,
          dividendIncome: leverSelection.checked.dividendIncome,
          expenseFlexibility: leverSelection.checked.flexibility,
          flexibilityStrong: leverSelection.checked.flexibilityStrong
        }
      });
      // 首次进入时用当前缺口预填「提高初始本金」，仅一次，之后尊重用户输入。
      if (prefillGap && !leverSelection.params.extraPrincipal) {
        const suggested = defaultExtraPrincipal(analysis);
        if (suggested > 0) {
          leverSelection.params.extraPrincipal = suggested;
          return runLeverAnalysis(runs);
        }
      }
      renderLeverAnalysis(analysis);
    } catch (error) {
      $("leverBadge").textContent = "计算失败";
    } finally {
      leverBusy = false;
      button.disabled = false;
      button.textContent = "重新计算";
    }
  }, 20);
}

// 「提高初始本金」默认预填：当前本金到目标胜率所需本金的缺口，向上取整到 5 万。
function defaultExtraPrincipal(analysis) {
  const gap = Number(analysis?.gap) || 0;
  if (gap <= 1) return 0;
  return Math.ceil(gap / 50000) * 50000;
}

function buildLeverOptions(analysis) {
  const wrap = $("leverOptions");
  if (!wrap) return;
  const meta = [
    { key: "expenseCut", name: "支出降低", paramKey: "expenseCutPct", unit: "%", min: 1, max: 90, step: 1 },
    { key: "extraIncome", name: "每月额外收入", paramKey: "extraMonthlyIncome", unit: "元/月", min: 100, max: 100000, step: 100 },
    {
      key: "bridge", name: "过渡期兼职收入", fields: [
        { paramKey: "bridgeMonthly", unit: "元/月", min: 100, max: 50000, step: 100 },
        { paramKey: "bridgeYears", unit: "年", min: 1, max: 20, step: 1 }
      ]
    },
    { key: "delay", name: "推迟 FIRE", paramKey: "delayYears", unit: "年", min: 1, max: 30, step: 1 },
    { key: "extraPrincipal", name: "提高初始本金", paramKey: "extraPrincipal", unit: "元", min: 10000, max: 20000000, step: 10000 }
  ];
  const fixed = [
    { key: "dividendIncome", name: "计入页面红利退休金" },
    { key: "flexibility", name: "开启支出弹性" },
    { key: "flexibilityStrong", name: "支出弹性·强化档" }
  ];
  const leverByKey = {};
  for (const lever of analysis.levers) leverByKey[lever.key] = lever;
  const rateHtml = (lever) => {
    if (!lever) return "";
    const delta = lever.successRate - analysis.baselineSuccessRate;
    const deltaText = `${delta >= 0 ? "+" : ""}${(delta * 100).toFixed(1)}pp`;
    const isBaseline = Math.abs(delta) < 0.0005;
    return `<span class="lever-option-rate ${isBaseline ? "" : delta > 0 ? "up" : ""}">${(lever.successRate * 100).toFixed(1)}%<span class="delta">${isBaseline ? "基线" : deltaText}</span></span>`;
  };
  const rows = [];
  for (const item of meta) {
    const lever = leverByKey[item.key];
    const checkedState = Boolean(leverSelection.checked[item.key]);
    const fields = item.fields ?? [{ paramKey: item.paramKey, unit: item.unit, min: item.min, max: item.max, step: item.step }];
    const fieldsHtml = fields.map((field) => `
          <input type="number" data-lever-param="${field.paramKey}" value="${leverSelection.params[field.paramKey]}" min="${field.min}" max="${field.max}" step="${field.step}" aria-label="${item.name}参数">
          <span class="unit">${field.unit}</span>`).join("");
    rows.push(`
      <label class="lever-option ${checkedState ? "checked" : ""}" data-lever-key="${item.key}">
        <input type="checkbox" data-lever-check="${item.key}" ${checkedState ? "checked" : ""}>
        <span class="lever-option-main">
          <span class="lever-option-name">${item.name}</span>
          <span class="lever-option-detail">${lever?.detail ?? ""}</span>
        </span>
        <span class="lever-option-params">${fieldsHtml}
        </span>
        ${rateHtml(lever)}
      </label>`);
  }
  for (const item of fixed) {
    const lever = leverByKey[item.key];
    const checkedState = Boolean(leverSelection.checked[item.key]);
    rows.push(`
      <label class="lever-option ${checkedState ? "checked" : ""}" data-lever-key="${item.key}">
        <input type="checkbox" data-lever-check="${item.key}" ${checkedState ? "checked" : ""}>
        <span class="lever-option-main">
          <span class="lever-option-name">${item.name}</span>
          <span class="lever-option-detail">${lever?.detail ?? ""}</span>
        </span>
        ${rateHtml(lever)}
      </label>`);
  }
  wrap.innerHTML = rows.join("");
}

function renderLeverCombined(analysis) {
  const wrap = $("leverCombined");
  if (!wrap) return;
  const combined = analysis.combined;
  if (!analysis.hasSelection || !combined) {
    wrap.hidden = true;
    wrap.innerHTML = "";
    $("profileTableTitle").textContent = "资产配置对比（当前本金）";
    return;
  }
  wrap.hidden = false;
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  const gapText = combined.gap > 1 ? formatMoney(combined.gap) : "已达标";
  wrap.innerHTML = `
    <div class="combined-head">
      <span class="combined-title">勾选组合后的方案</span>
      <span class="combined-details">${combined.details.join(" · ") || "—"}</span>
    </div>
    <div class="combined-kpis">
      <article><span>组合后成功率</span><strong class="teal">${pct(combined.successRate)}</strong></article>
      <article><span>较当前提升</span><strong class="teal">${combined.improvement >= 0 ? "+" : ""}${(combined.improvement * 100).toFixed(1)}pp</strong></article>
      <article><span>达标所需本金</span><strong>${formatMoney(combined.targetPrincipal)}</strong></article>
      <article><span>距离目标缺口</span><strong>${gapText}</strong></article>
    </div>`;
  $("profileTableTitle").textContent = "资产配置对比（组合口径）";
}

function renderLeverOptions(analysis) {
  buildLeverOptions(analysis);
  renderLeverCombined(analysis);
}

function syncLeverOptionVisuals() {
  document.querySelectorAll(".lever-option[data-lever-key]").forEach((label) => {
    const key = label.dataset.leverKey;
    label.classList.toggle("checked", Boolean(leverSelection.checked[key]));
    const box = label.querySelector("input[type='checkbox']");
    if (box) box.checked = Boolean(leverSelection.checked[key]);
  });
  // 勾选状态变化即时重算（不打断输入框编辑）；参数输入由独立的防抖逻辑处理。
  runLeverAnalysis();
}

function onLeverParamInput(event) {
  const input = event.target.closest("input[data-lever-param]");
  if (!input) return;
  const key = input.dataset.leverParam;
  const parsed = Number(input.value);
  leverSelection.params[key] = Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
  window.clearTimeout(leverParamsTimer);
  leverParamsTimer = window.setTimeout(() => runLeverAnalysis(), 600);
}

function renderLeverAnalysis(analysis) {
  const pct = (value) => `${(value * 100).toFixed(1)}%`;
  setText("leverBadge", `目标 ${(analysis.targetRate * 100).toFixed(0)}% · ${analysis.required.runs.toLocaleString("zh-CN")} 条路径`, false);
  $("leverHero").innerHTML = `
    <article><span>当前方案成功率</span><strong>${pct(analysis.baselineSuccessRate)}</strong><p>当前本金 ${formatMoney(analysis.currentPrincipal)}</p></article>
    <article><span>达标所需本金</span><strong>${formatMoney(analysis.targetPrincipal)}</strong><p>按 ${(analysis.targetRate * 100).toFixed(0)}% 分位反推</p></article>
    <article><span>距离目标缺口</span><strong>${analysis.gap > 1 ? formatMoney(analysis.gap) : "已达标"}</strong><p>${analysis.gap > 1 ? "需要补足的投资本金" : "当前本金已覆盖目标胜率"}</p></article>`;

  renderLeverOptions(analysis);

  $("profileTable").innerHTML = `
    <thead><tr><th>资产配置</th><th>成功率</th></tr></thead>
    <tbody>${analysis.profiles.map((profile) => `
      <tr class="${profile.successRate === Math.max(...analysis.profiles.map((item) => item.successRate)) ? "best-row" : ""}">
        <td>${profile.label}</td><td>${pct(profile.successRate)}</td>
      </tr>`).join("")}</tbody>`;
}

function syncScenarioButtons() {
  document.querySelectorAll(".scenario-option").forEach((button) => {
    button.classList.toggle("active", button.dataset.scenario === state.scenario);
    button.setAttribute("aria-pressed", button.dataset.scenario === state.scenario ? "true" : "false");
  });
}

function syncCurveSourceButtons() {
  document.querySelectorAll("[data-curve-source]").forEach((button) => {
    const active = button.dataset.curveSource === state.curveSource;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

// 全盘口径切换：现金流曲线、储备计划、蒙特卡洛与杠杆分析全部重算。
function setCurveSource(source) {
  if (state.curveSource === source) return;
  state.curveSource = source;
  syncCurveSourceButtons();
  updateAll();
  showToast(source === "target" ? "已切换为反推目标口径" : "已切换为我的本金口径");
}

// 手动修改本金时自动切到「我的本金」，否则页面会继续按反推目标计算，输入看起来没生效。
function applyPrincipalChange() {
  if (state.curveSource !== "principal") setCurveSource("principal");
  else updateAll();
}

function syncMedicalControls() {
  document.querySelectorAll("[data-medical-tier]").forEach((button) => {
    const active = Number(button.dataset.medicalTier) === state.medicalReserve;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  $("medicalReserveInput").value = state.medicalReserve;
}

function syncDividendControls() {
  document.querySelectorAll("[data-dividend-enabled]").forEach((button) => {
    const active = (button.dataset.dividendEnabled === "true") === state.dividendEnabled;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  document.querySelectorAll("[data-dividend-mode]").forEach((button) => {
    const active = button.dataset.dividendMode === state.dividendMode;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  document.querySelectorAll("[data-dca-inflation]").forEach((button) => {
    const active = (button.dataset.dcaInflation === "true") === state.dcaInflationAdjust;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

// 仅同步储备利率快捷按钮高亮，不改写输入框（避免输入小数时被中断）。
function syncReserveRateButtons() {
  document.querySelectorAll("[data-reserve-rate]").forEach((button) => {
    const active = Number(button.dataset.reserveRate) === state.reserveReturnRate;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
}

function syncMonteCarloControls() {
  const groups = [
    ["[data-mc-profile]", "mcProfile", "mcProfile"],
    ["[data-mc-runs]", "mcRuns", "mcRuns", Number],
    ["[data-mc-flex]", "mcFlexibility", "mcFlex", (value) => value === "true"],
    ["[data-target-rate]", "mcTargetRate", "targetRate", Number]
  ];
  groups.forEach(([selector, stateKey, dataKey, transform = (value) => value]) => {
    document.querySelectorAll(selector).forEach((button) => {
      const active = transform(button.dataset[dataKey]) === state[stateKey];
      button.classList.toggle("active", active);
      button.setAttribute("aria-pressed", active ? "true" : "false");
    });
  });
  // 自定义输入框只在数值不等于任何预设时视为「自定义」，输入框本身始终反映当前次数。
  const runsInput = $("mcRunsInput");
  if (runsInput && document.activeElement !== runsInput) {
    runsInput.value = state.mcRuns;
  }
}

function syncControls() {
  syncScenarioButtons();
  syncCurveSourceButtons();
  syncMonteCarloControls();
  syncMedicalControls();
  syncDividendControls();
  syncStressControls();
  $("stressDepth").value = state.stressDepth;
  $("stressLength").value = state.stressLength;
  $("stressInflation").value = state.stressInflation;
  $("returnRate").value = state.returnRate;
  $("returnInput").value = state.returnRate;
  $("inflationRate").value = state.inflationRate;
  $("inflationInput").value = state.inflationRate;
  $("forecastYears").value = state.years;
  $("yearsInput").value = state.years;
  $("principalRange").value = Math.min(Number($("principalRange").max), state.principal);
  $("principalInput").value = state.principal;
  $("sideIncome").value = state.sideIncomeMonthly;
  $("reserveReturnRate").value = state.reserveReturnRate;
  syncReserveRateButtons();
  $("dcaYears").value = state.dcaYears;
  $("dcaMonthly").value = state.dcaMonthly;
  $("dcaReturnRate").value = state.dcaReturnRate;
  $("dividendYield").value = state.dividendYield;
  document.querySelectorAll(".range").forEach(updateRangeFill);
}

function resetAll() {
  state.expenses = cloneExpenses();
  Object.assign(state, DEFAULT_STATE);
  buildExpenseControls();
  syncControls();
  updateAll();
  showToast("已恢复默认测算方案");
}

function showToast(message) {
  const toast = $("toast");
  toast.textContent = message;
  toast.classList.add("show");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("show"), 2200);
}

function syncThemeToggle() {
  const isDark = document.documentElement.dataset.theme === "dark";
  $("themeLabel").textContent = isDark ? "浅色" : "暗黑";
  $("themeToggle").setAttribute("aria-label", isDark ? "切换至浅色模式" : "切换至暗黑模式");
  $("themeToggle").title = isDark ? "切换至浅色模式" : "切换至暗黑模式";
}

function toggleTheme() {
  const theme = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  try {
    localStorage.setItem("fire-theme", theme);
  } catch (error) {
    // 主题仍会在当前页面生效，仅不保存偏好。
  }
  syncThemeToggle();
}

function downloadCsv() {
  if (!latestResult) return;
  const rows = [
    ["年份", "期初资产", "当年投资收益", "毛支出", "储备利息抵扣", "红利收入", "红利抵扣", "净支出", "实际提取", "年末资产"],
    ...latestResult.projection.points.map((point) => [
      point.year,
      Math.round(point.startBalance),
      Math.round(point.investmentReturn),
      Math.round(point.grossExpense),
      Math.round(point.reserveOffset),
      Math.round(point.dividendIncome || 0),
      Math.round(point.dividendOffset || 0),
      Math.round(point.expense),
      Math.round(point.withdrawal),
      Math.round(point.balance)
    ])
  ];
  const assumptions = [
    ["测算参数", "数值"],
    ["计算引擎版本", latestResult.engineVersion],
    ["现金流模式", state.scenario === "endowment" ? "金鹅永续（只取收益）" : "细水长流（本金慢慢花）"],
    ["全盘测算口径", state.curveSource === "target" ? "当前模式反推目标（手动本金仅作对照）" : "我的本金（反推值仅作对照）"],
    ["实际起算本金", latestResult.activePrincipal],
    ["年化收益率", `${state.returnRate}%`],
    ["年通胀率", `${state.inflationRate}%`],
    ["测算年限", `${state.years}年`],
    ["期初本金", state.principal],
    ["医疗专项储备", state.medicalReserve],
    ["FIRE后储备利率", `${state.reserveReturnRate}%`],
    ["副业被动月收入", state.sideIncomeMonthly],
    ["红利低波定投", `${state.dcaYears}年 / ${state.dcaMonthly}元每月 / ${state.dcaReturnRate}%收益 / ${state.dividendYield}%股息`],
    ["定投随通胀调整", state.dcaInflationAdjust ? `开启（按 ${state.inflationRate}% 通胀逐年递增，末年 ${formatMoney(latestResult.dcaFinalMonthly)}/月）` : "关闭（每月固定）"],
    ["红利定投状态", state.dividendEnabled ? "已启用" : "未启用"],
    ["红利领取模式", state.dividendMode === "dividendOnly" ? "仅领取股息" : "领取股息+本金"],
    ["红利领取起点", latestResult.dividendPlan?.startYear === null || latestResult.dividendPlan?.startYear === undefined ? "未启用/不在测算期内" : `FIRE第${latestResult.dividendPlan.startYear}年`],
    []
  ];
  const csv = [...assumptions, ...rows].map((row) => row.join(",")).join("\r\n");
  const blob = new Blob(["\ufeff", csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `FIRE现金流预测_${state.years}年.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
  showToast("现金流明细已导出");
}

buildExpenseControls();
bindPair("returnRate", "returnInput", "returnRate");
bindPair("inflationRate", "inflationInput", "inflationRate");
bindPair("forecastYears", "yearsInput", "years");
bindPair("principalRange", "principalInput", "principal", applyPrincipalChange);

$("resetExpenses").addEventListener("click", () => {
  state.expenses = cloneExpenses();
  buildExpenseControls();
  updateAll();
  showToast("支出已恢复为默认金额");
});
$("resetAll").addEventListener("click", resetAll);
$("themeToggle").addEventListener("click", toggleTheme);
$("downloadCsv").addEventListener("click", downloadCsv);
$("exportSnapshot").addEventListener("click", exportSnapshot);
$("importSnapshotButton").addEventListener("click", () => $("snapshotFileInput").click());
$("snapshotFileInput").addEventListener("change", (event) => {
  const file = event.target.files?.[0];
  if (file) importSnapshotFile(file);
  event.target.value = "";
});
$("validateSnapshot").addEventListener("click", () => {
  try {
    validateDataSnapshot();
  } catch (error) {
    setSnapshotStatus("error", "快照 JSON 解析失败，请检查格式。");
  }
});
$("clearSnapshot").addEventListener("click", clearDataSnapshot);
document.querySelectorAll(".scenario-option").forEach((button) => {
  button.addEventListener("click", () => {
    state.scenario = button.dataset.scenario;
    syncScenarioButtons();
    updateAll();
  });
});
document.querySelectorAll("[data-curve-source]").forEach((button) => {
  button.addEventListener("click", () => setCurveSource(button.dataset.curveSource));
});

const sideIncomeInput = $("sideIncome");
sideIncomeInput.addEventListener("input", () => {
  if (sideIncomeInput.value === "") return;
  state.sideIncomeMonthly = clamp(Number(sideIncomeInput.value) || 0, 0, Number(sideIncomeInput.max));
  updateAll();
});
sideIncomeInput.addEventListener("change", () => {
  state.sideIncomeMonthly = clamp(Number(sideIncomeInput.value) || 0, 0, Number(sideIncomeInput.max));
  sideIncomeInput.value = state.sideIncomeMonthly;
  updateAll();
});

const reserveReturnInput = $("reserveReturnRate");
// 输入过程中只更新状态与按钮高亮，绝不改写输入框，否则 "2." 会被 Number 归一成 2 导致小数无法输入。
reserveReturnInput.addEventListener("input", () => {
  if (reserveReturnInput.value === "") return;
  const parsed = Number(reserveReturnInput.value);
  if (!Number.isFinite(parsed)) return;
  state.reserveReturnRate = clamp(parsed, 0, Number(reserveReturnInput.max));
  syncReserveRateButtons();
  updateAll();
});
// 失焦/回车时才规范化显示值（如补零、纠正超出范围）。
reserveReturnInput.addEventListener("change", () => {
  const parsed = Number(reserveReturnInput.value);
  state.reserveReturnRate = clamp(Number.isFinite(parsed) ? parsed : 0, 0, Number(reserveReturnInput.max));
  reserveReturnInput.value = state.reserveReturnRate;
  syncReserveRateButtons();
  updateAll();
});
document.querySelectorAll("[data-reserve-rate]").forEach((button) => {
  button.addEventListener("click", () => {
    state.reserveReturnRate = Number(button.dataset.reserveRate);
    syncControls();
    updateAll();
  });
});

document.querySelectorAll("[data-medical-tier]").forEach((button) => {
  button.addEventListener("click", () => {
    state.medicalReserve = Number(button.dataset.medicalTier);
    syncMedicalControls();
    updateAll();
  });
});
const medicalReserveInput = $("medicalReserveInput");
medicalReserveInput.addEventListener("input", () => {
  if (medicalReserveInput.value === "") return;
  state.medicalReserve = clamp(Number(medicalReserveInput.value) || 0, 0, Number(medicalReserveInput.max));
  syncMedicalControls();
  updateAll();
});
medicalReserveInput.addEventListener("change", () => {
  state.medicalReserve = clamp(Number(medicalReserveInput.value) || 0, 0, Number(medicalReserveInput.max));
  medicalReserveInput.value = state.medicalReserve;
  syncMedicalControls();
  updateAll();
});

[
  ["dcaYears", "dcaYears", true],
  ["dcaMonthly", "dcaMonthly", false],
  ["dcaReturnRate", "dcaReturnRate", false],
  ["dividendYield", "dividendYield", false]
].forEach(([inputId, stateKey, roundValue]) => {
  const input = $(inputId);
  const applyValue = () => {
    let value = Number(input.value) || 0;
    value = clamp(value, Number(input.min), Number(input.max));
    if (roundValue) value = Math.round(value);
    state[stateKey] = value;
    return value;
  };
  input.addEventListener("input", () => {
    if (input.value === "") return;
    applyValue();
    updateAll();
  });
  input.addEventListener("change", () => {
    const value = applyValue();
    input.value = value;
    updateAll();
  });
});

document.querySelectorAll("[data-dividend-enabled]").forEach((button) => {
  button.addEventListener("click", () => {
    state.dividendEnabled = button.dataset.dividendEnabled === "true";
    syncDividendControls();
    updateAll();
  });
});

document.querySelectorAll("[data-dividend-mode]").forEach((button) => {
  button.addEventListener("click", () => {
    state.dividendMode = button.dataset.dividendMode;
    syncDividendControls();
    updateAll();
  });
});

document.querySelectorAll("[data-dca-inflation]").forEach((button) => {
  button.addEventListener("click", () => {
    state.dcaInflationAdjust = button.dataset.dcaInflation === "true";
    syncDividendControls();
    updateAll();
  });
});

document.querySelectorAll("[data-mc-profile]").forEach((button) => {
  button.addEventListener("click", () => {
    state.mcProfile = button.dataset.mcProfile;
    syncMonteCarloControls();
    scheduleMonteCarlo();
  });
});
// 自定义组合：初始化按钮（localStorage 已载入），并接好表单弹窗与删除逻辑。
renderCustomProfileButtons();
$("mcAddProfile").addEventListener("click", openCpModal);
$("cpModalClose").addEventListener("click", closeCpModal);
$("cpCancel").addEventListener("click", closeCpModal);
$("cpSave").addEventListener("click", saveCustomProfileFromForm);
$("cpAddHolding").addEventListener("click", () => addCpHoldingRow());
$("cpSavedList").addEventListener("click", (event) => {
  const button = event.target.closest("[data-cp-delete]");
  if (button) deleteCustomProfile(button.dataset.cpDelete);
});
$("cpModalOverlay").addEventListener("click", (event) => {
  if (event.target === $("cpModalOverlay")) closeCpModal();
});
document.querySelectorAll("[data-mc-runs]").forEach((button) => {
  button.addEventListener("click", () => {
    state.mcRuns = Number(button.dataset.mcRuns);
    syncMonteCarloControls();
    scheduleMonteCarlo();
  });
});

// 自定义模拟次数：输入过程中先更新状态（防抖后重算），失焦/回车时规范化显示值。
const mcRunsInput = $("mcRunsInput");
if (mcRunsInput) {
  const applyRunsValue = () => {
    const parsed = Number(mcRunsInput.value);
    if (!Number.isFinite(parsed)) return null;
    const value = clamp(Math.round(parsed), MC_RUNS_MIN, MC_RUNS_MAX);
    if (value !== state.mcRuns) {
      state.mcRuns = value;
      return value;
    }
    return null;
  };
  mcRunsInput.addEventListener("input", () => {
    if (applyRunsValue() !== null) scheduleMonteCarlo();
  });
  mcRunsInput.addEventListener("change", () => {
    const parsed = Number(mcRunsInput.value);
    const value = Number.isFinite(parsed)
      ? clamp(Math.round(parsed), MC_RUNS_MIN, MC_RUNS_MAX)
      : state.mcRuns;
    state.mcRuns = value;
    mcRunsInput.value = value;
    syncMonteCarloControls();
    scheduleMonteCarlo();
  });
}
document.querySelectorAll("[data-mc-flex]").forEach((button) => {
  button.addEventListener("click", () => {
    state.mcFlexibility = button.dataset.mcFlex === "true";
    syncMonteCarloControls();
    scheduleMonteCarlo();
  });
});

document.querySelectorAll("[data-target-rate]").forEach((button) => {
  button.addEventListener("click", () => {
    state.mcTargetRate = Number(button.dataset.targetRate);
    syncMonteCarloControls();
    runLeverAnalysis();
  });
});
$("runLeverAnalysis").addEventListener("click", () => runLeverAnalysis());

// ===== 压力测试面板事件 =====
document.querySelectorAll("[data-stress-scenario]").forEach((button) => {
  button.addEventListener("click", () => {
    state.stressScenario = button.dataset.stressScenario;
    syncStressControls();
    if (latestResult) renderStress(latestResult);
  });
});
document.querySelectorAll("[data-stress-gk]").forEach((button) => {
  button.addEventListener("click", () => {
    state.stressGuytonKlinger = button.dataset.stressGk === "true";
    syncStressControls();
    if (latestResult) renderStress(latestResult);
  });
});
// 自定义冲击参数：输入防抖 400ms 后重算，失焦时规范化数值。
let stressParamTimer = null;
["stressDepth", "stressLength", "stressInflation"].forEach((inputId) => {
  const input = $(inputId);
  if (!input) return;
  input.addEventListener("input", () => {
    if (input.value === "" || input.value === "-") return;
    window.clearTimeout(stressParamTimer);
    stressParamTimer = window.setTimeout(() => {
      if (latestResult) renderStress(latestResult);
    }, 400);
  });
  input.addEventListener("change", () => {
    const min = Number(input.min);
    const max = Number(input.max);
    const parsed = Number(input.value);
    const value = Number.isFinite(parsed) ? clamp(parsed, min, max) : state[input.dataset.stateKey || "stressInflation"];
    input.value = value;
    window.clearTimeout(stressParamTimer);
    if (latestResult) renderStress(latestResult);
  });
});

// 胜率工具箱：勾选即时重算；参数输入防抖 600ms 后按新参数完整重算。
const leverOptionsWrap = $("leverOptions");
if (leverOptionsWrap) {
  leverOptionsWrap.addEventListener("change", (event) => {
    const box = event.target.closest("input[data-lever-check]");
    if (!box) return;
    leverSelection.checked[box.dataset.leverCheck] = box.checked;
    syncLeverOptionVisuals();
  });
  leverOptionsWrap.addEventListener("input", onLeverParamInput);
}

// 耗尽年份典型现金流弹窗：关闭按钮、遮罩点击与 ESC 均可关闭。
$("mcModalClose").addEventListener("click", closeBucketModal);
$("mcModalOverlay").addEventListener("click", (event) => {
  if (event.target === $("mcModalOverlay")) closeBucketModal();
});
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    closeBucketModal();
    closeDcaModal();
    closeCpModal();
  }
});

// 定投金额曲线弹窗：字段内的迷你按钮触发，关闭按钮与遮罩点击均可关闭。
$("dcaCurveButton").addEventListener("click", openDcaModal);
$("dcaModalClose").addEventListener("click", closeDcaModal);
$("dcaModalOverlay").addEventListener("click", (event) => {
  if (event.target === $("dcaModalOverlay")) closeDcaModal();
});

document.querySelectorAll("[data-amount]").forEach((button) => {
  button.addEventListener("click", () => {
    const useReverse = button.dataset.amount === "reverse";
    const amount = useReverse
      ? (latestResult?.reverse === null || latestResult?.reverse === undefined ? null : Math.ceil(latestResult.reverse))
      : Number(button.dataset.amount);
    if (amount === null || !Number.isFinite(amount)) return;
    state.principal = amount;
    $("principalInput").value = amount;
    $("principalRange").value = Math.min(Number($("principalRange").max), amount);
    updateRangeFill($("principalRange"));
    // 快捷金额属于手动设定：立即切到「我的本金」；点「反推值」则回到对照口径。
    if (state.curveSource !== (useReverse ? "target" : "principal")) {
      setCurveSource(useReverse ? "target" : "principal");
    } else {
      updateAll();
    }
  });
});

if ("ResizeObserver" in window) {
  const observer = new ResizeObserver(() => {
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = window.requestAnimationFrame(() => {
      if (latestResult) renderChart(latestResult.projection.points, latestResult.chartStart, latestResult);
      if (latestStress) renderStressChart(latestStress.scenarios.find((item) => item.scenarioId === (isCustomStressScenario() ? "custom" : state.stressScenario)) || latestStress.baseline);
    });
  });
  observer.observe($("chartWrap"));
} else {
  window.addEventListener("resize", () => {
    if (latestResult) renderChart(latestResult.projection.points, latestResult.chartStart, latestResult);
    if (latestStress) renderStressChart(latestStress.scenarios.find((item) => item.scenarioId === (isCustomStressScenario() ? "custom" : state.stressScenario)) || latestStress.baseline);
  });
}

syncControls();
syncThemeToggle();
updateAll();
