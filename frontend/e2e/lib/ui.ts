/** Finding things on the app's screen: shared by the scenarios in e2e/tests. */
import type { Locator, Page } from "playwright-core";
import { waitFor } from "./processes.ts";

/** A paper's (or folder's) row in the library tree. */
export function libraryRow(page: Page, text: string): Locator {
  return page.locator("[role=treeitem]").filter({ hasText: text });
}

/** The rows of the library tree, in order: the first line of each and its level (1 folder, 2 paper). */
export async function libraryRows(page: Page): Promise<{ level: number; text: string }[]> {
  return page.evaluate(() => [...document.querySelectorAll("[role=treeitem]")].map((row) => ({
    level: Number(row.getAttribute("aria-level")),
    text: (row as HTMLElement).innerText.split("\n")[0],
  })));
}

/** The folder a paper's row is shown in (the folder row above it), or null. */
export async function folderOfRow(page: Page, paperText: string): Promise<string | null> {
  const rows = await libraryRows(page);
  const index = rows.findIndex((row) => row.level > 1 && row.text.includes(paperText));
  if (index < 0) return null;
  for (let i = index - 1; i >= 0; i--) if (rows[i].level < rows[index].level) return rows[i].text;
  return null;
}

/** Waits until the library shows every text in `texts`. */
export async function waitForLibrary(page: Page, texts: string[], timeout = 30_000): Promise<void> {
  await waitFor(async () => {
    const rows = (await libraryRows(page)).map((row) => row.text);
    return texts.every((text) => rows.some((row) => row.includes(text)));
  }, `ライブラリに ${texts.join("・")} が表示されること`, timeout, 200);
}

/** Opens a paper from the library and waits until its first page is drawn. */
export async function openPaper(page: Page, text: string): Promise<void> {
  await libraryRow(page, text).click();
  await page.locator("h1", { hasText: text }).waitFor();
  await page.locator("[data-page-number] canvas").first().waitFor({ timeout: 30_000 });
}

/** Opens a side panel (メモ, サマリー, チャット) next to the PDF or closes it, from the toolbar or its 「…」 menu. */
export async function toggleSidePanel(page: Page, label: string): Promise<void> {
  const name = `${label}を右に表示`;
  const direct = page.getByRole("button", { name, exact: true });
  if (await direct.count() && await direct.first().isVisible()) {
    await direct.first().click();
    return;
  }
  await page.getByRole("button", { name: "その他の表示・操作" }).click();
  await page.getByRole("menu").getByRole("menuitem", { name }).click();
  await page.getByRole("menu").waitFor({ state: "detached" });
}

/** Where the view is in the original PDF's pane: the page in the page field and the fraction of it above the view. */
export async function readingPlace(page: Page): Promise<{ page: string; y: number; scrollTop: number }> {
  return page.evaluate(() => {
    const input = document.querySelector<HTMLInputElement>('input[aria-label="ページ番号"]');
    const number = input?.value ?? "";
    const pageBox = document.querySelector(`[data-page-number="${number}"]`);
    let scroller = pageBox?.parentElement ?? null;
    while (scroller && !["auto", "scroll"].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    if (!pageBox || !scroller) return { page: number, y: Number.NaN, scrollTop: Number.NaN };
    const pageRect = pageBox.getBoundingClientRect();
    const paneRect = scroller.getBoundingClientRect();
    return { page: number, y: (paneRect.top - pageRect.top) / pageRect.height, scrollTop: scroller.scrollTop };
  });
}

/** Each drawn page against the visible part of the pane that scrolls it. */
export async function pageFits(page: Page): Promise<{ page: string; pageRight: number; paneRight: number; sideways: boolean }[]> {
  return page.evaluate(() => [...document.querySelectorAll("[data-page-number]")].map((box) => {
    let scroller = box.parentElement;
    while (scroller && !["auto", "scroll"].includes(getComputedStyle(scroller).overflowY)) scroller = scroller.parentElement;
    const pageRect = box.getBoundingClientRect();
    const paneRect = scroller?.getBoundingClientRect();
    const overflowX = scroller ? getComputedStyle(scroller).overflowX : "hidden";
    return {
      page: box.getAttribute("data-page-number") ?? "",
      pageRight: pageRect.right,
      paneRight: paneRect && scroller ? paneRect.left + scroller.clientWidth : 0,
      // The rest of a wider page can be scrolled to.
      sideways: !!scroller && ["auto", "scroll"].includes(overflowX) && scroller.scrollWidth > scroller.clientWidth,
    };
  }));
}

/** The text of the toasts on screen. */
export async function toastTexts(page: Page): Promise<string> {
  return page.evaluate(() => (document.querySelector<HTMLElement>('[aria-label="通知"]')?.innerText ?? "").trim());
}

/** Watches the requests with a body that the page sends to the sidecar. */
export function watchSidecarWrites(page: Page): { method: string; path: string; body: string | null }[] {
  const writes: { method: string; path: string; body: string | null }[] = [];
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.hostname === "127.0.0.1" && url.port === "8000" && request.method() !== "GET") {
      writes.push({ method: request.method(), path: url.pathname, body: request.postData() });
    }
  });
  return writes;
}

