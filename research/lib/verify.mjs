import { fail } from "./canonical.mjs";

// Independent quote verification: re-fetch each cited HTTPS source and check
// that the exact quote (whitespace/tag-normalized) appears in the fetched
// text. This runs between research and human review so that unverifiable
// quotes are visibly downgraded instead of silently promoted.

const MAX_BYTES = 2 * 1024 * 1024;
const TIMEOUT_MS = 20_000;

export function normalizeText(value) {
  return String(value || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&quot;/gi, '"')
    .replace(/&gt;/gi, ">")
    .replace(/&lt;/gi, "<")
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export function quoteAppearsIn(quote, documentText) {
  const needle = normalizeText(quote);
  if (!needle) return false;
  return normalizeText(documentText).includes(needle);
}

export async function fetchSourceText(url, { fetchFn = globalThis.fetch, timeoutMs = TIMEOUT_MS, maxBytes = MAX_BYTES } = {}) {
  const parsed = new URL(String(url));
  if (parsed.protocol !== "https:") fail("https_required", "Only HTTPS sources can be verified.");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchFn(parsed.toString(), {
      redirect: "follow",
      credentials: "omit",
      signal: controller.signal,
      headers: { Accept: "text/html, text/plain;q=0.9", "User-Agent": "competitor-reference-workflow/1.0 (research verification)" },
    });
    if (!response.ok) return { ok: false, status: response.status, text: null };
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) return { ok: false, status: response.status, text: null, tooLarge: true };
    return { ok: true, status: response.status, text: buffer.toString("utf8") };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Verify every quote-proof card in a research package draft.
 * Returns per-card results and a downgraded copy of the cards: an observed/
 * explicit_absence/contradictory card whose quote cannot be confirmed against
 * the live source is downgraded to "unknown" with a recorded limitation.
 */
export async function verifyQuoteCards(cards, { fetchFn = globalThis.fetch, now = () => new Date().toISOString() } = {}) {
  const results = {};
  const cache = new Map();
  const downgraded = [];
  for (const card of cards) {
    if (card.proof?.type !== "quote" || !card.source?.url) {
      results[card.cardId] = { checked: false, reason: card.proof?.type === "screenshot" ? "screenshot_proof_not_text_checkable" : "no_quote_proof" };
      downgraded.push(card);
      continue;
    }
    let fetched = cache.get(card.source.url);
    if (!fetched) {
      try {
        fetched = await fetchSourceText(card.source.url, { fetchFn });
      } catch (error) {
        fetched = { ok: false, status: null, text: null, error: error?.code || error?.name || "fetch_failed" };
      }
      cache.set(card.source.url, fetched);
    }
    if (!fetched.ok) {
      results[card.cardId] = { checked: true, verified: false, reason: "source_unavailable", status: fetched.status ?? null, checkedAt: now() };
      downgraded.push(downgrade(card, `Verification fetch failed (HTTP ${fetched.status ?? "error"}); quote could not be independently confirmed.`));
      continue;
    }
    const verified = quoteAppearsIn(card.proof.quote, fetched.text);
    results[card.cardId] = { checked: true, verified, reason: verified ? "quote_found" : "quote_not_found", status: fetched.status, checkedAt: now() };
    downgraded.push(verified ? card : downgrade(card, "Quote was not found in the re-fetched source; downgraded pending re-collection."));
  }
  return { results, cards: downgraded };
}

function downgrade(card, limitation) {
  if (card.status === "unknown") return card;
  return {
    ...card,
    status: "unknown",
    proof: { type: "none" },
    limitations: [...(card.limitations || []), limitation, `Original claimed status: ${card.status}; original quote retained in revision history.`],
  };
}
