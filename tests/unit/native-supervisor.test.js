import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const supervisor = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../scripts/native-supervisor.mjs");

for (const fixture of [
  { name: "an initially fresh window", prior: null },
  { name: "an expired prior window", prior: { version: 1, state: "RETRY", attempts: 4, windowStartedAt: Date.now() - 660_000, updatedAt: new Date(Date.now() - 660_000).toISOString() } },
]) {
  test(`native supervisor bounds real failed children from ${fixture.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-supervisor-"));
    try {
      const repoRoot = path.join(root, "repo");
      const scripts = path.join(repoRoot, "scripts");
      const stateRoot = path.join(root, "state");
      fs.mkdirSync(scripts, { recursive: true });
      fs.mkdirSync(stateRoot);
      fs.writeFileSync(path.join(scripts, "native-host-launcher.mjs"), "process.exit(1);\n");
      const configPath = path.join(root, "runtime.json");
      fs.writeFileSync(configPath, JSON.stringify({ version: 1, repoRoot, stateRoot, nodePath: process.execPath }));
      const recoveryFile = path.join(stateRoot, "server-recovery.json");
      if (fixture.prior) fs.writeFileSync(recoveryFile, JSON.stringify(fixture.prior));

      const records = [];
      const statuses = [];
      for (let attempt = 1; attempt <= 5; attempt += 1) {
        const result = spawnSync(process.execPath, [supervisor, "server", configPath], { encoding: "utf8", timeout: 5_000 });
        assert.equal(result.signal, null, result.stderr);
        statuses.push(result.status);
        records.push(JSON.parse(fs.readFileSync(recoveryFile, "utf8")));
      }

      assert.deepEqual(statuses, [1, 1, 1, 1, 0]);
      assert.deepEqual(records.map(({ attempts }) => attempts), [1, 2, 3, 4, 5]);
      assert.equal(records.at(-1).state, "DEGRADED");
      assert.equal(new Set(records.map(({ windowStartedAt }) => windowStartedAt)).size, 1);
      if (fixture.prior) assert.ok(records[0].windowStartedAt > fixture.prior.windowStartedAt + 600_000);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
