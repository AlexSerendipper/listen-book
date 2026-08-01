import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chromium } from "file:///C:/Users/alexzhong/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/playwright/index.mjs";

const baseUrl = "http://127.0.0.1:8765";
const screenshot = "C:/Users/alexzhong/.codex/visualizations/2026/08/01/019fbbe6-6a5e-73f0-a8a6-5e8430464b3e/mobile-pwa-smoke.png";
const readerScreenshot = "C:/Users/alexzhong/.codex/visualizations/2026/08/01/019fbbe6-6a5e-73f0-a8a6-5e8430464b3e/mobile-pwa-reader-v7.png";
const layoutScreenshot = "C:/Users/alexzhong/.codex/visualizations/2026/08/01/019fbbe6-6a5e-73f0-a8a6-5e8430464b3e/mobile-pwa-layout-v7.png";
const libraryScreenshot = "C:/Users/alexzhong/.codex/visualizations/2026/08/01/019fbbe6-6a5e-73f0-a8a6-5e8430464b3e/mobile-pwa-library-v7.png";
const libraryExpandedScreenshot = "C:/Users/alexzhong/.codex/visualizations/2026/08/01/019fbbe6-6a5e-73f0-a8a6-5e8430464b3e/mobile-pwa-library-expanded-v7.png";
const errors = [];
async function swipeLeft(targetPage) {
  await targetPage.evaluate(() => {
    const pages = document.querySelector("#readerPages");
    const touch = (x) => new Touch({ identifier: 1, target: pages, clientX: x, clientY: 400 });
    pages.dispatchEvent(new TouchEvent("touchstart", { touches: [touch(330)], bubbles: true }));
    pages.dispatchEvent(new TouchEvent("touchend", { changedTouches: [touch(40)], bubbles: true }));
  });
}
async function tapReader(targetPage, x, selector = "#readerPages", holdMs = 0) {
  await targetPage.evaluate(({ clientX, targetSelector }) => {
    const target = document.querySelector(targetSelector);
    const touch = new Touch({ identifier: 2, target, clientX, clientY: 400 });
    target.dispatchEvent(new TouchEvent("touchstart", { touches: [touch], bubbles: true }));
  }, { clientX: x, targetSelector: selector });
  if (holdMs) await targetPage.waitForTimeout(holdMs);
  await targetPage.evaluate(({ clientX, targetSelector }) => {
    const target = document.querySelector(targetSelector);
    const touch = new Touch({ identifier: 2, target, clientX, clientY: 400 });
    target.dispatchEvent(new TouchEvent("touchend", { changedTouches: [touch], bubbles: true }));
  }, { clientX: x, targetSelector: selector });
}
const browser = await chromium.launch({ headless: true, channel: "chrome" });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.on("console", (message) => { if (message.type() === "error") errors.push(message.text()); });
page.on("pageerror", (error) => errors.push(String(error)));

await page.goto(`${baseUrl}/mobile/`, { waitUntil: "networkidle" });
await page.locator("#pairView").waitFor({ state: "visible" });
assert.equal(await page.locator("h1").innerText(), "随身书页");
assert(await page.locator("#pairCode").isVisible());
assert(await page.locator("#pairCode").isDisabled());
await page.evaluate(() => navigator.serviceWorker.ready.then(() => true));
await page.reload({ waitUntil: "networkidle" });
assert(await page.evaluate(() => Boolean(navigator.serviceWorker.controller)));
await context.setOffline(true);
await page.reload({ waitUntil: "domcontentloaded" });
await page.locator("#pairView").waitFor({ state: "visible" });
assert.equal(await page.locator("h1").innerText(), "随身书页");
await page.screenshot({ path: screenshot, fullPage: true });

await context.setOffline(false);
await page.goto(`${baseUrl}/mobile-admin/`, { waitUntil: "networkidle" });
assert(await page.getByRole("heading", { name: "连接手机" }).isVisible());
assert(await page.locator("#startPair").isVisible());

