import test from "node:test";
import assert from "node:assert/strict";
import { sealResearchPackage, verifyResearchPackage } from "../lib/evidence.mjs";
import { sha256 } from "../lib/canonical.mjs";
import { draftFor } from "./fixtures.mjs";

function base(domain = "wedding") {
  return { runId: `run-${domain}`, prd: { prdId: `prd.${domain}`, title: "t", domain, payloadHash: sha256("prd") }, ...draftFor(domain) };
}

test("ranking entries need known competitors, unique ids, and a rationale", () => {
  const compId = draftFor("wedding").competitors[0].competitorId;
  const sealed = sealResearchPackage({ ...base(), competitorRanking: [{ competitorId: compId, rank: 1, rationale: "Best evidence coverage across PRD features." }] });
  assert.equal(sealed.competitorRanking.length, 1);
  assert.deepEqual(verifyResearchPackage(sealed), { ok: true, failures: [] });

  assert.throws(() => sealResearchPackage({ ...base(), competitorRanking: [{ competitorId: "comp.ghost", rank: 1, rationale: "x" }] }), { code: "ranking_competitor_unknown" });
  assert.throws(() => sealResearchPackage({ ...base(), competitorRanking: [{ competitorId: compId, rank: 1, rationale: "" }] }), { code: "string_invalid" });
  assert.throws(
    () => sealResearchPackage({ ...base(), competitorRanking: [{ competitorId: compId, rank: 1, rationale: "a" }, { competitorId: compId, rank: 2, rationale: "b" }] }),
    { code: "duplicate_id" },
  );
});

test("distillation requires exactly the three categories with cited evidence", () => {
  const draft = draftFor("wedding");
  const refId = draft.references[0].referenceId;
  const cardId = draft.cards[0].cardId;
  const category = (name) => ({ category: name, direction: "Direction synthesis.", referenceIds: [refId], cardIds: [cardId], rationale: "Grounded in top-3 evidence." });

  const sealed = sealResearchPackage({ ...base(), referenceDistillation: [category("style"), category("layout"), category("interaction")] });
  assert.equal(sealed.referenceDistillation.length, 3);
  assert.deepEqual(sealed.referenceDistillation.map((item) => item.category), ["interaction", "layout", "style"]);
  assert.deepEqual(verifyResearchPackage(sealed), { ok: true, failures: [] });

  assert.throws(() => sealResearchPackage({ ...base(), referenceDistillation: [category("style"), category("layout")] }), { code: "distillation_category_count" });
  assert.throws(
    () => sealResearchPackage({ ...base(), referenceDistillation: [category("style"), category("style"), category("layout")] }),
    { code: "duplicate_id" },
  );
  assert.throws(
    () => sealResearchPackage({ ...base(), referenceDistillation: [category("style"), category("layout"), { ...category("interaction"), cardIds: ["card.ghost"], referenceIds: [] }] }),
    { code: "distillation_card_unknown" },
  );
  assert.throws(
    () => sealResearchPackage({ ...base(), referenceDistillation: [category("style"), category("layout"), { ...category("interaction"), cardIds: [], referenceIds: [] }] }),
    { code: "distillation_evidence_required" },
  );
});

test("packages without ranking/distillation still seal (backward-compatible optional sections)", () => {
  const sealed = sealResearchPackage(base("habit"));
  assert.deepEqual(sealed.competitorRanking, []);
  assert.equal(sealed.referenceDistillation, null);
  assert.deepEqual(verifyResearchPackage(sealed), { ok: true, failures: [] });
});
