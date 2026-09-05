import test from "node:test";
import assert from "node:assert/strict";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { checkResearchReuse, checkLaneArtifactReuse } from "../lib/reuse.mjs";
import { sha256 } from "../../research/lib/canonical.mjs";
import { tempDir, NOW } from "./fixtures.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LIVE_RUN = join(repoRoot, "research/runs/run-wedding-live");
const SAMPLE_PRD = join(repoRoot, "research/samples/approved-prd.wedding-invitation.json");

async function livePrd() {
  return JSON.parse(await readFile(SAMPLE_PRD, "utf8"));
}

// The committed live run predates PR #5, so it is exactly the legacy case.
test("a pre-#5 package is readable but NOT reusable without explicit migration", async () => {
  const result = await checkResearchReuse({ runDir: LIVE_RUN, prd: await livePrd(), nowIso: "2026-09-06T00:00:00.000Z" });
  assert.equal(result.ok, false, "a package with no prd.features must not be silently reused");
  assert.ok(result.failures.includes("legacy_package_requires_migration:prd.features_absent"));
  // Everything else about it still verifies — the block is the contract, not corruption.
  const checks = result.evidence.map((e) => e.check);
  for (const check of ["seal_verified", "provenance", "prd_identity", "freshness"]) {
    assert.ok(checks.includes(check), `missing evidence ${check}`);
  }
});

test("a post-#5 package carrying prd.features + card linkage is reusable with full evidence", async () => {
  // Built from the upstream comparison fixture rather than by back-filling the
  // legacy package: a real migration needs per-card featureId/observationType
  // evidence, which cannot be invented here.
  const { comparisonFixture } = await import("../../research/tests/comparison-fixtures.mjs");
  const { sealResearchPackage } = await import("../../research/lib/evidence.mjs");
  const { prd, input } = comparisonFixture(2);

  const dir = await tempDir();
  const sealed = sealResearchPackage({ ...input, createdAt: NOW, timing: { startedAt: NOW, endedAt: NOW } });
  await writeFile(join(dir, "package.json"), JSON.stringify(sealed, null, 2));
  await writeFile(join(dir, "state.json"), JSON.stringify({
    status: "verified_autonomous", humanGate: "optional", liveVerified: true,
    runId: "run-comparison-fixture", packageHash: sealed.payloadHash,
  }, null, 2));

  const result = await checkResearchReuse({ runDir: dir, prd, nowIso: NOW });
  assert.equal(result.ok, true, JSON.stringify(result.failures));
  const checks = result.evidence.map((e) => e.check);
  for (const check of ["seal_verified", "provenance", "prd_identity", "coverage", "package_generation"]) {
    assert.ok(checks.includes(check), `missing evidence ${check}`);
  }
});

test("tampered research package fails reuse (seal + state hash)", async () => {
  const dir = await tempDir();
  await cp(LIVE_RUN, dir, { recursive: true });
  const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
  pkg.competitorRanking[0].rationale = "tampered";
  await writeFile(join(dir, "package.json"), JSON.stringify(pkg, null, 2));
  const result = await checkResearchReuse({ runDir: dir, prd: await livePrd(), nowIso: NOW });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.startsWith("seal:")), JSON.stringify(result.failures));
});

test("research package for a different PRD is rejected", async () => {
  const prd = await livePrd();
  prd.problem = "a different product entirely";
  const result = await checkResearchReuse({ runDir: LIVE_RUN, prd, nowIso: NOW });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.startsWith("prd_mismatch")));
});

test("stale research package is rejected by freshness policy", async () => {
  const result = await checkResearchReuse({ runDir: LIVE_RUN, prd: await livePrd(), nowIso: "2027-01-01T00:00:00.000Z", maxAgeDays: 30 });
  assert.equal(result.ok, false);
  assert.ok(result.failures.some((f) => f.startsWith("stale:")));
});

test("lane artifact reuse verifies hashes and quality checks", async () => {
  const dir = await tempDir();
  const html = "<!doctype html><html lang='ko'><h1>wf</h1></html>";
  await writeFile(join(dir, "wireframe-hub.html"), html);
  const laneOutput = {
    laneId: "wireframe",
    artifacts: [{ id: "wf-hub", type: "clickable-wireframe", path: "wireframe-hub.html", revisionHash: sha256(Buffer.from(html)) }],
    qualityChecks: [{ criterionId: "hub:mech-1", axis: "mechanical", status: "pass", expected: "x", observed: "x" }],
    timing: { finishedAt: NOW },
    aiRecommendation: { recommendedVariantId: "hub", reason: "clearest" },
  };
  await writeFile(join(dir, "lane-output.json"), JSON.stringify(laneOutput));
  const ok = await checkLaneArtifactReuse({ laneOutputPath: join(dir, "lane-output.json"), expectedLaneId: "wireframe", nowIso: NOW });
  assert.equal(ok.ok, true, JSON.stringify(ok.failures));

  // Tamper with the artifact after packaging.
  await writeFile(join(dir, "wireframe-hub.html"), `${html}<!-- edited -->`);
  const tampered = await checkLaneArtifactReuse({ laneOutputPath: join(dir, "lane-output.json"), expectedLaneId: "wireframe", nowIso: NOW });
  assert.equal(tampered.ok, false);
  assert.ok(tampered.failures.includes("artifact_tampered:wireframe-hub.html"));

  // Failing quality checks block reuse even with intact hashes.
  await writeFile(join(dir, "wireframe-hub.html"), html);
  laneOutput.qualityChecks.push({ criterionId: "hub:ux-1", axis: "ux-task", status: "fail", expected: "flow", observed: "dead end" });
  await writeFile(join(dir, "lane-output.json"), JSON.stringify(laneOutput));
  const failing = await checkLaneArtifactReuse({ laneOutputPath: join(dir, "lane-output.json"), expectedLaneId: "wireframe", nowIso: NOW });
  assert.equal(failing.ok, false);
  assert.ok(failing.failures.some((f) => f.startsWith("failing_quality_checks")));
});
