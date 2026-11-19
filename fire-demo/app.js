"use strict";

import {
  SCENARIOS, STRESS_PATHS, INFLATION_BY_CATEGORY, DEFAULT_EXPENSES,
  runDemoSimulation, runAllScenarios, runStressTests, runMonteCarlo, ASSET_PROFILES
} from "./js/core/demo-engine.js";

const $ = (id) => document.getElementById(id);
const fmt = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return `¥${Math.round(n).toLocaleString("zh-CN")}`;
};
const fmtPct = (v) => `${Number(v).toFixed(1)}%`;

const state = {
  scenarioKey: "base",
  dividendMode: "totalReturn",
  dcaSource: "side",
  useCategoryInflation: true,
  stressInflation: false,
  curve: "actual",
  mcProfile: "balanced",
  mcRuns: 5000,
  mcFlexibility: false
};

function currentInput(extra = {}) {
  return {
    scenarioKey: state.scenarioKey,
    dividendMode: state.dividendMode,
    dcaSource: state.dcaSource,
    useCategoryInflation: state.useCategoryInflation,
    stressInflation: state.stressInflation,
    years: 50,
    totalAssets: 1885510,
    medicalReserve: 150000,
    cashReserve: 116100,
    reserveIncluded: true,
    dcaYears: 25,
    dcaMonthly: 1200,
    expenses: DEFAULT_EXPENSES,
    ...extra
  };
}

// 反推目标起算：二分找使主账户全程不破产的最小初始本金（用同一引擎）
function solveSafeTarget(extra = {}) {
  const base = currentInput(extra);
  const depleted = (principal) => runDemoSimulation({ ...base, totalAssets: principal, reserveIncluded: false }).depletedYear !== null;
  let lo = 0;
  let hi = Math.max(base.totalAssets, 500000);
  let guard = 0;
  while (depleted(hi) && guard < 40) { hi *= 1.3; guard += 1; }
  for (let i = 0; i < 45; i += 1) {
    const mid = (lo + hi) / 2;
    if (depleted(mid)) lo = mid; else hi = mid;
  }
  return hi;
}

function renderParams() {
  const s = SCENARIOS[state.scenarioKey];
  const cells = [
    ["主组合收益", fmtPct(s.portfolioReturn)],
    ["综合通胀", fmtPct(s.inflation)],
    ["定投收益", fmtPct(s.dcaReturn)],
    ["储备收益", fmtPct(s.reserveReturn)],
    ["红利分配率", fmtPct(s.dividendYield)],
    ["副业月收入", fmt(s.sideIncomeMonthly)]
  ];
  $("paramTable").innerHTML = cells.map(([k, v]) => `<div class="cell"><span>${k}</span><strong>${v}</strong></div>`).join("");
  $("scenarioBadge").textContent = s.label;
}

function renderKpi(r) {
  const last = r.points[r.points.length - 1];
  const kpis = [
    ["第 50 年总资产", fmt(last.closeTotal), ""],
    ["最早资金不足", r.depletedYear === null ? "无" : `第 ${r.depletedYear} 年`, r.depletedYear === null ? "good" : "warn"],
    ["总资产最低点", fmt(r.minTotal), ""],
    ["定投账户期末", fmt(r.endDca), ""]
  ];
  $("kpiGrid").innerHTML = kpis.map(([k, v, cls]) => `<div class="kpi ${cls}"><span>${k}</span><strong>${v}</strong></div>`).join("");
  const verdict = r.depletedYear === null ? "50 年未耗尽" : `第 ${r.depletedYear} 年不足`;
  $("verdictBadge").textContent = verdict;
  const err = r.conservationMaxError;
  const c = $("conservation");
  c.className = `conservation ${err < 0.01 ? "ok" : "bad"}`;
  c.textContent = `资金守恒校验：逐年误差最大 ${err.toFixed(4)} 元 ${err < 0.01 ? "✓ 全部通过（期末总资产 = 期初 + 投资收益 + 外部收入 − 生活消费）" : "✗ 存在记账不一致，请检查"}`;
}

