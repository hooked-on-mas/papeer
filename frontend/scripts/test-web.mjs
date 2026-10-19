import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const frontend = fileURLToPath(new URL("../", import.meta.url));
// Discover every Web browser suite, so new suites cannot silently miss the release gate.
// Run sequentially: browsers and real Python PDF generation share the runner's resources.
const suites = readdirSync(new URL("../e2e/", import.meta.url))
  .filter(name => /^web.*\.browser\.test\.ts$/.test(name) || name === "pdfReaderResize.browser.test.ts")
  .sort().map(name => `e2e/${name}`);
if (!suites.length) throw new Error("No Web browser suites were found.");
if (process.env.PAPEER_PWA_TEST_URL) suites.push("e2e/publishedPwa.browser.test.ts");
if (process.argv.includes("--list")) { console.log(JSON.stringify(suites)); process.exit(0); }
const result = spawnSync(process.execPath, ["--test", "--test-concurrency=1", ...suites], { cwd: frontend, stdio: "inherit" });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
