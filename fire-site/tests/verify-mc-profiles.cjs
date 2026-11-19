"use strict";
// 无头验证：MC 面板六组合按钮/持仓表/LEAD 文案/成功率联动。
const { chromium } = require("playwright-core");

const BASE = "http://127.0.0.1:8321/index.html";
const PROFILES = [
  ["portfolioA", "组合一 · 进攻", "2007-01-04 ~ 2026-11-09"],
  ["portfolioB57", "组合二 · 5–7年基线", "2011-01-04 ~ 2026-11-09"],
  ["portfolioB10y", "组合二 · 10年指数", "2011-01-04 ~ 2026-11-09"],
  ["portfolioB30y", "组合二 · 30年指数", "2011-01-04 ~ 2026-11-09"],
  ["portfolioB10etf", "组合二 · 10年ETF", "2023-06-13 ~ 2026-11-09"],
  ["portfolioB30etf", "组合二 · 30年ETF", "2023-06-13 ~ 2026-11-09"]
];

(async () => {
  const browser = await chromium.launch({
    headless: true,
    executablePath: "C:/Program Files/Google/Chrome/Application/chrome.exe"
  });
  const page = await browser.newPage();
  page.on("pageerror", (err) => { console.error("PAGEERROR:", err.message); process.exitCode = 1; });
  await page.goto(BASE, { waitUntil: "networkidle" });
  await page.waitForTimeout(2500);

  const buttons = await page.$$eval("[data-mc-profile]", (els) => els.map((el) => el.dataset.mcProfile));
  console.log("buttons:", JSON.stringify(buttons));
  if (buttons.length !== 10) { console.error("FAIL: 按钮数量", buttons.length); process.exitCode = 1; }

  for (const [key, label, period] of PROFILES) {
    await page.click(`[data-mc-profile="${key}"]`);
    await page.waitForTimeout(2200);
    const badge = await page.$eval("#mcBadge", (el) => el.textContent.trim());
    const lead = await page.$eval("#mcLead", (el) => el.textContent);
    const rows = await page.$$eval("#mcHoldingsTable tbody tr", (els) => els.length);
    const kpi = await page.$eval("#mcKpis article strong", (el) => el.textContent.trim());
    const okBadge = badge.includes(label);
    const okPeriod = lead.includes(period);
    const okEtfNote = key.startsWith("portfolioB10etf") || key.startsWith("portfolioB30etf")
      ? lead.includes("不可直接横比") : !lead.includes("不可直接横比");
    console.log(`${okBadge && okPeriod && okEtfNote && rows >= 5 ? "OK " : "FAIL"} ${key} | badge=${badge} | rows=${rows} | successRate=${kpi} | periodInLead=${okPeriod} | etfNote=${okEtfNote}`);
    if (!(okBadge && okPeriod && okEtfNote && rows >= 5)) process.exitCode = 1;
  }

  // 杠杆面板的资产配置对比也应包含全部组合标签
  await page.click("#runLeverAnalysis");
  await page.waitForTimeout(4000);
  const profileRows = await page.$$eval("#profileTable tbody tr td:first-child", (els) => els.map((el) => el.textContent.trim()));
  console.log("profileTable:", JSON.stringify(profileRows));
  const missing = PROFILES.filter(([, label]) => !profileRows.includes(label));
  if (missing.length) { console.error("FAIL: 杠杆面板缺少", missing.map((m) => m[1])); process.exitCode = 1; }

  await browser.close();
  console.log(process.exitCode ? "VERIFICATION FAILED" : "ALL CHECKS PASSED");
})();
