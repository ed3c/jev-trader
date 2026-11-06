import { expect, test } from "@playwright/test";

test("operations view shows synthetic provenance, current state and coherent totals", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:3100/dashboard");
  await expect(page.locator("#state")).toHaveText("ready");
  await expect(page.locator("#mode")).toContainText("PAPER | synthetic");
  await expect(page.locator("#pending")).toHaveText("0 unresolved operations");
  await expect(page.locator("#pnl")).toHaveText(/^\$-?\d+\.\d{4}$/);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("operations.png"), fullPage: true });
});

test("Next dashboard receives the stream and labels policy separately from confidence", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:3001/");
  await expect(page.getByText("EXECUTION POLICY", { exact: true })).toBeVisible();
  await expect(page.getByText("Deterministic rules. Values are not calibrated confidence.", { exact: true })).toBeVisible();
  await expect(page.getByText("0 unresolved operations", { exact: true })).toBeVisible();
  await expect(page.getByText("ready", { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("dashboard.png"), fullPage: true });
});
