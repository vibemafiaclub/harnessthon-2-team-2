import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { sealResearchPackage } from "../lib/evidence.mjs";
import { buildReviewManifest, REVIEW_QUESTIONS } from "../lib/review.mjs";
import { createControlState } from "../lib/limits.mjs";
import { ensureRunDir, listDecisions, writeJsonRevision, writeRunState, readRunState } from "../lib/store.mjs";
import { sha256 } from "../lib/canonical.mjs";
import { draftFor, NOW } from "./fixtures.mjs";

const here = dirname(fileURLToPath(import.meta.url));

test("review server end-to-end: manifest served, decision persisted with binding, revision history kept", async () => {
  const base = await mkdtemp(join(tmpdir(), "review-run-"));
  const pkg = sealResearchPackage({ runId: "run-server", prd: { prdId: "prd.x", title: "t", domain: "d", payloadHash: sha256("prd") }, ...draftFor("habit") });
  const control = createControlState();
  const manifest = buildReviewManifest({ researchPackage: pkg, round: 1, controlState: control, generatedAt: NOW });
  const runDir = await ensureRunDir(base, "run-server");
  await writeJsonRevision(runDir, "package", pkg);
  await writeJsonRevision(runDir, "package", pkg); // second write → revision history
  await writeJsonRevision(runDir, "manifest", manifest);
  await writeJsonRevision(runDir, "verification", {});
  await writeRunState(runDir, { status: "awaiting_review", control, round: 1 });

  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [join(here, "..", "ui", "review-server.mjs"), runDir, String(port)], { stdio: "pipe" });
  try {
    await waitForServer(port);
    const run = await (await fetch(`http://127.0.0.1:${port}/api/run`)).json();
    assert.equal(run.manifest.manifestHash, manifest.manifestHash);
    assert.equal(run.package.payloadHash, pkg.payloadHash);

    const payload = {
      decision: "approve",
      responses: REVIEW_QUESTIONS.map((question) => ({ questionId: question.id, answer: "yes" })),
      cardActions: pkg.cards.map((card) => ({ cardId: card.cardId, action: "accept" })),
      reviewer: { identity: "simon", role: "evidence-reviewer" },
    };
    const response = await fetch(`http://127.0.0.1:${port}/api/decision`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    const result = await response.json();
    assert.equal(response.status, 200, JSON.stringify(result));
    assert.equal(result.status, "approved");
    assert.equal(result.receipt.packageHash, pkg.payloadHash);

    const decisions = await listDecisions(runDir);
    assert.equal(decisions.length, 1);
    assert.equal(decisions[0].decisionHash, result.receipt.decisionHash);
    const state = await readRunState(runDir);
    assert.equal(state.status, "approved");
    assert.equal(state.control.humanRoundsUsed, 1);

    // Revision history retained
    const v1 = JSON.parse(await readFile(join(runDir, "package.v1.json"), "utf8"));
    assert.equal(v1.payloadHash, pkg.payloadHash);

    // Approved run refuses further decisions
    const again = await fetch(`http://127.0.0.1:${port}/api/decision`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload),
    });
    assert.equal(again.status, 409);
  } finally {
    child.kill();
  }
});

test("server rejects an approval with a negative answer", async () => {
  const base = await mkdtemp(join(tmpdir(), "review-run-"));
  const pkg = sealResearchPackage({ runId: "run-neg", prd: { prdId: "prd.x", title: "t", domain: "d", payloadHash: sha256("prd") }, ...draftFor("wedding") });
  const manifest = buildReviewManifest({ researchPackage: pkg, round: 1, controlState: createControlState(), generatedAt: NOW });
  const runDir = await ensureRunDir(base, "run-neg");
  await writeJsonRevision(runDir, "package", pkg);
  await writeJsonRevision(runDir, "manifest", manifest);
  await writeRunState(runDir, { status: "awaiting_review", control: createControlState(), round: 1 });

  const port = 4300 + Math.floor(Math.random() * 500);
  const child = spawn(process.execPath, [join(here, "..", "ui", "review-server.mjs"), runDir, String(port)], { stdio: "pipe" });
  try {
    await waitForServer(port);
    const responses = REVIEW_QUESTIONS.map((question) => ({ questionId: question.id, answer: "yes" }));
    responses[0].answer = "no";
    const response = await fetch(`http://127.0.0.1:${port}/api/decision`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        decision: "approve",
        responses,
        cardActions: pkg.cards.map((card) => ({ cardId: card.cardId, action: "accept" })),
        reviewer: { identity: "simon", role: "evidence-reviewer" },
      }),
    });
    assert.equal(response.status, 400);
    const result = await response.json();
    assert.equal(result.error, "approve_negative_response");
  } finally {
    child.kill();
  }
});

async function waitForServer(port) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      await fetch(`http://127.0.0.1:${port}/api/run`);
      return;
    } catch (_) {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw new Error("server did not start");
}
