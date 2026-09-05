import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureRunDir, writeJsonRevision, readJson, appendDecision, listDecisions } from "../lib/store.mjs";

test("revisioned writes keep every prior version and update the latest pointer", async () => {
  const base = await mkdtemp(join(tmpdir(), "store-"));
  const runDir = await ensureRunDir(base, "run-a");
  const first = await writeJsonRevision(runDir, "package", { version: 1 });
  const second = await writeJsonRevision(runDir, "package", { version: 2 });
  assert.equal(first.revision, 1);
  assert.equal(second.revision, 2);
  assert.deepEqual(await readJson(runDir, "package"), { version: 2 });
  assert.deepEqual(JSON.parse(await (await import("node:fs/promises")).readFile(join(runDir, "package.v1.json"), "utf8")), { version: 1 });
});

test("decision log accumulates in round order", async () => {
  const base = await mkdtemp(join(tmpdir(), "store-"));
  const runDir = await ensureRunDir(base, "run-b");
  await appendDecision(runDir, { decisionHash: "sha256:" + "a".repeat(64), round: 2, decision: "revision" });
  await appendDecision(runDir, { decisionHash: "sha256:" + "b".repeat(64), round: 1, decision: "revision" });
  const decisions = await listDecisions(runDir);
  assert.equal(decisions.length, 2);
  assert.equal(decisions[0].round, 1);
  assert.equal(decisions[1].round, 2);
});

test("invalid run ids are refused", async () => {
  const base = await mkdtemp(join(tmpdir(), "store-"));
  await assert.rejects(ensureRunDir(base, "../escape"), { code: "run_id_invalid" });
});
