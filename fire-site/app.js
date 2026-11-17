"use strict";

import { calculateFirePlan } from "./js/core/fire-engine.js";
import { evaluateRiskRules } from "./js/core/risk-engine.js";
import { createSnapshotPayload, parseSnapshotPayload } from "./js/core/snapshot.js";
import { normalizeManualSnapshot } from "./js/core/data/manual-snapshot.js";

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
  returnRate: 4.5,
  inflationRate: 2,
  years: 50,
  principal: 1885510,
  sideIncomeMonthly: 2000,
  reserveReturnRate: 2.25,
  medicalReserve: 150000,
  dcaYears: 10,
  dcaMonthly: 2000,
  dcaReturnRate: 6,
  dividendYield: 4
};

const state = {
  expenses: cloneExpenses(),
  ...DEFAULT_STATE
};

let latestResult = null;
let latestRisk = null;
let latestSnapshot = null;
let toastTimer = null;
let resizeFrame = null;
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
    ? (isTargetCurve ? "反推目标路径：仅提取收益，本金随通胀保值" : "按你的初始目标测算：购买力是否能够保持")
    : (isTargetCurve ? "反推目标路径：本金随支出逐步消耗，期末归零" : "按你的初始目标测算：本金够不够花"), false);
  setText("curveSourceNote", isTargetCurve
    ? `按${state.scenario === "endowment" ? "金鹅永续" : "细水长流"}反推目标 ${formatMoney(result.reverse)} 起算`
    : `按我的本金 ${formatMoney(state.principal)} 起算`, false);

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

  setText("reverseFullTarget", formatOptionalMoney(result.reverseFull));
  setText("conservativeFullTarget", formatMoney(result.conservative));
  setText("comparisonYears", state.scenario === "endowment" ? "金鹅永续现金流模型" : `${state.years} 年现金流模型`, false);
  setText("modelColumnTitle", state.scenario === "endowment" ? "现金流反推（金鹅永续）" : `现金流反推（${state.years} 年）`, false);

  const modelTargetValue = result.reverseFull === null ? 0 : result.reverseFull;
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
    $("reserveTargetText").innerHTML = `达到当前模式投资本金 <strong>${formatMoney(result.reverse)}</strong> 后，还需单独准备 <strong>${formatMoney(reservePlan.target)}</strong> 补充储备；FIRE 后医疗储备与 10% 安全垫每年产生利息 <strong>${formatMoney(reservePlan.annualReserveInterest)}</strong>，用于抵扣当年支出。`;
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

  setText("fundValue", formatMoney(result.fundValue));
  setText("fundValueDetail", `定投 ${state.dcaYears} 年，每月 ${formatMoney(result.dcaMonthly)}，累计投入 ${formatMoney(result.dcaTotalContributed)}。`);
  setText("fundAnnualDividend", formatMoney(result.fundAnnualDividend));
  setText("fundAnnualDividendDetail", `按股息率 ${formatPercent(state.dividendYield)} 计算，不卖出本金。`);
  setText("fundMonthlyDividend", formatMoney(result.fundMonthlyDividend));
  setText("fundMonthlyDividendDetail", result.fundCoverage === null
    ? "当前月支出为 0，无法计算覆盖比例。"
    : `相当于当前月支出的 ${(result.fundCoverage * 100).toFixed(1)}%，只提取股息。`);
  $("fundScenarioRows").innerHTML = result.fundScenarios.map((scenario) => `
    <tr>
      <td>${scenario.label}</td>
      <td>${formatPercent(scenario.rate)}</td>
      <td>${formatMoney(scenario.value)}</td>
      <td>${formatMoney(scenario.monthlyDividend)}</td>
    </tr>
  `).join("");

  const rows = [
    { label: state.scenario === "endowment" ? "永续投资本金" : "投资本金 / 40 倍年支出", model: result.reverse, conservative: result.annual * 40 },
    { label: "医疗储备", model: result.medicalReserve, conservative: result.medicalReserve },
    { label: "36 个月现金储备", model: result.cashReserve, conservative: result.cashReserve },
    { label: "10% 安全垫", model: result.reverseBase === null ? null : result.reverseBase * 0.1, conservative: result.conservativeBase * 0.1, subtle: true },
    { label: "完整目标合计", model: result.reverseFull, conservative: result.conservative, total: true }
  ];
  $("breakdownRows").innerHTML = rows.map((row) => `
    <tr class="${row.total ? "total-row" : ""} ${row.subtle ? "subtle-row" : ""}">
      <td>${row.label}</td><td>${formatOptionalMoney(row.model)}</td><td>${formatMoney(row.conservative)}</td>
    </tr>
  `).join("");

  renderChart(projection.points, result.chartStart);
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

