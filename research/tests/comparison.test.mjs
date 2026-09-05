import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { sealResearchPackage, verifyResearchPackage } from "../lib/evidence.mjs";
import { assertComparison } from "../lib/comparison.mjs";
import { comparisonFixture } from "./comparison-fixtures.mjs";
import { draftFor, NOW, sealLegacyPackage } from "./fixtures.mjs";

async function workflow(name, args, agent) {
  const source = (await readFile(new URL(`../workflow/${name}.workflow.mjs`, import.meta.url), "utf8")).replace("export const meta", "const meta");
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  return new AsyncFunction("args", "agent", "parallel", "pipeline", "phase", "log", source)(args, agent, lanes => Promise.all(lanes.map(fn => fn())), (items, fn) => Promise.all(items.map(fn)), () => {}, () => {});
}

for (const count of [2, 10]) test(`${count}-feature PRD seals every exact row and three columns`, () => {
  const { input } = comparisonFixture(count);
  const pkg = sealResearchPackage(input);
  assert.deepEqual(verifyResearchPackage(pkg), { ok: true, failures: [] });
  assert.deepEqual(pkg.featureMatrix.map(r => r.featureId), input.prd.features.map(f => f.featureId));
  assert.equal(pkg.prd.features.length, count);
  assert.ok(pkg.featureMatrix.every(r => Object.keys(r.perCompetitor).length === 3));
});

const mutations = {
  "four competitors": p => p.competitors.push({ ...p.competitors[0], competitorId: "comp.four", name: "Four", url: "https://four.example.com" }),
  "two competitors": p => p.competitors.pop(),
  "duplicate IDs": p => p.competitors[1].competitorId = p.competitors[0].competitorId,
  "duplicate names": p => p.competitors[1].name = p.competitors[0].name.toUpperCase(),
  "duplicate URLs": p => p.competitors[1].url = p.competitors[0].url + "/",
  "missing feature row": p => p.featureMatrix.pop(),
  "foreign feature row": p => p.featureMatrix[0].featureId = "feat.foreign",
  "duplicate feature row": p => p.featureMatrix[1] = p.featureMatrix[0],
  "duplicate PRD feature IDs": p => p.prd.features[1].featureId = p.prd.features[0].featureId,
  "missing column": p => delete p.featureMatrix[0].perCompetitor[p.competitors[0].competitorId],
  "extra reference column": p => p.featureMatrix[0].perCompetitor[p.references[0].referenceId] = { status: "unknown", cardIds: [] },
  "wrong competitor proof": p => p.featureMatrix[0].perCompetitor[p.competitors[0].competitorId].cardIds = [p.cards[2].cardId],
  "wrong feature proof": p => p.featureMatrix[0].perCompetitor[p.competitors[0].competitorId].cardIds = [p.cards[1].cardId],
  "missing evidence feature ID": p => delete p.cards[0].featureId,
  "foreign evidence feature ID": p => p.cards[0].featureId = "feat.foreign",
  "missing observation type": p => delete p.cards[0].observationType,
  "duplicate cell evidence": p => p.featureMatrix[0].perCompetitor[p.competitors[0].competitorId].cardIds.push(p.cards[0].cardId),
  "unsupported absence": p => p.featureMatrix[0].perCompetitor[p.competitors[0].competitorId].status = "explicit_absence",
  "partial ranking": p => p.competitorRanking.pop(),
  "duplicate ranks": p => p.competitorRanking[1].rank = 1,
  "no valid evidence for one product": p => { for (const r of p.featureMatrix) r.perCompetitor[p.competitors[0].competitorId] = { status: "unknown", cardIds: [] }; },
};
for (const [name, mutate] of Object.entries(mutations)) test(`rejects ${name}`, () => {
  const { input } = comparisonFixture(); mutate(input);
  assert.throws(() => sealResearchPackage(input));
});

