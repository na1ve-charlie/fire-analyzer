// 滚动到压力面板截图：暗黑 + 浅色各一张。
const { chromium } = require("playwright-core");

(async () => {
  const browser = await chromium.launch({ headless: true, executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", args: ["--headless=new"] });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1200 } });
  await page.goto("http://127.0.0.1:8123/index.html", { waitUntil: "networkidle" });
  await page.waitForTimeout(900);

  await page.evaluate(() => document.querySelector("#stress").scrollIntoView({ block: "start" }));
  await page.waitForTimeout(500);
  await page.screenshot({ path: "tests/stress-panel-light.png" });

  await page.click("#themeToggle");
  await page.waitForTimeout(500);
  await page.screenshot({ path: "tests/stress-panel-dark.png" });

  // 滚到面板下半部分（曲线 + insight）
  await page.evaluate(() => window.scrollBy(0, 700));
  await page.waitForTimeout(400);
  await page.screenshot({ path: "tests/stress-panel-dark-bottom.png" });

  await browser.close();
  console.log("screenshots saved");
})();