function renderChart(points, principal) {
  const svg = $("cashflowChart");
  const wrap = $("chartWrap");
  const tooltip = $("chartTooltip");
  const width = Math.max(320, wrap.clientWidth || 700);
  const height = window.innerWidth <= 580 ? 290 : 340;
  const margin = { top: 20, right: 15, bottom: 38, left: width < 430 ? 48 : 60 };
  const plotWidth = width - margin.left - margin.right;
  const plotHeight = height - margin.top - margin.bottom;
  const years = points.length - 1;
  const rawMax = Math.max(principal, ...points.map((point) => Math.max(point.balance, point.expense)), 1) * 1.08;
  const maxValue = niceMaximum(rawMax);
  const x = (year) => margin.left + (year / years) * plotWidth;
  const y = (value) => margin.top + (1 - clamp(value / maxValue, 0, 1)) * plotHeight;
  const zeroY = y(0);
  const assetPoints = points.map((point) => [x(point.year), y(point.balance)]);
  const expensePoints = points.slice(1).map((point) => [x(point.year), y(point.expense)]);
  const linePath = (coordinates) => coordinates.map((point, index) => `${index === 0 ? "M" : "L"}${point[0].toFixed(2)},${point[1].toFixed(2)}`).join(" ");
  const assetPath = linePath(assetPoints);
  const areaPath = `${assetPath} L${x(years).toFixed(2)},${zeroY.toFixed(2)} L${x(0).toFixed(2)},${zeroY.toFixed(2)} Z`;

  const yTicks = Array.from({ length: 6 }, (_, index) => (maxValue / 5) * index);
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
      ${yTicks.map((tick) => `
        <line class="chart-grid" x1="${margin.left}" y1="${y(tick)}" x2="${width - margin.right}" y2="${y(tick)}"/>
        <text class="chart-axis-label" x="${margin.left - 9}" y="${y(tick) + 3}" text-anchor="end">${formatAxis(tick)}</text>
      `).join("")}
      ${xTicks.map((tick) => `<text class="chart-axis-label" x="${x(tick)}" y="${height - 13}" text-anchor="middle">${tick === 0 ? "现在" : `${tick} 年`}</text>`).join("")}
      <path class="chart-area" d="${areaPath}"/>
      <line class="chart-principal-path" x1="${margin.left}" y1="${y(principal)}" x2="${width - margin.right}" y2="${y(principal)}"/>
      <path class="chart-expense-path" d="${linePath(expensePoints)}"/>
      <path class="chart-asset-path" d="${assetPath}"/>
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
    const assetY = y(point.balance);
    const expenseY = y(point.expense);
    hover.setAttribute("visibility", "visible");
    hoverLine.setAttribute("x1", hoverX);
    hoverLine.setAttribute("x2", hoverX);
    assetDot.setAttribute("cx", hoverX);
    assetDot.setAttribute("cy", assetY);
    expenseDot.setAttribute("cx", hoverX);
    expenseDot.setAttribute("cy", expenseY);
    expenseDot.setAttribute("visibility", year === 0 ? "hidden" : "visible");

    tooltip.innerHTML = `<strong>${year === 0 ? "期初" : `第 ${year} 年`}</strong><span>年末资产 <b>${formatMoney(point.balance)}</b></span>${year > 0 ? `<span>当年支出 <b>${formatMoney(point.expense)}</b></span><span>投资收益 <b>${formatMoney(point.investmentReturn)}</b></span>` : ""}`;
    tooltip.hidden = false;
    const pixelX = (hoverX / width) * rect.width;
    const pixelY = (Math.min(assetY, year === 0 ? assetY : expenseY) / height) * rect.height;
    tooltip.style.left = `${clamp(pixelX, 82, rect.width - 82)}px`;
    tooltip.style.top = `${Math.max(88, pixelY)}px`;
  });
  overlay.addEventListener("pointerleave", hideTooltip);
  overlay.addEventListener("pointercancel", hideTooltip);
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

