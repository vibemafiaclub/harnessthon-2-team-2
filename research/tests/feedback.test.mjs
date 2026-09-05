import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { sealResearchPackage } from "../lib/evidence.mjs";
import { buildReviewManifest } from "../lib/review.mjs";
import { createControlState } from "../lib/limits.mjs";
import { ensureRunDir, writeJsonRevision, writeRunState } from "../lib/store.mjs";
import { sha256 } from "../lib/canonical.mjs";
import { draftFor, NOW } from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("free-text feedback is saved as JSON bound to the manifest and readable back", async () => {
  const base = await mkdtemp(join(tmpdir(), "feedback-run-"));
  const pkg = sealResearchPackage({ runId: "run-fb", prd: { prdId: "prd.x", title: "t", domain: "d", payloadHash: sha256("prd") }, ...draftFor("habit") });
  const manifest = buildReviewManifest({ researchPackage: pkg, round: 1, controlState: createControlState(), generatedAt: NOW });
  const runDir = await ensureRunDir(base, "run-fb");
  await writeJsonRevision(runDir, "package", pkg);
  await writeJsonRevision(runDir, "manifest", manifest);
  await writeRunState(runDir, { status: "awaiting_review", control: createControlState(), round: 1 });

  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [join(here, "..", "ui", "review-server.mjs"), runDir, String(port)], { stdio: "pipe" });
  try {
    await waitForServer(port);
    const cardId = pkg.cards[0].cardId;
    const post = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ overall: "전반적으로 좋지만 경쟁사 근거가 더 필요합니다.", perCard: { [cardId]: "출처를 하나 더 붙여주세요.", "card.ghost": "ignored" }, reviewer: "simon" }),
    });
    assert.equal(post.status, 200);
    const saved = (await post.json()).record;
    assert.equal(saved.manifestHash, manifest.manifestHash);
    assert.equal(saved.packageHash, pkg.payloadHash);
    assert.deepEqual(Object.keys(saved.perCard), [cardId]);
    assert.equal(saved.status, "pending");

    const list = await (await fetch(`http://127.0.0.1:${port}/api/feedback`)).json();
    assert.equal(list.feedback.length, 1);
    assert.equal(list.feedback[0].overall, "전반적으로 좋지만 경쟁사 근거가 더 필요합니다.");

    const files = (await readdir(join(runDir, "feedback"))).filter((entry) => entry.endsWith(".json"));
    assert.equal(files.length, 1);
    const onDisk = JSON.parse(await readFile(join(runDir, "feedback", files[0]), "utf8"));
    assert.equal(onDisk.$schema, "research-review-feedback/v1");

    const empty = await fetch(`http://127.0.0.1:${port}/api/feedback`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ overall: "", perCard: {} }),
    });
    assert.equal(empty.status, 400);
  } finally {
    child.kill();
  }
});

async function waitForServer(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await fetch(`http://127.0.0.1:${port}/api/run`); return; } catch (_) { await new Promise((r) => setTimeout(r, 100)); }
  }
  throw new Error("server did not start");
}