const contentHash = "a".repeat(64);
const packageData = {
  schema_version: 1,
  parser_version: "mobile-parser-v1",
  anchor_version: 1,
  book_content_hash: contentHash,
  metadata: { title: "离线测试书", author: "Test", format: "epub", epub_css: "" },
  chapters: [
    {
      chapter_index: 0,
      title: "扉页",
      paragraphs: [{
        paragraph_index: 0,
        text: "离线测试书",
        html: '<p>离线测试书</p><img src="asset://asset-cover">',
      }],
    },
    {
      chapter_index: 1,
      title: "第一章",
      paragraphs: Array.from({ length: 80 }, (_, index) => ({
        paragraph_index: index,
        text: `第 ${index + 1} 段。这是用于验证飞行模式阅读、连续分页与进度恢复的正文。价值投资要求耐心、安全边际与独立判断。`,
        html: index === 0
          ? `<div class="epub-fragment-page"><div class="epub-fragment"><p style="width: 900px; white-space: nowrap">${`移动端正文需要完整换行。`.repeat(30)}</p></div></div>`
          : null,
      })),
    },
  ],
};
const packageBytes = Buffer.from(JSON.stringify(packageData));
const imageBytes = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z1ZkAAAAASUVORK5CYII=",
  "base64",
);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const packageHash = hash(packageBytes);
const imageHash = hash(imageBytes);
const manifest = {
  schema_version: 1,
  parser_version: "mobile-parser-v1",
  anchor_version: 1,
  package_revision: hash(Buffer.from(packageHash + imageHash)),
  book_content_hash: contentHash,
  metadata: packageData.metadata,
  estimated_peak_bytes: packageBytes.length + imageBytes.length,
  resources: [
    { resource_id: "package", type: "chapter", byte_size: packageBytes.length, sha256: packageHash, required: true, url: `/api/mobile/books/${contentHash}/package` },
    { resource_id: "asset-cover", type: "image", byte_size: imageBytes.length, sha256: imageHash, required: true, url: `/api/mobile/books/${contentHash}/assets/asset-cover` },
  ],
};

