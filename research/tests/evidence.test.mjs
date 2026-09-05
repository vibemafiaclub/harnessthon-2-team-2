import { sealLegacyPackage as sealResearchPackage } from "./fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { normalizeEvidenceCard, verifyResearchPackage } from "../lib/evidence.mjs";
import { sha256 } from "../lib/canonical.mjs";
import { draftFor, NOW } from "./fixtures.mjs";

// Both fixture domains exercise the same contract; the habit-tracker domain
// exists specifically to prevent wedding-invitation overfitting.
for (const domain of ["wedding", "habit"]) {
  test(`[${domain}] seals a valid research package and verifies it`, () => {
    const draft = draftFor(domain);
    const pkg = sealResearchPackage({
      runId: `run-${domain}`,
      prd: { prdId: `prd.${domain}`, title: "t", domain, payloadHash: sha256("prd") },
      ...draft,
    });
    assert.equal(pkg.$schema, "competitor-research-package/v1");
    assert.match(pkg.payloadHash, /^sha256:/);
    const check = verifyResearchPackage(pkg);
    assert.deepEqual(check, { ok: true, failures: [] });
  });

  test(`[${domain}] tampering with a claim is detected`, () => {
    const draft = draftFor(domain);
    const pkg = sealResearchPackage({
      runId: `run-${domain}`,
      prd: { prdId: `prd.${domain}`, title: "t", domain, payloadHash: sha256("prd") },
      ...draft,
    });
    const tampered = JSON.parse(JSON.stringify(pkg));
    tampered.cards[0].claim = "Silently promoted claim";
    const check = verifyResearchPackage(tampered);
    assert.equal(check.ok, false);
    assert.ok(check.failures.includes("payload_hash_mismatch"));
    assert.ok(check.failures.some((failure) => failure.startsWith("card_hash_mismatch:")));
  });
}

test("observed status without proof is rejected (not-found is not absence)", () => {
  assert.throws(
    () => normalizeEvidenceCard({
      cardId: "card.x.1", subjectType: "competitor", subjectId: "comp.x", status: "observed",
      claim: "c", source: { url: "https://example.com", fetchedAt: NOW, context: "ctx" },
      proof: { type: "none" }, limitations: [],
      assessment: { sourceReliability: "low", claimSupport: "none", relevance: "low" },
    }),
    { code: "proof_required" },
  );
});

test("explicit_absence requires proof too", () => {
  assert.throws(
    () => normalizeEvidenceCard({
      cardId: "card.x.2", subjectType: "competitor", subjectId: "comp.x", status: "explicit_absence",
      claim: "c", source: { url: "https://example.com", fetchedAt: NOW, context: "ctx" },
      proof: { type: "none" }, limitations: [],
      assessment: { sourceReliability: "low", claimSupport: "none", relevance: "low" },
    }),
    { code: "proof_required" },
  );
});

test("unknown card is valid without source or proof", () => {
  const card = normalizeEvidenceCard({
    cardId: "card.x.3", subjectType: "competitor", subjectId: "comp.x", status: "unknown",
    claim: "c", proof: { type: "none" }, limitations: ["searched, nothing found"],
    assessment: { sourceReliability: "low", claimSupport: "none", relevance: "low" },
  });
  assert.equal(card.status, "unknown");
  assert.equal(card.source, null);
});

test("screenshot proof requires a real capture record; generated methods are rejected", () => {
  const base = {
    cardId: "card.x.4", subjectType: "competitor", subjectId: "comp.x", status: "observed",
    claim: "c", source: { url: "https://example.com", fetchedAt: NOW, context: "ctx" },
    limitations: [], assessment: { sourceReliability: "high", claimSupport: "direct", relevance: "high" },
  };
  assert.throws(
    () => normalizeEvidenceCard({ ...base, proof: { type: "screenshot", screenshot: { file: "a.png", captureMethod: "generated", capturedAt: NOW, sha256: sha256("x") } } }),
    { code: "enum_invalid" },
  );
  const ok = normalizeEvidenceCard({ ...base, proof: { type: "screenshot", screenshot: { file: "a.png", captureMethod: "browser_capture", capturedAt: NOW, sha256: sha256("x") } } });
  assert.equal(ok.proof.screenshot.captureMethod, "browser_capture");
});

test("aggregate UX scores are forbidden by contract", () => {
  assert.throws(
    () => normalizeEvidenceCard({
      cardId: "card.x.5", subjectType: "competitor", subjectId: "comp.x", status: "unknown",
      claim: "c", proof: { type: "none" }, limitations: [],
      assessment: { sourceReliability: "low", claimSupport: "none", relevance: "low", uxScore: 87 },
    }),
    { code: "universal_score_forbidden" },
  );
});

test("matrix cell claiming observed must cite an evidence card", () => {
  const draft = draftFor("wedding");
  draft.featureMatrix[0].perCompetitor["comp.paperless"] = { status: "observed", cardIds: [] };
  assert.throws(
    () => sealResearchPackage({ runId: "run-x", prd: { prdId: "prd.x", title: "t", domain: "d", payloadHash: sha256("prd") }, ...draft }),
    { code: "matrix_cards_required" },
  );
});

test("card referencing an unknown subject is rejected", () => {
  const draft = draftFor("wedding");
  draft.cards[0].subjectId = "comp.ghost";
  assert.throws(
    () => sealResearchPackage({ runId: "run-x", prd: { prdId: "prd.x", title: "t", domain: "d", payloadHash: sha256("prd") }, ...draft }),
    { code: "card_subject_unknown" },
  );
});
