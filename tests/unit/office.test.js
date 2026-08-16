import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const base = fs.mkdtempSync(path.join(os.homedir(), ".sol-office-test-"));
process.env.BRIDGE_STATE_DIR = path.join(base, "state");
process.env.WORKSPACE_ROOTS = base;
const { readOfficeFile, writeOfficeFile } = await import("../../src/lib/office.js");

test.after(() => fs.rmSync(base, { recursive: true, force: true }));

test("DOCX write/read round-trip is cross-platform", async () => {
  const target = path.join(base, "sample.docx");
  const written = await writeOfficeFile(target, "Hello\nBridge");
  assert.equal(written.format, "docx");
  const read = await readOfficeFile(target);
  assert.match(read.text, /Hello/);
  assert.match(read.text, /Bridge/);
});

test("XLSX write/read round-trip supports structured sheets", async () => {
  const target = path.join(base, "sample.xlsx");
  await writeOfficeFile(target, JSON.stringify({ sheets: [{ name: "Data", rows: [["name", "value"], ["alpha", 1]] }] }));
  const read = await readOfficeFile(target);
  assert.equal(read.sheets[0].name, "Data");
  assert.deepEqual(read.sheets[0].rows[1].slice(0, 2), ["alpha", 1]);
});