/**
 * Times, with the page's own clock, how long the screen takes to follow the next click: armed before the
 * click, it records the click and the first change of the page after which `condition` holds. Measured in
 * the page, so that the time Playwright takes to look (over CDP, slow on a busy PC) does not count.
 * `condition` names a check in `checks` below (functions cannot be sent to the page with their closures).
 */
export async function armClickTimer(page: Page, condition: "dialog closed" | { rowInFolder: [paper: string, folder: string] }): Promise<void> {
  await page.evaluate((condition) => {
    const w = window as unknown as { __e2eTimer?: { click: number | null; done: number | null } };
    const timer = { click: null as number | null, done: null as number | null };
    w.__e2eTimer = timer;
    // Room for the requests from now on (the buffer is full of the page's modules; see clickTimings).
    performance.clearResourceTimings();
    performance.setResourceTimingBufferSize(1000);
    document.addEventListener("click", () => { timer.click ??= performance.now(); }, { capture: true, once: true });
    const holds = () => {
      if (condition === "dialog closed") return !document.querySelector("[role=dialog]");
      const [paper, folder] = condition.rowInFolder;
      const rows = [...document.querySelectorAll("[role=treeitem]")].map((row) => ({
        level: Number(row.getAttribute("aria-level")), text: (row as HTMLElement).innerText.split("\n")[0] }));
      const index = rows.findIndex((row) => row.level > 1 && row.text.includes(paper));
      for (let i = index - 1; index > 0 && i >= 0; i--) if (rows[i].level < rows[index].level) return rows[i].text === folder;
      return false;
    };
    new MutationObserver((_, observer) => {
      if (timer.click !== null && holds()) {
        timer.done = performance.now();
        observer.disconnect();
      }
    }).observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
  }, condition);
}

/**
 * The armed timer's result, in ms of page time: from the click to the change (`done`), and, when
 * `request` names the path of a request sent after the click, from that request's answer to the change.
 */
export async function clickTimings(page: Page, request?: string): Promise<{ afterClick: number | null; afterAnswer: number | null }> {
  return page.evaluate((request) => {
    const timer = (window as unknown as { __e2eTimer?: { click: number | null; done: number | null } }).__e2eTimer;
    if (!timer || timer.click === null || timer.done === null) return { afterClick: null, afterAnswer: null };
    const answer = request === undefined ? undefined : (performance.getEntriesByType("resource") as PerformanceResourceTiming[])
      .find((entry) => new URL(entry.name).pathname === request && entry.startTime >= (timer.click ?? 0));
    return { afterClick: timer.done - timer.click, afterAnswer: answer ? timer.done - answer.responseEnd : null };
  }, request);
}
