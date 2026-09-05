import { sealLegacyPackage as sealResearchPackage } from "./fixtures.mjs";
import test from "node:test";
import assert from "node:assert/strict";
import { verifyResearchPackage } from "../lib/evidence.mjs";
import { sha256 } from "../lib/canonical.mjs";
import { draftFor } from "./fixtures.mjs";

function base(domain = "wedding") {
  return { runId: `run-${domain}`, prd: { prdId: `prd.${domain}`, title: "t", domain, payloadHash: sha256("prd") }, ...draftFor(domain) };
}

test("client brand constraints pass through verbatim with precedence markers", () => {
  const sealed = sealResearchPackage({
    ...base(),
    brandConstraints: {
      colors: [{ role: "primary", value: "#2F4A3C", note: "client green" }, "#C9A96A"],
      fonts: [{ role: "heading", family: "Nanum Myeongjo" }],
      notes: "From PRD.md",
    },
  });
  assert.equal(sealed.brandConstraints.source, "approved-prd");
  assert.equal(sealed.brandConstraints.precedence, "client_values_override_design_system_defaults");
  assert.equal(sealed.brandConstraints.unspecifiedProperties, "selected_system_defaults");
  assert.deepEqual(sealed.brandConstraints.colors[1], { role: null, value: "#C9A96A", note: null });
  assert.equal(sealed.brandConstraints.fonts[0].family, "Nanum Myeongjo");
  assert.deepEqual(verifyResearchPackage(sealed), { ok: true, failures: [] });
});

test("absent or empty brand constraints normalize to null", () => {
  assert.equal(sealResearchPackage(base("habit")).brandConstraints, null);
  assert.equal(sealResearchPackage({ ...base("habit"), brandConstraints: { colors: [], fonts: [] } }).brandConstraints, null);
});

test("malformed brand constraint entries are rejected", () => {
  assert.throws(
    () => sealResearchPackage({ ...base(), brandConstraints: { colors: [{ role: "primary" }] } }),
    { code: "string_invalid" },
  );
});
