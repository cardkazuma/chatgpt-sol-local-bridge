import test from "node:test";
import assert from "node:assert/strict";
import { splitArgs } from "../../src/lib/text.js";

test("splitArgs preserves Windows paths and quoted spaces", () => {
  assert.deepEqual(splitArgs('add C:\\repo\\file.txt "two words"'), ["add", "C:\\repo\\file.txt", "two words"]);
  assert.deepEqual(splitArgs("click 400,300"), ["click", "400,300"]);
});

test("splitArgs supports escaped whitespace without stripping ordinary backslashes", () => {
  assert.deepEqual(splitArgs("open hello\\ world C:\\work"), ["open", "hello world", "C:\\work"]);
});
