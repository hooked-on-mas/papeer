import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { build } from "vite";
import { distributionLicenses } from "../buildLicenses.ts";

function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "papeer-public-build-"));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const publicDir = path.join(directory, "public");
  fs.mkdirSync(publicDir);
  const entry = path.join(directory, "entry.js");
  fs.writeFileSync(entry, "export const example = 1;");
  return { directory, publicDir, options: { configFile: false, root: directory, publicDir,
    plugins: [distributionLicenses()], logLevel: "silent",
    build: { write: false, rolldownOptions: { input: entry } } } };
}

test("public builds refuse local documents, credentials and caches", async t => {
  for (const file of [".env.production", "client_secret_test.json", "paper.pdf", "library.sqlite3", "nested/__pycache__/script.pyc"]) {
    const { publicDir, options } = fixture(t);
    const target = path.join(publicDir, file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, "private test data");
    await assert.rejects(build(options), /Local data must not be distributed/);
  }
});

test("distributed builds carry the application license, source instructions and font notice", async t => {
  const { options } = fixture(t);
  const result = await build(options);
  const files = new Map(result.output.filter(item => item.type === "asset").map(item => [item.fileName, String(item.source)]));
  assert.match(files.get("LICENSE"), /GNU AFFERO GENERAL PUBLIC LICENSE/);
  assert.match(files.get("SOURCE.md"), /corresponding source/);
  assert.match(files.get("geist-OFL.txt"), /SIL OPEN FONT LICENSE/);
});
