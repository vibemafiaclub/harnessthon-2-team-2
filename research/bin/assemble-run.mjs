#!/usr/bin/env node
// Assemble a research run: take the raw draft produced by the dynamic
// workflow (or a fixture), verify quote evidence against live sources,
// seal the research package, and build the human-review manifest.
//
// Usage:
//   node research/bin/assemble-run.mjs --prd <approved-prd.json> --draft <draft.json> \
//     --run-id <id> [--runs-dir research/runs] [--skip-live-verify]

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { sha256, stableStringify } from "../lib/canonical.mjs";
import { sealResearchPackage, verifyResearchPackage } from "../lib/evidence.mjs";
import { verifyQuoteCards } from "../lib/verify.mjs";
import { buildReviewManifest } from "../lib/review.mjs";
import { createControlState } from "../lib/limits.mjs";
import { ensureRunDir, listDecisions, readRunState, writeJsonRevision, writeRunState } from "../lib/store.mjs";

const args = parseArgs(process.argv.slice(2));
const startedAt = Date.now();

const prd = JSON.parse(await readFile(resolve(args.prd), "utf8"));
if (prd.$schema !== "approved-prd/v1") throw new Error("PRD input must declare $schema approved-prd/v1.");
const draft = JSON.parse(await readFile(resolve(args.draft), "utf8"));
const runId = args["run-id"] || `run-${prd.prdId.replace(/[^A-Za-z0-9_.-]/g, "-")}`;
const runsDir = resolve(args["runs-dir"] || "research/runs");
const runDir = await ensureRunDir(runsDir, runId);

const priorState = await readRunState(runDir);
const control = priorState?.control || createControlState(draft.limits);

log(`run ${runId}: verifying ${draft.cards?.length ?? 0} evidence cards${args["skip-live-verify"] ? " (live verification SKIPPED)" : " against live sources"}`);
let verification = { results: {}, cards: draft.cards || [] };
if (!args["skip-live-verify"]) {
  verification = await verifyQuoteCards(draft.cards || []);
  const flat = Object.entries(verification.results);
  const failedIds = new Set(flat.filter(([, r]) => r.checked && r.verified === false).map(([id]) => id));
  log(`verification: ${flat.filter(([, r]) => r.verified).length} verified, ${failedIds.size} downgraded, ${flat.filter(([, r]) => !r.checked).length} not text-checkable`);
  if (failedIds.size && draft.featureMatrix) {
    // A downgraded card can no longer support observed/absence/contradictory
    // matrix cells; drop the stale card reference and mark the cell unknown.
    for (const row of draft.featureMatrix) {
      for (const cell of Object.values(row.perCompetitor || {})) {
        cell.cardIds = (cell.cardIds || []).filter((id) => !failedIds.has(id));
        if (!cell.cardIds.length && cell.status !== "unknown") cell.status = "unknown";
      }
    }
  }
}

const now = new Date().toISOString();
const sealed = sealResearchPackage({
  runId,
  prd: { prdId: prd.prdId, title: prd.title, domain: prd.domain, payloadHash: sha256(stableStringify(prd)) },
  // Client-specified colors/fonts pass through verbatim from the approved PRD
  // and take precedence downstream over design-system defaults (team rule).
  brandConstraints: prd.brandConstraints ?? null,
  competitorRanking: draft.competitorRanking,
  referenceDistillation: draft.referenceDistillation,
  scope: draft.scope,
  competitors: draft.competitors,
  references: draft.references,
  featureMatrix: draft.featureMatrix,
  cards: verification.cards,
  accessLimitations: draft.accessLimitations,
  decisionRationales: draft.decisionRationales,
  timing: draft.timing || { startedAt: now, endedAt: now },
  failures: draft.failures,
  createdAt: now,
});
const check = verifyResearchPackage(sealed);
if (!check.ok) throw new Error(`Sealed package failed self-verification: ${check.failures.join(", ")}`);

const decisions = await listDecisions(runDir);
const round = decisions.length + 1;
const manifest = buildReviewManifest({ researchPackage: sealed, round, controlState: control, generatedAt: now });

await writeJsonRevision(runDir, "package", sealed);
await writeJsonRevision(runDir, "verification", verification.results);
await writeJsonRevision(runDir, "manifest", manifest);
// qa-round-2/qa6: stages 2-3 are fully autonomous. When live verification ran
// and the package sealed, the run is downstream-consumable without a human
// decision receipt; the review UI stays available as optional inspection
// (pass --require-review to restore the blocking gate).
const autonomous = !args["require-review"] && !args["skip-live-verify"];
await writeRunState(runDir, {
  status: autonomous ? "verified_autonomous" : "awaiting_review",
  humanGate: autonomous ? "optional" : "required",
  runId,
  round,
  control,
  packageHash: sealed.payloadHash,
  manifestHash: manifest.manifestHash,
  startedAt: priorState?.startedAt || now,
  liveVerified: !args["skip-live-verify"],
});

log(`sealed package ${sealed.payloadHash}`);
log(`manifest ${manifest.manifestHash} (round ${round})`);
log(`run dir: ${runDir}`);
log(`elapsed ${(Date.now() - startedAt) / 1000}s — next: node research/ui/review-server.mjs ${runDir}`);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const key = argv[i];
    if (!key.startsWith("--")) continue;
    const name = key.slice(2);
    if (name === "skip-live-verify" || name === "require-review") out[name] = true;
    else out[name] = argv[++i];
  }
  if (!out.prd || !out.draft) {
    console.error("Usage: assemble-run.mjs --prd <approved-prd.json> --draft <draft.json> [--run-id <id>] [--runs-dir <dir>] [--skip-live-verify]");
    process.exit(2);
  }
  return out;
}

function log(message) {
  console.log(`[assemble] ${message}`);
}
