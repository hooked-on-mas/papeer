import assert from "node:assert/strict";
import { test } from "node:test";
import { discoveryDiagnostics } from "../src/features/references/discoveryDiagnostics.ts";

test("coverage limits and rejected candidates do not claim a fetch failure", () => {
  const notices = ["DOIのない参考文献の外部照合を20件で区切りました。",
    "Semantic Scholarの書誌情報が不十分な候補14件は、PDFの参考文献と照合できないため除外しました。"];
  assert.deepEqual(discoveryDiagnostics(notices), { notices, errors: [] });
  const failure = "Semantic Scholarの参考文献を一部取得できませんでした：HTTP 429";
  assert.deepEqual(discoveryDiagnostics([...notices, failure]), { notices, errors: [failure] });
  assert.deepEqual(discoveryDiagnostics(["未知の取得問題"]), { notices: [], errors: ["未知の取得問題"] });
});
