import test from "node:test";
import assert from "node:assert/strict";
import { escapeRegex } from "../src/services/common.js";
test("directory searches treat regex syntax as literal text", () => {
  const search = "a+b[c].*";
  const regex = new RegExp(escapeRegex(search), "i");
  assert.ok(regex.test(search));
  assert.equal(regex.test("aaabcZZZ"), false);
});