test("missing observation stays unknown, explicit absence requires matched proof", () => {
  const { input } = comparisonFixture();
  input.featureMatrix[1].perCompetitor[input.competitors[0].competitorId] = { status: "unknown", cardIds: [] };
  input.cards[3].status = "explicit_absence";
  input.cards[3].proof.quote = "This feature is not offered.";
  input.featureMatrix[1].perCompetitor[input.competitors[1].competitorId].status = "explicit_absence";
  const pkg = sealResearchPackage(input);
  assert.equal(pkg.featureMatrix[1].perCompetitor[input.competitors[0].competitorId].status, "unknown");
  assert.equal(pkg.featureMatrix[1].perCompetitor[input.competitors[1].competitorId].status, "explicit_absence");
});

test("legacy packages remain readable but new assembly requires PRD features", () => {
  const { input } = comparisonFixture(); delete input.prd.features;
  assert.throws(() => sealResearchPackage(input), { code: "comparison_legacy" });
  assert.equal(verifyResearchPackage(sealLegacyPackage(input)).ok, true);
});

for (const variant of ["four", "two", "duplicate"]) test(`scope ${variant}: no observation lanes dispatched`, async () => {
  const { prd, draft } = comparisonFixture();
  if (variant === "four") draft.competitors.push({ ...draft.competitors[0], competitorId: "comp.four" });
  if (variant === "two") draft.competitors.pop();
  if (variant === "duplicate") draft.competitors[1] = draft.competitors[0];
  let calls = 0;
  await assert.rejects(workflow("competitor-reference", { prd, nowIso: NOW }, async () => { calls++; return draft; }), /incomplete/);
  assert.equal(calls, 1);
});

test("three lanes with a failed result stop before convergence/distillation", async () => {
  const { prd, draft } = comparisonFixture(); let observations = 0;
  await assert.rejects(workflow("competitor-reference", { prd, nowIso: NOW }, async (_, opts) => {
    if (opts.phase === "Scope") return draft;
    assert.equal(opts.phase, "Research"); observations++;
    return observations === 1 ? null : { cards: draft.cards };
  }), /incomplete/);
  assert.equal(observations, 3);
});

test("10-feature workflow observes only three products and preserves every feature", async () => {
  const { prd, draft } = comparisonFixture(10); let observations = 0;
  const result = await workflow("competitor-reference", { prd, nowIso: NOW }, async (prompt, opts) => {
    if (opts.phase === "Scope") return draft;
    if (opts.phase === "Research") {
      observations++; assert.ok(prompt.includes("feat.requirement-10")); assert.ok(!prompt.includes("3-8"));
      return { cards: draft.cards.filter(c => opts.label === `observe:${c.subjectId}`) };
    }
    if (opts.phase === "Converge") return draft;
    return { references: [], cards: [], referenceDistillation: [] };
  });
  assert.equal(observations, 3); assertComparison(result, prd.features);
});

test("replacement returns three-product roster, replaces explicit slot, and assembles", async () => {
  const { prd, draft } = comparisonFixture();
  const removed = draft.competitors[0].competitorId;
  const replacement = { ...draft.competitors[0], competitorId: "comp.replacement", name: "Replacement", url: "https://replacement.example.com" };
  const newCards = draft.cards.filter(c => c.subjectId === removed).map(c => ({ ...c, subjectId: replacement.competitorId, cardId: c.cardId + ".new" }));
  const result = await workflow("competitor-replacement", { prd, nowIso: NOW, count: 1, competitors: draft.competitors, replaceIds: [removed], excludeNames: [draft.competitors[0].name] }, async (_, opts) => opts.phase === "Find" ? { competitors: [replacement] } : { cards: newCards });
  assert.equal(result.competitors.length, 3); assert.ok(!result.competitors.some(c => c.competitorId === removed));
  draft.competitors = result.competitors;
  draft.cards = [...draft.cards.filter(c => c.subjectId !== removed), ...result.cards];
  for (const row of draft.featureMatrix) {
    delete row.perCompetitor[removed]; row.perCompetitor[replacement.competitorId] = { status: "observed", cardIds: newCards.filter(c => c.featureId === row.featureId).map(c => c.cardId) };
  }
  draft.competitorRanking = draft.competitors.map((c, i) => ({ competitorId: c.competitorId, rank: i + 1, rationale: "Evidence-backed replacement." }));
  assertComparison(draft, prd.features);
});

