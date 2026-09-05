import test from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadRegistry, validateArgsAgainstSource, buildInvocation, registerExternal, BUILTIN_WORKFLOWS } from "../lib/registry.mjs";
import { tempDir } from "./fixtures.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("builtin adapter arg contracts match the actual merged workflow sources", async () => {
  const registry = loadRegistry(repoRoot);
  for (const name of Object.keys(BUILTIN_WORKFLOWS)) {
    const entry = registry[name];
    assert.equal(entry.status, "available", `${name} script missing`);
    const check = await validateArgsAgainstSource(entry);
    assert.deepEqual(check, { ok: true, failures: [] }, `${name}: ${JSON.stringify(check.failures)}`);
  }
});

test("every in-repo lane is a builtin adapter after the stage-4 merge", () => {
  const registry = loadRegistry(repoRoot);
  for (const name of ["wireframe-lane", "visual-concept-elicit", "visual-concept-lane"]) {
    assert.equal(registry[name].kind, "builtin", name);
    assert.equal(registry[name].status, "available", name);
  }
  // The two visual-concept adapters are two passes over one real lane script.
  assert.equal(registry["visual-concept-elicit"].scriptPath, registry["visual-concept-lane"].scriptPath);
  assert.ok(registry["visual-concept-lane"].requiredArgs.includes("clientPreferences"));
});

test("workflows with no script in this repo stay unregistered, with explicit status", () => {
  const registry = loadRegistry(repoRoot, "integration/tests/does-not-exist.json");
  for (const name of ["production-outputs"]) {
    assert.equal(registry[name].status, "unregistered");
    const invocation = buildInvocation(registry, name, {});
    assert.equal(invocation.ok, false);
    assert.equal(invocation.status, "unregistered");
  }
});

test("registration pins a content hash; drift makes the adapter unavailable", async () => {
  const root = await tempDir();
  await mkdir(join(root, "integration"), { recursive: true });
  const script = join(root, "lane.mjs");
  await writeFile(script, "const { prdPath, runDir, conceptId } = args\nexport default 1\n");
  const { localAbs, local } = registerExternal(root, "production-outputs", script);
  await writeFile(localAbs, JSON.stringify(local));
  let registry = loadRegistry(root);
  assert.equal(registry["production-outputs"].status, "available");

  await writeFile(script, "// drifted source\nconst { totally } = args\n");
  registry = loadRegistry(root);
  assert.equal(registry["production-outputs"].status, "hash_mismatch");
  assert.equal(buildInvocation(registry, "production-outputs", { prdPath: "x", runDir: "y", conceptId: "z" }).ok, false);
});

test("arg contract validation catches a source that lost an argument", async () => {
  const root = await tempDir();
  const script = join(root, "lane.mjs");
  await writeFile(script, "const { prdPath, runDir } = args\n");
  const check = await validateArgsAgainstSource({ scriptPath: script, requiredArgs: ["prdPath", "runDir", "runId", "round", "startedAt"] });
  assert.equal(check.ok, false);
  assert.ok(check.failures.includes("arg_not_in_source:runId"));
});

test("buildInvocation refuses missing required args", () => {
  const registry = loadRegistry(repoRoot);
  const invocation = buildInvocation(registry, "competitor-reference", { prd: { x: 1 } });
  assert.equal(invocation.ok, false);
  assert.deepEqual(invocation.missing, ["nowIso"]);
  const good = buildInvocation(registry, "competitor-reference", { prd: { x: 1 }, nowIso: "2026-09-05T00:00:00Z" });
  assert.equal(good.ok, true);
  assert.ok(good.input.scriptPath.endsWith("research/workflow/competitor-reference.workflow.mjs"));
  assert.ok(good.scriptSha256.startsWith("sha256:"));
});
