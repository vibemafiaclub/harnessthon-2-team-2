import { readFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { sha256 } from "../../research/lib/canonical.mjs";

// Workflow registry: which real Claude Dynamic Workflow scripts each stage
// invokes, with argument contracts validated against the actual source.
// Every arg list here is checked against the real workflow file by
// validateArgsAgainstSource (see integration/tests/registry.test.mjs), so a
// contract drift in a lane script fails the tests instead of failing at runtime.
// Workflows that are not in this repo must be explicitly registered (path +
// content hash) via integration/registry.local.json; an unregistered or
// drifted adapter is reported unavailable, never silently substituted.

export const BUILTIN_WORKFLOWS = {
  "intake-assess": {
    scriptPath: "integration/workflow/intake-assess.workflow.mjs",
    requiredArgs: ["request", "materials", "nowIso"],
  },
  "prd-interview": {
    scriptPath: ".claude/workflows/prd-interview/workflow.js",
    requiredArgs: ["prdPath", "outDir", "promptsDir"],
  },
  "prd-interview-revise": {
    scriptPath: ".claude/workflows/prd-interview/workflow.js",
    requiredArgs: ["stage", "prdPath", "outDir", "promptsDir", "answers"],
  },
  "competitor-reference": {
    scriptPath: "research/workflow/competitor-reference.workflow.mjs",
    requiredArgs: ["prd", "nowIso"],
  },
  "wireframe-lane": {
    scriptPath: "workflows/wireframe-lane.mjs",
    requiredArgs: ["prdPath", "runDir", "runId", "round", "startedAt"],
  },
  // Pass 1 of the visual-concept lane: without clientPreferences the lane
  // returns only the aesthetic questionnaire and stops before generation.
  "visual-concept-elicit": {
    scriptPath: "workflows/visual-concept-lane.mjs",
    requiredArgs: ["prdPath", "runDir", "runId", "round", "startedAt"],
  },
  // Pass 2: generation, which the lane refuses without both the client's
  // answers and the representative wireframe.
  "visual-concept-lane": {
    scriptPath: "workflows/visual-concept-lane.mjs",
    requiredArgs: ["prdPath", "runDir", "runId", "round", "startedAt", "representativeWireframePath", "clientPreferences"],
  },
  "post-approval-prototype": {
    scriptPath: "workflows/post-approval-product.mjs",
    requiredArgs: ["inputPath", "outDir"],
  },
};

// Stages whose workflow does not exist in this repo yet. They stay
// "unregistered" (a blocked route stage) until someone registers a real
// script for them, so the plan never claims work that cannot execute.
export const EXTERNAL_WORKFLOWS = {
  // Preserve legacy explicit registrations; the built-in prototype is now the default.
  "production-outputs": { requiredArgs: ["prdPath", "runDir", "conceptId"] },
};

export const LOCAL_REGISTRY_FILE = "integration/registry.local.json";

function resolvePath(repoRoot, path) {
  return isAbsolute(path) ? path : resolve(repoRoot, path);
}

function fileSha(path) {
  try {
    return sha256(readFileSync(path));
  } catch {
    return null;
  }
}

export function loadRegistry(repoRoot, localRegistryPath = LOCAL_REGISTRY_FILE) {
  const entries = {};
  for (const [name, spec] of Object.entries(BUILTIN_WORKFLOWS)) {
    const abs = resolvePath(repoRoot, spec.scriptPath);
    entries[name] = {
      name,
      kind: "builtin",
      scriptPath: abs,
      requiredArgs: spec.requiredArgs,
      status: existsSync(abs) ? "available" : "missing_script",
    };
  }
  let local = null;
  const localAbs = resolvePath(repoRoot, localRegistryPath);
  if (existsSync(localAbs)) {
    try {
      local = JSON.parse(readFileSync(localAbs, "utf8"));
    } catch (error) {
      local = { error: String(error.message || error) };
    }
  }
  for (const [name, spec] of Object.entries(EXTERNAL_WORKFLOWS)) {
    const registration = local?.workflows?.[name] || null;
    if (!registration) {
      entries[name] = { name, kind: "external", scriptPath: null, requiredArgs: spec.requiredArgs, status: "unregistered" };
      continue;
    }
    const abs = resolvePath(repoRoot, registration.scriptPath);
    let status = "available";
    if (!existsSync(abs)) status = "missing_script";
    else if (registration.sha256 && fileSha(abs) !== registration.sha256) status = "hash_mismatch";
    entries[name] = {
      name,
      kind: "external",
      scriptPath: abs,
      requiredArgs: spec.requiredArgs,
      status,
      registration: { sha256: registration.sha256 ?? null, registeredAt: registration.registeredAt ?? null, sourceNote: registration.sourceNote ?? null },
    };
  }
  return entries;
}

// Verify each required arg name actually appears in the workflow source
// (destructured or read off `args`). Catches contract drift against the real
// merged workflow code without executing it.
export async function validateArgsAgainstSource(entry) {
  if (!entry.scriptPath || !existsSync(entry.scriptPath)) return { ok: false, failures: ["script_missing"] };
  const source = await readFile(entry.scriptPath, "utf8");
  const failures = [];
  for (const arg of entry.requiredArgs) {
    const patterns = [
      new RegExp(`args\\.${arg}\\b`),
      new RegExp(`[{,\\s]${arg}[\\s,}:]`),
    ];
    if (!patterns.some((p) => p.test(source))) failures.push(`arg_not_in_source:${arg}`);
  }
  return { ok: failures.length === 0, failures };
}

export function buildInvocation(registry, name, args) {
  const entry = registry[name];
  if (!entry) throw new Error(`unknown workflow: ${name}`);
  if (entry.status !== "available") {
    return { ok: false, workflow: name, status: entry.status };
  }
  const missing = entry.requiredArgs.filter((key) => args[key] === undefined || args[key] === null);
  if (missing.length) return { ok: false, workflow: name, status: "missing_args", missing };
  return {
    ok: true,
    workflow: name,
    tool: "Workflow",
    input: { scriptPath: entry.scriptPath, args },
    scriptSha256: fileSha(entry.scriptPath),
  };
}

export function registerExternal(repoRoot, name, scriptPath, { sourceNote } = {}) {
  if (!EXTERNAL_WORKFLOWS[name]) throw new Error(`not an external workflow slot: ${name}`);
  const abs = resolvePath(repoRoot, scriptPath);
  if (!existsSync(abs)) throw new Error(`script not found: ${abs}`);
  const localAbs = resolvePath(repoRoot, LOCAL_REGISTRY_FILE);
  let local = { workflows: {} };
  if (existsSync(localAbs)) local = JSON.parse(readFileSync(localAbs, "utf8"));
  local.workflows = local.workflows || {};
  local.workflows[name] = {
    scriptPath: abs,
    sha256: fileSha(abs),
    registeredAt: new Date().toISOString(),
    sourceNote: sourceNote ?? null,
  };
  return { localAbs, local };
}