function renderChart(r) {
  const svg = $("mainChart");
  const w = Math.max(320, svg.clientWidth || 800);
  const h = 320;
  const m = { top: 18, right: 16, bottom: 32, left: 58 };
  const pw = w - m.left - m.right, ph = h - m.top - m.bottom;
  const pts = r.points;
  const max = Math.max(...pts.map((p) => p.closeTotal), 1) * 1.08;
  const x = (y) => m.left + (y / r.years) * pw;
  const y = (v) => m.top + (1 - Math.min(1, v / max)) * ph;
  const path = (key) => pts.map((p, i) => `${i ? "L" : "M"}${x(p.year).toFixed(1)},${y(p[key]).toFixed(1)}`).join(" ");
  const ticks = Array.from({ length: 5 }, (_, i) => (max / 4) * i);
  const series = [
    ["closeTotal", "var(--gold)", 2.4],
    ["main", "var(--orange)", 1.6],
    ["dcaBal", "var(--green)", 1.6],
    ["reserve", "var(--blue)", 1.4]
  ];
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = `
    ${ticks.map((t) => `<line x1="${m.left}" y1="${y(t)}" x2="${w - m.right}" y2="${y(t)}" stroke="var(--line)"/><text x="${m.left - 7}" y="${y(t) + 3}" text-anchor="end" fill="var(--muted)" font-size="9">${t >= 10000 ? `${(t / 10000).toFixed(0)}万` : Math.round(t)}</text>`).join("")}
    ${[0, 10, 20, 30, 40, 50].map((yr) => `<text x="${x(yr)}" y="${h - 10}" text-anchor="middle" fill="var(--muted)" font-size="9">${yr === 0 ? "现在" : `${yr}年`}</text>`).join("")}
    ${series.map(([k, c, sw]) => `<path d="${path(k)}" fill="none" stroke="${c}" stroke-width="${sw}" stroke-linejoin="round"/>`).join("")}
  `;
}

