import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fail, sha256, stableStringify } from "./canonical.mjs";

// Simple revisioned JSON persistence for a run directory. Every write keeps
// the prior revision (`<name>.v<N>.json`) and updates `<name>.json` to the
// latest, so review history and repair rounds stay auditable.

export async function ensureRunDir(baseDir, runId) {
  if (!/^[A-Za-z][A-Za-z0-9_.-]{1,120}$/.test(String(runId || ""))) fail("run_id_invalid", "runId has an invalid format.");
  const runDir = resolve(baseDir, runId);
  await mkdir(runDir, { recursive: true });
  await mkdir(join(runDir, "decisions"), { recursive: true });
  return runDir;
}

export async function writeJsonRevision(runDir, name, value) {
  if (!/^[a-z][a-z0-9-]{1,60}$/.test(String(name || ""))) fail("artifact_name_invalid", "Artifact name has an invalid format.");
  const entries = await readdir(runDir).catch(() => []);
  const pattern = new RegExp(`^${name}\\.v(\\d+)\\.json$`);
  const revision = entries.reduce((max, entry) => {
    const match = entry.match(pattern);
    return match ? Math.max(max, Number(match[1])) : max;
  }, 0) + 1;
  const text = `${JSON.stringify(value, null, 2)}\n`;
  await writeFile(join(runDir, `${name}.v${revision}.json`), text);
  await writeFile(join(runDir, `${name}.json`), text);
  return { revision, path: join(runDir, `${name}.json`), hash: sha256(stableStringify(value)) };
}

export async function readJson(runDir, name) {
  const text = await readFile(join(runDir, `${name}.json`), "utf8");
  return JSON.parse(text);
}

export async function appendDecision(runDir, receipt) {
  if (!receipt?.decisionHash) fail("decision_required", "A sealed decision receipt is required.");
  const file = join(runDir, "decisions", `round-${String(receipt.round).padStart(2, "0")}-${receipt.decision}-${receipt.decisionHash.slice(7, 19)}.json`);
  await writeFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
  return file;
}

export async function listDecisions(runDir) {
  const dir = join(runDir, "decisions");
  const entries = (await readdir(dir).catch(() => [])).filter((entry) => entry.endsWith(".json")).sort();
  const decisions = [];
  for (const entry of entries) {
    decisions.push(JSON.parse(await readFile(join(dir, entry), "utf8")));
  }
  return decisions;
}

export async function writeRunState(runDir, state) {
  const body = { ...state, updatedAt: new Date().toISOString() };
  await writeFile(join(runDir, "state.json"), `${JSON.stringify(body, null, 2)}\n`);
  return body;
}

export async function readRunState(runDir) {
  try {
    return JSON.parse(await readFile(join(runDir, "state.json"), "utf8"));
  } catch (_) {
    return null;
  }
}