for (const count of [0, 4]) test(`replacement count ${count} dispatches nothing`, async () => {
  const { prd, draft } = comparisonFixture(); let calls = 0;
  await assert.rejects(workflow("competitor-replacement", { prd, nowIso: NOW, count, competitors: draft.competitors, replaceIds: [] }, async () => { calls++; }), /incomplete/);
  assert.equal(calls, 0);
});

test("replacement over-output does not dispatch observations", async () => {
  const { prd, draft } = comparisonFixture(); let calls = 0;
  await assert.rejects(workflow("competitor-replacement", { prd, nowIso: NOW, count: 1, competitors: draft.competitors, replaceIds: [draft.competitors[0].competitorId] }, async () => { calls++; return { competitors: draft.competitors }; }), /incomplete/);
  assert.equal(calls, 1);
});

test("rank-distill rejects file-only legacy reuse before agent calls", async () => {
  let calls = 0;
  await assert.rejects(workflow("rank-distill", { nowIso: NOW, inputFile: "legacy.json" }, async () => { calls++; }), /incomplete/);
  assert.equal(calls, 0);
});

test("assembly writes incomplete state for insufficient sources instead of success", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comparison-assembly-"));
  try {
    const { prd, draft } = comparisonFixture();
    for (const row of draft.featureMatrix) row.perCompetitor[draft.competitors[0].competitorId] = { status: "unknown", cardIds: [] };
    await writeFile(join(dir, "prd.json"), JSON.stringify(prd));
    await writeFile(join(dir, "draft.json"), JSON.stringify(draft));
    assert.throws(() => execFileSync(process.execPath, ["research/bin/assemble-run.mjs", "--prd", join(dir, "prd.json"), "--draft", join(dir, "draft.json"), "--runs-dir", dir, "--run-id", "run-incomplete", "--skip-live-verify"], { stdio: "pipe" }));
    const state = JSON.parse(await readFile(join(dir, "run-incomplete", "state.json"), "utf8"));
    assert.equal(state.status, "incomplete"); assert.equal(state.liveVerified, false);
    assert.equal(state.reason, "comparison_incomplete"); assert.equal(state.packageHash, undefined);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// Execute the actual UI render function with a small DOM double; no browser or
// live research is needed to verify row/column/text/link rendering.
for (const count of [2, 10]) test(`UI leads with all ${count} requirements and exactly three products`, async () => {
  class Node {
    constructor(tag, text = "") { this.tag = tag; this.text = text; this.children = []; this.attrs = {}; this.nodeType = 1; }
    append(...children) { this.children.push(...children); }
    replaceChildren() { this.children = []; }
    setAttribute(key, value) { this.attrs[key] = value; }
    get textContent() { return this.text + this.children.map(c => c.textContent).join(""); }
  }
  const roots = [new Node("main"), ...["decide", "decideHint"].map(id => { const n = new Node("div"); n.attrs.id = id; return n; })]; roots[0].attrs.id = "app";
  const walk = n => [n, ...n.children.flatMap(walk)];
  const document = { createElement: tag => new Node(tag), createTextNode: text => new Node("text", text), getElementById: id => roots.flatMap(walk).find(n => n.attrs.id === id) };
  const { input } = comparisonFixture(count); const pkg = sealResearchPackage(input);
  const html = await readFile(new URL("../ui/review.html", import.meta.url), "utf8");
  const script = html.split("<script>")[1].split("</script>")[0].split('document.getElementById("btnApprove").onclick')[0];
  runInNewContext(script + '\ndata = fixture; render();', { document, fixture: { package: pkg, manifest: { round: 1, manifestHash: "sha256:test", questions: [] }, verification: {}, state: { status: "verified_autonomous" }, decisions: [] } });
  const nodes = walk(roots[0]); const table = nodes.find(n => n.tag === "table");
  assert.equal(nodes.find(n => n.tag === "h2").textContent, "기능 비교 매트릭스");
  assert.equal(table.children.length, count + 1);
  assert.deepEqual(table.children[0].children.slice(1, 4).map(n => n.textContent), pkg.competitors.map(c => c.name));
  for (const f of pkg.prd.features) { assert.ok(table.textContent.includes(f.featureId)); assert.ok(table.textContent.includes(f.description)); }
  assert.equal(walk(table).filter(n => n.tag === "details").length, count * 3);
  assert.ok(walk(table).some(n => n.tag === "a" && n.attrs.href.startsWith("#card-")));
});

for (const invalid of [false, true]) test(`rank-distill ${invalid ? "rejects oversized ranking" : "uses the selected three"}`, async () => {
  const { prd, draft } = comparisonFixture(); let distills = 0;
  const run = workflow("rank-distill", { ...draft, prd, nowIso: NOW }, async (_, opts) => {
    if (opts.phase === "Rank") return { competitorRanking: invalid ? [...draft.competitorRanking, { competitorId: "comp.extra", rank: 4 }] : draft.competitorRanking };
    distills++; return { references: [], cards: [], referenceDistillation: [] };
  });
  if (invalid) { await assert.rejects(run, /incomplete/); assert.equal(distills, 0); }
  else { const result = await run; assert.equal(result.competitorRanking.length, 3); assert.equal(distills, 1); }
});

test("live verification keeps auto-confirm and revisions; failed quote becomes unknown", async () => {
  const dir = await mkdtemp(join(tmpdir(), "comparison-repair-"));
  try {
    const { prd, draft } = comparisonFixture();
    await writeFile(join(dir, "prd.json"), JSON.stringify(prd));
    await writeFile(join(dir, "draft.json"), JSON.stringify(draft));
    const run = (quotes) => {
      const script = `globalThis.fetch = async () => ({ ok: true, status: 200, arrayBuffer: async () => new TextEncoder().encode(${JSON.stringify(quotes)}).buffer }); process.argv = ${JSON.stringify([process.execPath, "research/bin/assemble-run.mjs", "--prd", join(dir, "prd.json"), "--draft", join(dir, "draft.json"), "--runs-dir", dir, "--run-id", "run-repair"])}; await import('./research/bin/assemble-run.mjs');`;
      execFileSync(process.execPath, ["--input-type=module", "-e", script], { stdio: "pipe" });
    };
    run(draft.cards.map(c => c.proof.quote).join(" "));
    const first = JSON.parse(await readFile(join(dir, "run-repair", "state.json"), "utf8"));
    assert.equal(first.status, "verified_autonomous"); assert.equal(first.humanGate, "optional");
    run(draft.cards.filter((_, i) => i !== 1).map(c => c.proof.quote).join(" "));
    const pkg = JSON.parse(await readFile(join(dir, "run-repair", "package.json"), "utf8"));
    assert.equal(pkg.featureMatrix[1].perCompetitor[draft.competitors[0].competitorId].status, "unknown");
    assert.equal(pkg.cards[1].status, "unknown");
    const second = JSON.parse(await readFile(join(dir, "run-repair", "state.json"), "utf8"));
    assert.equal(second.status, "verified_autonomous"); assert.notEqual(first.packageHash, second.packageHash);
    assert.ok(await readFile(join(dir, "run-repair", "package.v1.json")));
    assert.ok(await readFile(join(dir, "run-repair", "package.v2.json")));
    assert.deepEqual(verifyResearchPackage(pkg), { ok: true, failures: [] });
  } finally { await rm(dir, { recursive: true, force: true }); }
});
