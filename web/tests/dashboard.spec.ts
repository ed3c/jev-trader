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
  await page.screenshot({ path: info.outputPath("operations.png"), fullPage: true, animations: "disabled" });
});

test("Next dashboard receives the stream and labels policy separately from confidence", async ({ page }, info) => {
  const errors: string[] = [];
  page.on("pageerror", error => errors.push(error.message));
  await page.goto("http://127.0.0.1:3001/");
  await expect(page.getByText("EXECUTION POLICY", { exact: true })).toBeVisible();
  await expect(page.getByText("Deterministic rules. Values are not calibrated confidence.", { exact: true })).toBeVisible();
  await expect(page.getByText("0 unresolved operations", { exact: true })).toBeVisible();
  await expect(page.getByText("ready", { exact: true })).toBeVisible();
  const price = page.getByTestId("chart-price");
  const policy = page.getByTestId("chart-policy");
  await expect(price).toBeVisible();
  await expect(policy).toBeVisible();
  const priceBox = await price.boundingBox();
  const policyBox = await policy.boundingBox();
  const summaryBox = await page.getByTestId("chart-summary").boundingBox();
  if (!priceBox || !policyBox || !summaryBox) throw new Error("Missing chart summary bounds");
  const overlapX = Math.min(priceBox.x + priceBox.width, policyBox.x + policyBox.width) - Math.max(priceBox.x, policyBox.x);
  const overlapY = Math.min(priceBox.y + priceBox.height, policyBox.y + policyBox.height) - Math.max(priceBox.y, policyBox.y);
  expect(overlapX <= 0 || overlapY <= 0, "chart price and policy must not overlap").toBe(true);
  for (const bounds of [priceBox, policyBox]) {
    expect(bounds.x).toBeGreaterThanOrEqual(summaryBox.x - 1);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(summaryBox.x + summaryBox.width + 1);
  }
  const line = page.getByTestId("chart-price-line");
  await expect(line).toBeVisible();
  const lineBox = await line.boundingBox();
  if (!lineBox) throw new Error("Missing chart price line bounds");
  expect(lineBox.y, "price plot must remain below the summary").toBeGreaterThan(summaryBox.y + summaryBox.height);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  expect(errors).toEqual([]);
  await page.screenshot({ path: info.outputPath("dashboard.png"), fullPage: true, animations: "disabled" });
});
