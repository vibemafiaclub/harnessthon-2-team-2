#!/usr/bin/env node
// Local human-review server for one research run.
//   node research/ui/review-server.mjs research/runs/<runId> [port]
// Serves the Korean review UI, exposes the sealed manifest/package, and
// persists sealed decision receipts. Local use only; binds 127.0.0.1.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { createReviewDecision, verifyReviewDecision } from "../lib/review.mjs";
import { recordHumanRound } from "../lib/limits.mjs";
import { appendDecision, listDecisions, readJson, readRunState, writeRunState } from "../lib/store.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const runDir = resolve(process.argv[2] || "");
const port = Number(process.argv[3] || 4173);
if (!process.argv[2]) {
  console.error("Usage: review-server.mjs <runDir> [port]");
  process.exit(2);
}

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://localhost");
    if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
      const html = await readFile(join(here, "review.html"), "utf8");
      return send(response, 200, html, "text/html; charset=utf-8");
    }
    if (request.method === "GET" && url.pathname === "/api/run") {
      const currentState = await readRunState(runDir);
      if (currentState?.status === "incomplete") return sendJson(response, 200, { state: currentState, package: null, manifest: null, verification: {}, decisions: [] });
      const [manifest, pkg, verification, state, decisions] = await Promise.all([
        readJson(runDir, "manifest"),
        readJson(runDir, "package"),
        readJson(runDir, "verification").catch(() => ({})),
        readRunState(runDir),
        listDecisions(runDir),
      ]);
      return sendJson(response, 200, { manifest, package: pkg, verification, state, decisions });
    }
    if (request.method === "POST" && url.pathname === "/api/decision") {
      const body = JSON.parse(await readBody(request));
      const manifest = await readJson(runDir, "manifest");
      const state = (await readRunState(runDir)) || {};
      if (state.status && !["awaiting_review", "revision_requested", "verified_autonomous"].includes(state.status)) {
        return sendJson(response, 409, { error: "run_not_reviewable", detail: `Run status is ${state.status}.` });
      }
      let receipt;
      try {
        receipt = createReviewDecision({
          manifest,
          decision: body.decision,
          responses: body.responses,
          cardActions: body.cardActions,
          reviewer: body.reviewer,
          note: body.note ?? null,
          decidedAt: new Date().toISOString(),
        });
      } catch (error) {
        return sendJson(response, 400, { error: error.code || "decision_invalid", detail: error.message });
      }
      const check = verifyReviewDecision(receipt, { manifest });
      if (!check.ok) return sendJson(response, 400, { error: "decision_unverified", detail: check.failures.join(", ") });
      const control = state.control;
      if (control) {
        try {
          recordHumanRound(control, `round ${manifest.round}: ${receipt.decision}`);
        } catch (error) {
          return sendJson(response, 409, { error: error.code, detail: error.message });
        }
      }
      await appendDecision(runDir, receipt);
      const status = receipt.decision === "approve" ? "approved" : receipt.decision === "reject" ? "rejected" : control?.escalated ? "escalated" : "revision_requested";
      await writeRunState(runDir, { ...state, status, control, lastDecisionHash: receipt.decisionHash, round: manifest.round });
      return sendJson(response, 200, { receipt, status, escalated: Boolean(control?.escalated) });
    }
    if (request.method === "POST" && url.pathname === "/api/feedback") {
      // Free-text feedback channel (per user decision qa4.review-feedback):
      // the reviewer leaves feedback in the page inputs, saves it as JSON,
      // and the agent reads it back to apply a repair round.
      const body = JSON.parse(await readBody(request));
      const manifest = await readJson(runDir, "manifest");
      const overall = String(body.overall || "").trim();
      const perCard = {};
      const validCards = new Set(manifest.cardPins.map((pin) => pin.cardId));
      for (const [cardId, text] of Object.entries(body.perCard || {})) {
        const trimmed = String(text || "").trim();
        if (trimmed && validCards.has(cardId)) perCard[cardId] = trimmed.slice(0, 2000);
      }
      if (!overall && !Object.keys(perCard).length) {
        return sendJson(response, 400, { error: "feedback_empty", detail: "피드백 내용이 비어 있습니다." });
      }
      const record = {
        $schema: "research-review-feedback/v1",
        runId: manifest.runId,
        round: manifest.round,
        manifestHash: manifest.manifestHash,
        packageHash: manifest.packageHash,
        reviewer: String(body.reviewer || "anonymous").slice(0, 160),
        overall: overall.slice(0, 8000) || null,
        perCard,
        status: "pending",
        savedAt: new Date().toISOString(),
      };
      const dir = join(runDir, "feedback");
      await mkdir(dir, { recursive: true });
      const existing = (await readdir(dir).catch(() => [])).filter((entry) => entry.endsWith(".json")).length;
      const file = join(dir, `round-${String(manifest.round).padStart(2, "0")}-feedback-${String(existing + 1).padStart(2, "0")}.json`);
      await writeFile(file, `${JSON.stringify(record, null, 2)}\n`);
      return sendJson(response, 200, { saved: true, file, record });
    }
    if (request.method === "GET" && url.pathname === "/api/feedback") {
      const dir = join(runDir, "feedback");
      const entries = (await readdir(dir).catch(() => [])).filter((entry) => entry.endsWith(".json")).sort();
      const items = [];
      for (const entry of entries) items.push(JSON.parse(await readFile(join(dir, entry), "utf8")));
      return sendJson(response, 200, { feedback: items });
    }
    send(response, 404, "not found", "text/plain");
  } catch (error) {
    sendJson(response, 500, { error: "server_error", detail: String(error?.message || error) });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`[review] run dir: ${runDir}`);
  console.log(`[review] open http://127.0.0.1:${port}/`);
});

function send(response, status, body, type) {
  response.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store" });
  response.end(body);
}
function sendJson(response, status, value) {
  send(response, status, JSON.stringify(value), "application/json; charset=utf-8");
}
function readBody(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let size = 0;
    request.on("data", (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        rejectPromise(new Error("body too large"));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });
    request.on("end", () => resolvePromise(Buffer.concat(chunks).toString("utf8")));
    request.on("error", rejectPromise);
  });
}

export { server };
