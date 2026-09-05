import test from "node:test";
import assert from "node:assert/strict";
import { normalizeText, quoteAppearsIn, verifyQuoteCards } from "../lib/verify.mjs";
import { draftFor } from "./fixtures.mjs";

const PAGE = `<html><head><title>Product</title><style>.x{}</style></head>
<body><h1>Features</h1>
<p>Guests can respond <b>directly</b> on&nbsp;the page.</p>
<p>Keep the primary action one tap away.</p>
<script>track()</script></body></html>`;

function fetchStub(status = 200, body = PAGE) {
  return async () => ({ ok: status >= 200 && status < 300, status, arrayBuffer: async () => Buffer.from(body) });
}

test("normalizeText strips tags/entities and quote matching survives markup", () => {
  assert.ok(quoteAppearsIn("Guests can respond directly on the page.", PAGE));
  assert.ok(!quoteAppearsIn("Guests can instantly respond on the page.", PAGE));
  assert.equal(normalizeText("<p>A&nbsp;B</p>"), "a b");
});

for (const domain of ["wedding", "habit"]) {
  test(`[${domain}] verified quotes pass; missing quotes are downgraded to unknown`, async () => {
    const draft = draftFor(domain);
    const { results, cards } = await verifyQuoteCards(draft.cards, { fetchFn: fetchStub(), now: () => "2026-09-05T06:01:00Z" });
    const observedId = draft.cards[0].cardId;
    assert.equal(results[observedId].verified, true);

    // Now poison the quote: verification must downgrade, never silently pass.
    const poisoned = JSON.parse(JSON.stringify(draft.cards));
    poisoned[0].proof.quote = "A quote that is not on the page.";
    const second = await verifyQuoteCards(poisoned, { fetchFn: fetchStub(), now: () => "2026-09-05T06:01:00Z" });
    assert.equal(second.results[observedId].verified, false);
    const downgraded = second.cards.find((card) => card.cardId === observedId);
    assert.equal(downgraded.status, "unknown");
    assert.equal(downgraded.proof.type, "none");
    assert.ok(downgraded.limitations.some((limitation) => /not found/i.test(limitation)));
  });
}

test("unavailable source marks the card unverifiable and downgrades it", async () => {
  const draft = draftFor("wedding");
  const { results, cards } = await verifyQuoteCards(draft.cards, { fetchFn: fetchStub(404), now: () => "2026-09-05T06:01:00Z" });
  const observedId = draft.cards[0].cardId;
  assert.equal(results[observedId].reason, "source_unavailable");
  assert.equal(cards.find((card) => card.cardId === observedId).status, "unknown");
});

test("unknown cards without quotes are left untouched", async () => {
  const draft = draftFor("wedding");
  const unknownId = draft.cards[1].cardId;
  const { results, cards } = await verifyQuoteCards(draft.cards, { fetchFn: fetchStub(), now: () => "2026-09-05T06:01:00Z" });
  assert.equal(results[unknownId].checked, false);
  assert.equal(cards.find((card) => card.cardId === unknownId).status, "unknown");
});