function syncMedicalControls() {
  document.querySelectorAll("[data-medical-tier]").forEach((button) => {
    const active = Number(button.dataset.medicalTier) === state.medicalReserve;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
  $("medicalReserveInput").value = state.medicalReserve;
}

function syncControls() {
  syncScenarioButtons();
  syncCurveSourceButtons();
  syncMedicalControls();
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
  document.querySelectorAll("[data-reserve-rate]").forEach((button) => {
    const active = Number(button.dataset.reserveRate) === state.reserveReturnRate;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", active ? "true" : "false");
  });
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
    ["年份", "期初资产", "当年投资收益", "毛支出", "储备利息抵扣", "净支出", "实际提取", "年末资产"],
    ...latestResult.projection.points.map((point) => [
      point.year,
      Math.round(point.startBalance),
      Math.round(point.investmentReturn),
      Math.round(point.grossExpense),
      Math.round(point.reserveOffset),
      Math.round(point.expense),
      Math.round(point.withdrawal),
      Math.round(point.balance)
    ])
  ];
  const assumptions = [
    ["测算参数", "数值"],
    ["计算引擎版本", latestResult.engineVersion],
    ["现金流模式", state.scenario === "endowment" ? "金鹅永续（只取收益）" : "细水长流（本金慢慢花）"],
    ["曲线起点", state.curveSource === "target" ? "当前模式反推目标" : "我的本金"],
    ["年化收益率", `${state.returnRate}%`],
    ["年通胀率", `${state.inflationRate}%`],
    ["测算年限", `${state.years}年`],
    ["期初本金", state.principal],
    ["医疗专项储备", state.medicalReserve],
    ["FIRE后储备利率", `${state.reserveReturnRate}%`],
    ["副业被动月收入", state.sideIncomeMonthly],
    ["红利低波定投", `${state.dcaYears}年 / ${state.dcaMonthly}元每月 / ${state.dcaReturnRate}%收益 / ${state.dividendYield}%股息`],
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
bindPair("principalRange", "principalInput", "principal");

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
  button.addEventListener("click", () => {
    state.curveSource = button.dataset.curveSource;
    syncCurveSourceButtons();
    updateAll();
  });
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
reserveReturnInput.addEventListener("input", () => {
  if (reserveReturnInput.value === "") return;
  state.reserveReturnRate = clamp(Number(reserveReturnInput.value) || 0, 0, Number(reserveReturnInput.max));
  syncControls();
  updateAll();
});
reserveReturnInput.addEventListener("change", () => {
  state.reserveReturnRate = clamp(Number(reserveReturnInput.value) || 0, 0, Number(reserveReturnInput.max));
  reserveReturnInput.value = state.reserveReturnRate;
  syncControls();
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

document.querySelectorAll("[data-amount]").forEach((button) => {
  button.addEventListener("click", () => {
    const amount = button.dataset.amount === "reverse" ? (latestResult.reverse === null ? null : Math.ceil(latestResult.reverse)) : Number(button.dataset.amount);
    if (amount === null) {
      showToast("当前收益未跑赢通胀，暂无永续反推值");
      return;
    }
    state.principal = amount;
    $("principalInput").value = amount;
    $("principalRange").value = Math.min(Number($("principalRange").max), amount);
    updateRangeFill($("principalRange"));
    updateAll();
  });
});

if ("ResizeObserver" in window) {
  const observer = new ResizeObserver(() => {
    window.cancelAnimationFrame(resizeFrame);
    resizeFrame = window.requestAnimationFrame(() => {
      if (latestResult) renderChart(latestResult.projection.points, latestResult.chartStart);
    });
  });
  observer.observe($("chartWrap"));
} else {
  window.addEventListener("resize", () => {
    if (latestResult) renderChart(latestResult.projection.points, latestResult.chartStart);
  });
}

syncControls();
syncThemeToggle();
updateAll();