const offlineContext = await browser.newContext({
  viewport: { width: 390, height: 844 },
  isMobile: true,
  hasTouch: true,
});
await offlineContext.addInitScript(() => {
  HTMLImageElement.prototype.decode = () => new Promise(() => {});
});
const offlinePage = await offlineContext.newPage();
await offlinePage.route("**/api/mobile/sync/manifest", (route) => route.fulfill({
  json: { books: [
    { content_hash: contentHash, title: "离线测试书", author: "测试作者", format: "epub", availability: "available" },
    { content_hash: "b".repeat(64), title: "未读书", author: "另一作者", format: "epub", availability: "available" },
  ] },
}));
await offlinePage.route(`**/api/mobile/books/${contentHash}/metadata`, (route) => route.fulfill({ json: manifest }));
await offlinePage.route(`**/api/mobile/books/${contentHash}/package`, (route) => route.fulfill({
  body: packageBytes,
  contentType: "application/json",
}));
await offlinePage.route(`**/api/mobile/books/${contentHash}/assets/asset-cover`, (route) => route.fulfill({
  body: imageBytes,
  contentType: "image/png",
}));
await offlinePage.goto(`${baseUrl}/mobile/`, { waitUntil: "networkidle" });
await offlinePage.evaluate(async () => {
  const database = await import("/mobile/src/db.js");
  await database.saveDevice({
    device_id: "browser-test-device",
    device_name: "Browser Test",
    credential: "test-credential",
  });
});
await offlinePage.evaluate(() => navigator.serviceWorker.ready.then(() => true));
await offlinePage.reload({ waitUntil: "networkidle" });
await offlinePage.locator("#refreshButton").click();
await offlinePage.getByText("离线测试书", { exact: true }).waitFor();
const targetCard = offlinePage.locator(".book-card").filter({ hasText: "离线测试书" });
const unreadCard = offlinePage.locator(".book-card").filter({ hasText: "未读书" });
assert.equal(await targetCard.locator(".book-details").isVisible(), false);
assert.equal(await unreadCard.locator(".book-details").isVisible(), false);
await offlinePage.waitForTimeout(450);
await offlinePage.screenshot({ path: libraryScreenshot, fullPage: true });
await targetCard.locator(".book-summary").click();
assert.equal(await targetCard.locator(".book-details").isVisible(), true);
assert.equal(await targetCard.getByText("测试作者", { exact: true }).isVisible(), true);
await offlinePage.screenshot({ path: libraryExpandedScreenshot, fullPage: true });
await unreadCard.locator(".book-summary").click();
assert.equal(await targetCard.locator(".book-details").isVisible(), false);
assert.equal(await unreadCard.locator(".book-details").isVisible(), true);
await unreadCard.locator(".book-summary").click();
assert.equal(await unreadCard.locator(".book-details").isVisible(), false);
await targetCard.locator(".book-summary").click();
await offlinePage.getByRole("button", { name: "下载" }).click();
await offlinePage.getByRole("button", { name: "继续阅读" }).waitFor();
await offlinePage.getByRole("button", { name: "继续阅读" }).click();
await offlinePage.locator("#readerView").waitFor({ state: "visible" });
assert.equal(await offlinePage.locator("#readerContent img").count(), 1);
await offlinePage.waitForFunction(() => document.querySelector("#pageIndicator").textContent === "第 1/2 章 · 1/1 页");
assert.equal(await offlinePage.locator("#nextPage").isVisible(), false);
await offlinePage.screenshot({ path: readerScreenshot });
await tapReader(offlinePage, 330, "#readerContent img");
assert.equal(await offlinePage.locator("#pageIndicator").innerText(), "第 1/2 章 · 1/1 页");
await tapReader(offlinePage, 330);
await offlinePage.waitForFunction(() => document.querySelector("#chapterTitle").textContent.startsWith("第一章 · 第 2/2 章"));
await offlinePage.waitForFunction(() => /^第 2\/2 章 · 1\/\d+ 页$/.test(document.querySelector("#pageIndicator").textContent));
const fixedWidthParagraph = offlinePage.locator("#readerContent p[style]");
assert.equal(await fixedWidthParagraph.evaluate((node) => getComputedStyle(node).whiteSpace), "normal");
assert((await fixedWidthParagraph.boundingBox()).width <= 346, "EPUB fixed-width text should fit the phone column");
assert.equal(await offlinePage.locator("#readerContent").evaluate((node) => (
  Number.parseFloat(getComputedStyle(node).columnWidth) === node.parentElement.clientWidth
)), true, "column width and page step should stay aligned");
await offlinePage.screenshot({ path: layoutScreenshot });
const firstPageLabel = await offlinePage.locator("#pageIndicator").innerText();
await swipeLeft(offlinePage);
assert.notEqual(await offlinePage.locator("#pageIndicator").innerText(), firstPageLabel);
const secondPageLabel = await offlinePage.locator("#pageIndicator").innerText();
await tapReader(offlinePage, 40);
assert.equal(await offlinePage.locator("#pageIndicator").innerText(), firstPageLabel);
await tapReader(offlinePage, 330);
assert.equal(await offlinePage.locator("#pageIndicator").innerText(), secondPageLabel);
await tapReader(offlinePage, 330, "#readerPages", 400);
assert.equal(await offlinePage.locator("#pageIndicator").innerText(), secondPageLabel);
const savedBook = await offlinePage.evaluate(async (hashValue) => {
  const database = await import("/mobile/src/db.js?v=8");
  return database.getRecord("books", hashValue);
}, contentHash);
assert(savedBook.last_read_at, "turning at least one page should update iPhone last-read time");
await offlinePage.locator("#closeReader").click();
await offlinePage.waitForFunction(() => document.querySelectorAll(".book-card.expanded").length === 0);
assert.equal(await offlinePage.locator(".book-details:visible").count(), 0);
assert.equal(await offlinePage.locator(".book-card .book-title").first().innerText(), "离线测试书");
await offlineContext.setOffline(true);
await offlinePage.reload({ waitUntil: "domcontentloaded" });
await offlinePage.getByText("离线测试书", { exact: true }).click();
await offlinePage.getByRole("button", { name: "继续阅读" }).waitFor();
await offlinePage.getByRole("button", { name: "继续阅读" }).click();
await offlinePage.locator("#readerView").waitFor({ state: "visible" });
await offlinePage.waitForFunction(() => /^第 2\/2 章 · \d+\/\d+ 页$/.test(document.querySelector("#pageIndicator").textContent));
const restoredPage = Number((await offlinePage.locator("#pageIndicator").innerText()).match(/· (\d+)\//)[1]);
assert(restoredPage > 1, "offline reopen should restore beyond the first page");
await offlineContext.close();
await browser.close();

assert.deepEqual(errors, [], `Browser console errors:\n${errors.join("\n")}`);
console.log(`mobile PWA browser smoke: passed; screenshot=${screenshot}`);
