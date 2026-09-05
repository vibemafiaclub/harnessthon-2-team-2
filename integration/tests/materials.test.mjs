import test from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { acquireMaterials, materialsFingerprint, sniffContent } from "../lib/materials.mjs";
import { tempDir, NOW } from "./fixtures.mjs";

test("acquires text, binary, missing, and url materials with honest statuses", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "prd.md"), "# PRD\ncontent");
  await writeFile(join(dir, "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]));
  const request = {
    materials: [
      { path: join(dir, "prd.md"), role: "prd" },
      { path: join(dir, "shot.png"), role: "screenshot" },
      { path: join(dir, "nope.pdf") },
      { url: "https://example.com/tokens" },
    ],
  };
  const materials = await acquireMaterials(request, { baseDir: dir, nowIso: NOW });
  assert.equal(materials[0].parseStatus, "parsed_text");
  assert.ok(materials[0].sha256);
  assert.ok(materials[0].textExcerpt.includes("# PRD"));
  assert.equal(materials[1].parseStatus, "binary_unparsed");
  assert.equal(materials[1].contentSniff, "png");
  assert.equal(materials[1].observationRequired, true);
  assert.equal(materials[1].textExcerpt, null);
  assert.equal(materials[2].parseStatus, "missing");
  assert.equal(materials[2].sha256, null);
  assert.equal(materials[3].parseStatus, "remote_unfetched");
  assert.equal(materials[3].observationRequired, true);
});

test("content sniffing does not trust extensions", async () => {
  assert.equal(sniffContent(Buffer.from("%PDF-1.4 etc")), "pdf");
  assert.equal(sniffContent(Buffer.from("<!doctype html><html>")), "html");
  assert.equal(sniffContent(Buffer.from('{"a":1}')), "json");
  assert.equal(sniffContent(Buffer.from([0, 1, 2, 3])), "binary");
});

test("materials fingerprint changes when a source file changes", async () => {
  const dir = await tempDir();
  await writeFile(join(dir, "a.md"), "one");
  const request = { materials: [{ path: join(dir, "a.md") }] };
  const first = materialsFingerprint(await acquireMaterials(request, { baseDir: dir, nowIso: NOW }));
  await writeFile(join(dir, "a.md"), "two");
  const second = materialsFingerprint(await acquireMaterials(request, { baseDir: dir, nowIso: NOW }));
  assert.notEqual(first, second);
});
