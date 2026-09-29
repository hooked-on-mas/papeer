// The isolation rules of the end-to-end tests (e2e/lib/env.ts): checked here without launching anything.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { isInside, isolatedDirs, isolatedEnv, pathWithoutAiClis, userDataDir } from "../e2e/lib/env.ts";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "papeer-e2eenv-test-"));
}

test("isolatedEnv points every user folder into the test's folder and drops tokens and API keys", () => {
  const root = tempDir();
  try {
    const dirs = isolatedDirs(root);
    const env = isolatedEnv({
      PATH: "C:\\Windows", PAPEER_TOKEN: "t", PAPERDESK_DATA_DIR: "x", OPENAI_API_KEY: "k", ANTHROPIC_API_KEY: "k",
      GEMINI_API_KEY: "k", VIRTUAL_ENV: "v", WEBVIEW2_USER_DATA_FOLDER: "real", CODEX_HOME: "real", SystemRoot: "C:\\Windows",
      XDG_STATE_HOME: "/home/me/.local/state", TMPDIR: "/tmp",
    }, dirs, { PAPEER_PORT: "8000" });
    for (const name of ["PAPEER_TOKEN", "PAPERDESK_DATA_DIR", "OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "VIRTUAL_ENV"]) {
      assert.equal(env[name], undefined, name);
    }
    for (const name of ["PAPEER_DATA_DIR", "LOCALAPPDATA", "APPDATA", "USERPROFILE", "HOME", "CODEX_HOME", "TEMP", "TMP", "TMPDIR",
      "WEBVIEW2_USER_DATA_FOLDER", "XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]) {
      assert.ok(isInside(env[name] ?? "", root), `${name}=${env[name]}`);
    }
    assert.equal(env.SystemRoot, "C:\\Windows");
    assert.equal(env.PAPEER_PORT, "8000");
    assert.deepEqual(Object.keys(env).filter((name) => name.toUpperCase() === "PATH"), ["Path"]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("pathWithoutAiClis leaves out the folders that hold claude, codex or agy", () => {
  const root = tempDir();
  try {
    const withCli = path.join(root, "npm");
    const plain = path.join(root, "tools");
    fs.mkdirSync(withCli);
    fs.mkdirSync(plain);
    fs.writeFileSync(path.join(withCli, "codex.cmd"), "");
    assert.equal(pathWithoutAiClis([withCli, plain, ""].join(path.delimiter)), plain);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("userDataDir reads --user-data-dir from a WebView2 command line, quoted or not", () => {
  assert.equal(userDataDir('"msedgewebview2.exe" --embedded-browser-webview=1 --user-data-dir="C:\\A B\\EBWebView" --noerrdialogs'), "C:\\A B\\EBWebView");
  assert.equal(userDataDir("msedgewebview2.exe --user-data-dir=C:\\A\\EBWebView --lang=ja"), "C:\\A\\EBWebView");
  assert.equal(userDataDir("msedgewebview2.exe --type=renderer"), null);
});

test("isInside compares Windows paths without regard to case and rejects neighbours", () => {
  assert.ok(isInside("C:\\Temp\\run\\webview2\\EBWebView", "c:\\temp\\run\\webview2"));
  assert.ok(isInside("C:\\Temp\\run", "C:\\Temp\\run"));
  assert.ok(!isInside("C:\\Temp\\run2\\webview2", "C:\\Temp\\run"));
  assert.ok(!isInside("C:\\Users\\me\\AppData\\Local\\local.paperdesk\\EBWebView", "C:\\Temp\\run"));
});
