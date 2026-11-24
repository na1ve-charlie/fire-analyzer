// 压力测试面板浏览器实测：渲染、交互、暗黑模式一次性检查。
const { chromium } = require("playwright-core");

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", args: ["--headless=new"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (err) => errors.push(`PAGE ERROR: ${err.message}`));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(`CONSOLE: ${msg.text()}`);
  });

  await page.goto("http://127.0.0.1:8123/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  const panel = await page.$("#stress");
  console.log("1. 压力面板存在:", Boolean(panel));
  console.log("2. KPI 卡数量:", await page.$$eval("#stressKpis article", (els) => els.length));
  console.log("3. 预警灯文案:", (await page.$eval("#stressAlert strong", (el) => el.textContent)).trim());
  console.log("4. 水桶现金:", await page.$eval("#bucketCash", (el) => el.textContent));
  console.log("5. 场景表行数:", await page.$$eval("#stressTable tbody tr", (els) => els.length));
  console.log("6. 曲线 SVG 子元素:", await page.$eval("#stressChart", (el) => el.children.length));
  console.log("7. 面板徽章:", (await page.$eval("#stressBadge", (el) => el.textContent)).trim());
  console.log("8. insight 长度:", (await page.$eval("#stressInsight", (el) => el.textContent)).length > 50);

  // 切场景：1929 大萧条
  await page.click('[data-stress-scenario="depression1929"]');
  await page.waitForTimeout(400);
  console.log("9. 1929 场景预警灯:", (await page.$eval("#stressAlert", (el) => el.className)).trim());
  console.log("10. 1929 KPI 首卡:", (await page.$eval("#stressKpis article strong", (el) => el.textContent)).trim());

  // 切自定义冲击
  await page.click('[data-stress-scenario="custom"]');
  await page.waitForTimeout(400);
  const customVisible = await page.$eval("#stressCustom", (el) => !el.hidden);
  console.log("11. 自定义冲击区可见:", customVisible);
  await page.fill("#stressDepth", "55");
  await page.fill("#stressLength", "3");
  await page.fill("#stressInflation", "5");
  await page.waitForTimeout(700);
  console.log("12. 自定义冲击预警灯:", (await page.$eval("#stressAlert", (el) => el.className)).trim());
  console.log("13. 自定义 KPI 回撤:", (await page.$eval("#stressKpis article strong", (el) => el.textContent)).trim());

  // GK 开关
  await page.click('[data-stress-scenario="gfc2008"]');
  await page.waitForTimeout(300);
  await page.click('[data-stress-gk="true"]');
  await page.waitForTimeout(400);
  console.log("14. GK 开启后预警灯:", (await page.$eval("#stressAlert", (el) => el.className)).trim());
  console.log("15. GK 文案含护栏:", (await page.$eval("#stressAlert", (el) => el.textContent)).includes("减提") || (await page.$eval("#stressInsight", (el) => el.textContent)).includes("护栏"));

  // 参数联动：改年化收益率，压力面板应防抖重算
  await page.fill("#returnInput", "7");
  await page.waitForTimeout(700);
  console.log("16. 收益率改 7% 后表行数:", await page.$$eval("#stressTable tbody tr", (els) => els.length));

  // 暗黑模式
  await page.click("#themeToggle");
  await page.waitForTimeout(400);
  const theme = await page.evaluate(() => document.documentElement.dataset.theme);
  const alertBg = await page.$eval("#stressAlert", (el) => getComputedStyle(el).backgroundColor);
  console.log("17. 暗黑模式:", theme, "预警灯背景:", alertBg);
  await page.screenshot({ path: "tests/stress-dark.png", clip: { x: 0, y: 0, width: 1440, height: 900 }, fullPage: false });

  // 移动端视口
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  const kpiCols = await page.$eval("#stressKpis", (el) => getComputedStyle(el).gridTemplateColumns.split(" ").length);
  console.log("18. 移动端 KPI 列数:", kpiCols);
  await page.screenshot({ path: "tests/stress-mobile.png", fullPage: false });

  console.log("\n错误汇总:", errors.length === 0 ? "无（favicon 404 除外）" : errors.filter((e) => !e.includes("favicon")).join("\n") || "仅 favicon 404");
  await browser.close();
})();
