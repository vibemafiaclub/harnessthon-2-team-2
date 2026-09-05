import { sealResearchPackage } from "../lib/evidence.mjs";

// Historical fixtures intentionally exercise backwards-compatible v1 reads.
export const sealLegacyPackage = input => sealResearchPackage(input, { allowLegacy: true });

// Shared deterministic fixtures for two domains (wedding invitation and
// habit tracking) so tests never overfit to a single example domain.
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

export async function loadPrd(name) {
  return JSON.parse(await readFile(join(here, "..", "samples", `approved-prd.${name}.json`), "utf8"));
}

export const NOW = "2026-09-05T06:00:00Z";

export function draftFor(domain) {
  const isWedding = domain === "wedding";
  const compId = isWedding ? "comp.paperless" : "comp.habitloop";
  const refId = isWedding ? "ref.rsvp-patterns" : "ref.streak-patterns";
  const featureId = isWedding ? "feat.rsvp" : "feat.streaks";
  const featureName = isWedding ? "RSVP collection" : "Streaks and stats";
  return {
    scope: {
      problem: isWedding ? "Couples need polished mobile invitations." : "People abandon complex habit trackers.",
      audience: isWedding ? "Engaged couples on mobile" : "Working adults on mobile",
      jobs: isWedding ? ["share invitation", "collect RSVP"] : ["check off habits", "see streaks"],
      featureScope: [featureName],
    },
    competitors: [
      {
        competitorId: compId,
        name: isWedding ? "Paperless Example" : "HabitLoop Example",
        url: "https://example.com/product",
        rationale: {
          sharedProblem: "same user problem",
          sharedAudience: "same audience",
          sharedJobs: ["same core job"],
          featureOverlap: [featureName],
        },
        accessLimitations: ["App-only flows not observable on the web"],
      },
    ],
    references: [
      {
        referenceId: refId,
        title: "Example UX pattern write-up",
        url: "https://example.com/article",
        kind: "article",
        whyRelevant: "Documents the core task pattern for this domain.",
      },
    ],
    cards: [
      {
        cardId: `card.${compId.slice(5)}.observed`,
        subjectType: "competitor",
        subjectId: compId,
        status: "observed",
        claim: isWedding ? "Competitor collects RSVP inside the invitation page." : "Competitor shows a streak counter on the main screen.",
        source: { url: "https://example.com/product", fetchedAt: NOW, context: "Feature overview section" },
        proof: { type: "quote", quote: "Guests can respond directly on the page." },
        limitations: ["Web marketing copy, not an observed in-app interaction"],
        assessment: { sourceReliability: "medium", claimSupport: "direct", relevance: "high", uxHeuristics: [{ heuristic: "visibility of status", task: "respond to invitation", note: "Response state is shown inline." }], visualPreference: null },
      },
      {
        cardId: `card.${compId.slice(5)}.unknown`,
        subjectType: "competitor",
        subjectId: compId,
        status: "unknown",
        claim: isWedding ? "Whether meal preference is collected is unconfirmed." : "Whether habits can be paused is unconfirmed.",
        source: null,
        proof: { type: "none" },
        limitations: ["Searched product and help pages; no statement either way. Not-found is not absence."],
        assessment: { sourceReliability: "low", claimSupport: "none", relevance: "medium", uxHeuristics: [], visualPreference: null },
      },
      {
        cardId: `card.${refId.slice(4)}.pattern`,
        subjectType: "reference",
        subjectId: refId,
        status: "observed",
        claim: "The reference documents the recommended pattern for the core task.",
        source: { url: "https://example.com/article", fetchedAt: NOW, context: "Pattern section" },
        proof: { type: "quote", quote: "Keep the primary action one tap away." },
        limitations: [],
        assessment: { sourceReliability: "high", claimSupport: "direct", relevance: "high", uxHeuristics: [], visualPreference: "Clean, low-chrome layout preferred" },
      },
    ],
    featureMatrix: [
      {
        featureId,
        prdFeature: featureName,
        perCompetitor: { [compId]: { status: "observed", cardIds: [`card.${compId.slice(5)}.observed`] } },
        ideas: ["Differentiate by making the core action one tap"],
      },
    ],
    accessLimitations: ["Paid screen libraries deliberately not used"],
    decisionRationales: ["Evidence limited to public web sources; app-only flows stay unknown."],
    failures: [{ kind: "app_only_evidence", detail: "In-app flow not observable from the web.", subjectId: compId }],
    timing: { startedAt: "2026-09-05T05:50:00Z", endedAt: NOW },
    createdAt: NOW,
  };
}