function renderScenarioTable(results) {
  const modeLabel = { dividend: "A 纯股息", totalReturn: "B 总回报提款", annuity: "C 固定年金" }[state.dividendMode];
  const rows = Object.keys(SCENARIOS).map((key) => {
    const r = results[key];
    const s = SCENARIOS[key];
    const last = r.points[r.points.length - 1];
    return `<tr>
      <td>${s.label}</td><td>${fmtPct(s.portfolioReturn)}</td><td>${fmtPct(s.inflation)}</td>
      <td>${fmt(r.payout.annualAtStart)}</td>
      <td>${r.depletedYear === null ? '<span class="ok">无</span>' : `<span class="bad">第${r.depletedYear}年</span>`}</td>
      <td>${fmt(r.minTotal)}</td><td>${fmt(last.closeTotal)}</td><td>${fmt(r.endDca)}</td>
    </tr>`;
  }).join("");
  $("scenarioTable").innerHTML = `<thead><tr><th>情景</th><th>收益</th><th>通胀</th><th>首年领取(${modeLabel})</th><th>耗尽</th><th>资产最低</th><th>第50年</th><th>定投账户期末</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderStressTable() {
  const tests = runStressTests(currentInput());
  const rows = Object.keys(STRESS_PATHS).map((key) => {
    const r = tests[key];
    const last = r.points[r.points.length - 1];
    return `<tr>
      <td>${STRESS_PATHS[key].label}</td>
      <td>${r.depletedYear === null ? '<span class="ok">否</span>' : `<span class="bad">是</span>`}</td>
      <td>${r.depletedYear === null ? "—" : `第 ${r.depletedYear} 年`}</td>
      <td>${fmt(r.minTotal)}</td><td>${fmt(last.closeTotal)}</td>
      <td class="${r.conservationMaxError < 0.01 ? "ok" : "bad"}">${r.conservationMaxError.toFixed(2)}</td>
    </tr>`;
  }).join("");
  $("stressTable").innerHTML = `<thead><tr><th>压力情景</th><th>是否耗尽</th><th>最早不足年</th><th>资产最低点</th><th>第50年剩余</th><th>守恒误差</th></tr></thead><tbody>${rows}</tbody>`;
}

function renderFlowTable(r) {
  const years = [1, 2, 3, 4, 5, r.payout.startYear - 1, r.payout.startYear, r.payout.startYear + 1, 49, 50].filter((y) => y >= 1 && y <= r.years);
  const seen = new Set();
  const list = years.filter((y) => !seen.has(y) && seen.add(y)).sort((a, b) => a - b);
  const rows = list.map((y) => {
    const p = r.points[y - 1];
    return `<tr>
      <td>第 ${y} 年</td><td>${fmt(p.expense)}</td><td>${fmt(p.sideIncome)}</td>
      <td>${fmt(p.reserveInterest)}</td><td>${fmt(p.dcaPayout)}</td><td>${fmt(p.mainWithdrawal)}</td>
      <td>${fmt(p.dcaPayment)}</td><td>${fmt(p.mainToDca)}</td><td>${fmt(p.closeTotal)}</td>
    </tr>`;
  }).join("");
  $("flowTable").innerHTML = `<thead><tr><th>年份</th><th>生活支出</th><th>可用副业</th><th>储备利息</th><th>定投提款</th><th>主账户提款</th><th>定投缴款</th><th>主账户转定投</th><th>期末总资产</th></tr></thead><tbody>${rows}</tbody>`;
  const sourceNote = {
    side: "定投来源＝副业；副业不足时缺口从主账户转出（见「主账户转定投」列）。",
    main: "定投来源＝主账户；每年定投缴款同步从主账户扣除。",
    external: "定投来源＝独立外部收入；不占用主账户，也不占用副业。"
  }[state.dcaSource];
  const modeNote = {
    dividend: "A 纯股息：只领取基金分配股息，不卖本金，定投账户本金保留。",
    totalReturn: "B 总回报提款：按当年余额 × 提款率动态提取，金额不固定。",
    annuity: "C 固定年金：按领取起点余额与剩余年数算固定支付；本 demo 中提款不超过当年生活缺口，多余留在账户。"
  }[state.dividendMode];
  $("accountNote").textContent = `${sourceNote} ${modeNote} 储备利息从第 1 年起计提，当年用于抵扣支出、本金保持恒定。`;
}

function renderMonteCarlo() {
  const mc = runMonteCarlo(currentInput({
    mcProfile: state.mcProfile,
    mcRuns: state.mcRuns,
    mcSeed: 20261119,
    expenseFlexibility: state.mcFlexibility
  }));
  const profile = ASSET_PROFILES[state.mcProfile];
  const sr = mc.successRate;
  $("mcBadge").textContent = `${mc.runs.toLocaleString()} 次模拟 · ${profile.label}`;
  $("mcParams").innerHTML = [
    ["长期年化 μ", fmtPct(mc.mu * 100)],
    ["年波动率 σ", fmtPct(mc.sigma * 100)],
    ["随机种子", mc.seed],
    ["失败路径", `${mc.failedCount.toLocaleString()} 条`]
  ].map(([k, v]) => `<div class="cell"><span>${k}</span><strong>${v}</strong></div>`).join("");

  const srCls = sr >= 0.9 ? "good" : sr >= 0.75 ? "" : "warn";
  $("mcKpis").innerHTML = `
    <div class="kpi ${srCls}"><span>50 年存续成功率</span><strong>${(sr * 100).toFixed(1)}%</strong></div>
    <div class="kpi"><span>P10 期末资产（差年份）</span><strong>${fmt(mc.p10End)}</strong></div>
    <div class="kpi"><span>P50 期末资产（中位数）</span><strong>${fmt(mc.p50End)}</strong></div>
    <div class="kpi"><span>P90 期末资产（好年份）</span><strong>${fmt(mc.p90End)}</strong></div>`;

  $("mcDistTable").innerHTML = `<thead><tr><th>分位</th><th>期末总资产</th><th>资产最低点</th></tr></thead><tbody>
    <tr><td>P10（较差 10%）</td><td>${fmt(mc.p10End)}</td><td>${fmt(mc.p10Min)}</td></tr>
    <tr><td>P50（中位数）</td><td>${fmt(mc.p50End)}</td><td>${fmt(mc.p50Min)}</td></tr>
    <tr><td>P90（较好 10%）</td><td>${fmt(mc.p90End)}</td><td>—</td></tr>
  </tbody>`;

  // 耗尽年直方图
  const svg = $("mcHist");
  const w = Math.max(260, svg.clientWidth || 420);
  const h = 180;
  const m = { top: 14, right: 10, bottom: 26, left: 34 };
  const maxCount = Math.max(...mc.buckets.map((b) => b.count), 1);
  const bw = (w - m.left - m.right) / mc.buckets.length;
  const y = (v) => m.top + (1 - v / maxCount) * (h - m.top - m.bottom);
  svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  svg.innerHTML = `
    <line x1="${m.left}" y1="${h - m.bottom}" x2="${w - m.right}" y2="${h - m.bottom}" stroke="var(--line)"/>
    ${mc.buckets.map((b, i) => {
      const bh = (h - m.top - m.bottom) * (b.count / maxCount);
      const x = m.left + i * bw + bw * 0.15;
      return `<rect x="${x.toFixed(1)}" y="${(h - m.bottom - bh).toFixed(1)}" width="${(bw * 0.7).toFixed(1)}" height="${Math.max(0, bh).toFixed(1)}" fill="var(--red)" opacity=".75" rx="3"/>
        <text x="${(m.left + i * bw + bw / 2).toFixed(1)}" y="${h - 8}" text-anchor="middle" fill="var(--muted)" font-size="9">${b.label}</text>
        ${b.count > 0 ? `<text x="${(m.left + i * bw + bw / 2).toFixed(1)}" y="${(h - m.bottom - bh - 4).toFixed(1)}" text-anchor="middle" fill="var(--ink-soft)" font-size="9">${b.count}</text>` : ""}`;
    }).join("")}`;

  const err = mc.conservationMaxError;
  const c = $("mcConservation");
  c.className = `conservation ${err < 0.01 ? "ok" : "bad"}`;
  const note = sr >= 0.9 ? "成功率较高，当前本金对该配置有较厚安全边际。"
    : sr >= 0.75 ? "成功率中等，建议提高本金、降低支出或开启支出弹性。"
    : "成功率偏低：按该配置，相当比例的路径会在 50 年内耗尽，需要重点审视。";
  c.textContent = `${note} 守恒校验：${mc.runs.toLocaleString()} 条路径逐年误差最大 ${err.toFixed(4)} 元。${mc.flexAppliedCount > 0 && state.mcFlexibility ? `弹性共触发 ${mc.flexAppliedCount} 次。` : ""}`;
}

function update() {
  renderParams();
  const input = currentInput(state.curve === "target" ? { totalAssets: solveSafeTarget(), reserveIncluded: false } : {});
  const r = runDemoSimulation(input);
  renderKpi(r);
  renderChart(r);
  renderScenarioTable(runAllScenarios(input));
  renderStressTable();
  renderFlowTable(r);
  renderMonteCarlo();
}

function bindSwitch(id, key, onChange = () => {}) {
  $(id).addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    state[key] = btn.dataset[key === "scenarioKey" ? "scenario" : key === "dividendMode" ? "mode" : key === "dcaSource" ? "source" : "curve"];
    $(id).querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
    onChange();
    update();
  });
}

bindSwitch("scenarioSwitch", "scenarioKey");
bindSwitch("modeSwitch", "dividendMode");
bindSwitch("sourceSwitch", "dcaSource");
bindSwitch("curveSwitch", "curve");
$("mcProfileSwitch").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.mcProfile = btn.dataset.profile;
  $("mcProfileSwitch").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
  update();
});
$("mcRunsSwitch").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.mcRuns = Number(btn.dataset.runs);
  $("mcRunsSwitch").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
  update();
});
$("mcFlexSwitch").addEventListener("click", (e) => {
  const btn = e.target.closest("button");
  if (!btn) return;
  state.mcFlexibility = btn.dataset.flex === "true";
  $("mcFlexSwitch").querySelectorAll("button").forEach((b) => b.classList.toggle("active", b === btn));
  update();
});
$("categoryInflation").addEventListener("change", (e) => { state.useCategoryInflation = e.target.checked; update(); });
$("stressInflation").addEventListener("change", (e) => { state.stressInflation = e.target.checked; update(); });
$("themeToggle").addEventListener("click", () => {
  const root = document.documentElement;
  root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
});
window.addEventListener("resize", () => {
  const r = runDemoSimulation(currentInput(state.curve === "target" ? { totalAssets: solveSafeTarget(), reserveIncluded: false } : {}));
  renderChart(r);
});

update();
