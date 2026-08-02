// Manual-browser verification helper for the dashboard Timeline view.
// Drives the real dashboard with Playwright, opens the 150-iteration session,
// switches to the Timeline tab, and prints DOM facts (cell counts per
// category, marker kinds, summary chips, console errors) so a text-only
// harness can confirm the visual feature actually renders against real data.
import { chromium } from "playwright";

const BASE = process.env.DASHBOARD_URL || "http://127.0.0.1:4393";
const SESSION_ID = "ac0ef2c9-43f1-43c3-a604-aa6342d90885";

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1400, height: 1200 } });
const consoleErrors = [];
page.on("console", (m) => {
  if (m.type() === "error") consoleErrors.push(m.text());
});
page.on("pageerror", (e) => consoleErrors.push("pageerror: " + e.message));

try {
  await page.goto(BASE, { waitUntil: "domcontentloaded", timeout: 20000 });

  // Wait for the sessions table to render (summary poll).
  await page.waitForSelector('tr.session-row[data-session-id="' + SESSION_ID + '"]', { timeout: 15000 });
  console.log("OK sessions table rendered; row count =", await page.locator("tr.session-row").count());

  // Open the 150-iteration session.
  await page.click('tr.session-row[data-session-id="' + SESSION_ID + '"]');
  await page.waitForSelector("#detail.view-chat, #detail.view-log", { timeout: 15000 });
  console.log("OK detail panel open, session id =", await page.locator("#detailSessionId").textContent());

  // Wait for the feed to populate, then switch to the Timeline tab.
  await page.waitForTimeout(2500);
  await page.click("#tabTimeline");
  await page.waitForSelector("#detail.view-timeline", { timeout: 10000 });

  // Give renderTimeline a beat to paint.
  await page.waitForTimeout(1500);

  const facts = await page.evaluate(() => {
    const cells = Array.from(document.querySelectorAll("#timeline .tl-cell"));
    const byCat = {};
    for (const c of cells) {
      const m = (c.className || "").match(/tl-cat-([a-z]+)/);
      const k = m ? m[1] : "unknown";
      byCat[k] = (byCat[k] || 0) + 1;
    }
    const markers = Array.from(document.querySelectorAll("#timeline .tl-marker"));
    const markerKinds = {};
    for (const mk of markers) {
      const m = (mk.className || "").match(/tl-mk-([a-z]+)/);
      const k = m ? m[1] : "unknown";
      markerKinds[k] = (markerKinds[k] || 0) + 1;
    }
    const chips = Array.from(document.querySelectorAll("#timeline .tl-marker-chip")).map((e) => e.textContent.trim());
    const summary = Array.from(document.querySelectorAll("#timeline .tl-summary .tl-stat")).map((e) => e.textContent.trim());
    const rows = Array.from(document.querySelectorAll("#timeline .tl-iter-row")).length;
    const empty = document.querySelector("#timeline .tl-empty");
    return {
      cells: cells.length,
      byCat,
      markers: markers.length,
      markerKinds,
      chips,
      summary,
      expandableRows: rows,
      empty: empty ? empty.textContent.trim() : null,
    };
  });
  console.log("TIMELINE_FACTS " + JSON.stringify(facts, null, 2));

  // Expand the first iteration row (click its head) to confirm drill-down.
  const firstHead = page.locator("#timeline .tl-iter-head").first();
  if ((await firstHead.count()) > 0) {
    await firstHead.click();
    await page.waitForTimeout(300);
    const expansion = await page.evaluate(() => {
      const head = document.querySelector("#timeline .tl-iter-head");
      const body = document.querySelector("#timeline .tl-iter-body");
      return {
        headOpen: head ? head.classList.contains("open") : false,
        bodyShown: body ? body.style.display === "block" : false,
        bodyText: body ? body.textContent.trim().slice(0, 160) : null,
      };
    });
    console.log("EXPAND_FIRST_ROW " + JSON.stringify(expansion, null, 2));
  }

  await page.screenshot({ path: ".headlesscode/browser-screenshots/timeline-real-data.png", fullPage: false });
  console.log("SCREENSHOT saved to .headlesscode/browser-screenshots/timeline-real-data.png");
} catch (err) {
  console.error("FAILED:", err.message);
  process.exitCode = 1;
} finally {
  if (consoleErrors.length) {
    console.log("CONSOLE_ERRORS");
    for (const e of consoleErrors) console.log("  " + e);
  } else {
    console.log("CONSOLE_ERRORS none");
  }
  await browser.close();
}
