import type { Page } from "playwright-core";

/** Account actions stay reachable without occupying the reading header with labels. */
export async function clickAccountAction(page: Page, name: string) {
  await page.getByRole("button", { name: "Google接続メニュー", exact: true }).click();
  await page.getByRole("menuitem", { name, exact: true }).click();
}
