import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../", import.meta.url));
// Curated core Web E2E suites covering everyday workflows, Drive sync, and offline PWA shell.
// Run sequentially: browsers and real Python PDF generation share the runner's resources.
const suites = [
  "e2e/tests/library/webOrdinaryLibraryCrud.browser.test.ts",
  "e2e/tests/library/webOrdinaryLibraryQuery.browser.test.ts",
  "e2e/tests/notebooks/webOrdinaryNotebookPages.browser.test.ts",
  "e2e/tests/notes/webOrdinaryMarkdownLifecycle.browser.test.ts",
  "e2e/tests/reader/p2/webOrdinaryPdf.browser.test.ts",
  "e2e/tests/reader/p2/webOrdinaryTools.browser.test.ts",
  "e2e/tests/workspace/webOrdinaryFocus.browser.test.ts",
  "e2e/tests/workspace/webOrdinaryWorkspacePreferences.browser.test.ts",
  "e2e/tests/bootstrap/provider/webProviderOrdinary.browser.test.ts",
  "e2e/tests/library/composition/webLibraryAutomaticReceive.browser.test.ts",
  "e2e/tests/bootstrap/provider/webProviderOfflineOrdinary.browser.test.ts",
  "e2e/tests/bootstrap/provider/webProviderPwaShell.browser.test.ts",
];
if (process.env.PAPEER_PWA_TEST_URL) suites.push("e2e/publishedPwa.browser.test.ts");
if (process.argv.includes("--list")) { console.log(JSON.stringify(suites)); process.exit(0); }
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...suites], { cwd: frontend, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
