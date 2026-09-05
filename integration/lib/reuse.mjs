import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { sha256, stableStringify } from "../../research/lib/canonical.mjs";
import { verifyResearchPackage } from "../../research/lib/evidence.mjs";

// Evidence-based reuse checks. A stage may be skipped only when the candidate
// artifact passes ALL of: provenance (seal/state), identity (matches the
// current PRD payload), integrity (hashes), freshness policy, and coverage.
// Validation itself is never skipped because a file merely exists.

export const DEFAULT_MAX_AGE_DAYS = 30;

// research/lib/canonical.mjs emits "sha256:<hex>"; the design lanes record bare
// hex in lane-output.json. Compare on the hex payload so either form verifies.
function hexOf(digest) {
  return String(digest ?? "").replace(/^sha256:/, "");
}

function ageDays(fromIso, nowIso) {
  return (Date.parse(nowIso) - Date.parse(fromIso)) / 86_400_000;
}

// Research package reuse: candidate is a research run directory produced by
// research/bin/assemble-run.mjs (package.json + state.json), or a standalone
// sealed package file.
export async function checkResearchReuse({ runDir, packagePath, prd, nowIso, maxAgeDays = DEFAULT_MAX_AGE_DAYS }) {
  const failures = [];
  const evidence = [];
  let pkg = null;
  let state = null;
  const pkgFile = packagePath || (runDir ? join(runDir, "package.json") : null);
  if (!pkgFile || !existsSync(pkgFile)) return { ok: false, failures: ["package_not_found"], evidence };
  try {
    pkg = JSON.parse(await readFile(pkgFile, "utf8"));
  } catch (error) {
    return { ok: false, failures: [`package_unreadable:${error.message}`], evidence };
  }
  const seal = verifyResearchPackage(pkg);
  if (!seal.ok) failures.push(...seal.failures.map((f) => `seal:${f}`));
  else evidence.push({ check: "seal_verified", detail: `payloadHash ${pkg.payloadHash}` });

  if (runDir && existsSync(join(runDir, "state.json"))) {
    state = JSON.parse(await readFile(join(runDir, "state.json"), "utf8"));
    if (state.packageHash !== pkg.payloadHash) failures.push("state_package_hash_mismatch");
  }
  const approvedDecision = runDir ? await latestApprovedDecision(runDir) : null;
  const autonomous = state?.status === "verified_autonomous" && state?.liveVerified === true;
  if (!autonomous && !approvedDecision) {
    failures.push("no_verified_autonomous_state_or_approval");
  } else {
    evidence.push(
      autonomous
        ? { check: "provenance", detail: "run state verified_autonomous (live-verified)" }
        : { check: "provenance", detail: `explicit approval receipt ${approvedDecision.decisionHash}` },
    );
  }

  const prdHash = sha256(stableStringify(prd));
  if (pkg.prd?.payloadHash !== prdHash) {
    failures.push(`prd_mismatch:package=${pkg.prd?.payloadHash?.slice(0, 12) ?? "none"}:current=${prdHash.slice(0, 12)}`);
  } else {
    evidence.push({ check: "prd_identity", detail: `payloadHash ${prdHash}` });
  }

  if (pkg.createdAt && ageDays(pkg.createdAt, nowIso) > maxAgeDays) {
    failures.push(`stale:createdAt=${pkg.createdAt}:maxAgeDays=${maxAgeDays}`);
  } else if (pkg.createdAt) {
    evidence.push({ check: "freshness", detail: `createdAt ${pkg.createdAt} within ${maxAgeDays}d` });
  }

  // Upstream policy (research/schemas/research-package.schema.json, PR #5):
  // a package without prd.features is a historical v1 artifact. It stays
  // readable, but reusing it would silently claim feature coverage it never
  // established, so it must be re-collected or explicitly migrated first.
  if (!Array.isArray(pkg.prd?.features) || !pkg.prd.features.length) {
    failures.push("legacy_package_requires_migration:prd.features_absent");
  } else {
    evidence.push({ check: "package_generation", detail: `package declares ${pkg.prd.features.length} PRD features (post-#5 contract)` });
  }

  const matrixFeatures = new Set((pkg.featureMatrix || []).map((row) => row.featureId));
  const missing = (prd.features || []).map((f) => f.featureId).filter((id) => !matrixFeatures.has(id));
  if (missing.length) failures.push(`coverage_missing_features:${missing.join(",")}`);
  else evidence.push({ check: "coverage", detail: `feature matrix covers all ${prd.features?.length ?? 0} PRD features` });

  return { ok: failures.length === 0, failures, evidence, packageHash: pkg.payloadHash ?? null };
}

async function latestApprovedDecision(runDir) {
  const dir = join(runDir, "decisions");
  if (!existsSync(dir)) return null;
  const { readdir } = await import("node:fs/promises");
  const entries = (await readdir(dir)).filter((e) => e.endsWith(".json")).sort();
  for (const entry of entries.reverse()) {
    const receipt = JSON.parse(await readFile(join(dir, entry), "utf8"));
    if (receipt.decision === "approved" && receipt.decisionHash) return receipt;
  }
  return null;
}

// Lane artifact reuse (wireframe / concept outputs produced by the design
// lanes): requires the lane-output.json manifest, matching artifact hashes on
// disk, and no failing quality checks recorded after repairs.
export async function checkLaneArtifactReuse({ laneOutputPath, expectedLaneId, nowIso, maxAgeDays = DEFAULT_MAX_AGE_DAYS }) {
  const failures = [];
  const evidence = [];
  if (!laneOutputPath || !existsSync(laneOutputPath)) return { ok: false, failures: ["lane_output_not_found"], evidence };
  let output;
  try {
    output = JSON.parse(await readFile(laneOutputPath, "utf8"));
  } catch (error) {
    return { ok: false, failures: [`lane_output_unreadable:${error.message}`], evidence };
  }
  if (expectedLaneId && output.laneId !== expectedLaneId) failures.push(`lane_id_mismatch:${output.laneId}`);
  const dir = join(laneOutputPath, "..");
  for (const artifact of output.artifacts || []) {
    const file = join(dir, artifact.path);
    if (!existsSync(file)) {
      failures.push(`artifact_missing:${artifact.path}`);
      continue;
    }
    const digest = sha256(await readFile(file));
    if (artifact.revisionHash && hexOf(digest) !== hexOf(artifact.revisionHash)) failures.push(`artifact_tampered:${artifact.path}`);
    else evidence.push({ check: "artifact_hash", detail: `${artifact.path} = ${hexOf(digest).slice(0, 12)}…` });
  }
  if (!(output.artifacts || []).length) failures.push("no_artifacts");
  const failing = (output.qualityChecks || []).filter((c) => c.status === "fail");
  if (failing.length) failures.push(`failing_quality_checks:${failing.map((c) => c.criterionId).join(",")}`);
  const finishedAt = output.timing?.finishedAt;
  if (finishedAt && nowIso && ageDays(finishedAt, nowIso) > maxAgeDays) failures.push(`stale:finishedAt=${finishedAt}`);
  return { ok: failures.length === 0, failures, evidence, laneOutput: output };
}
