import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { sha256 } from "../../research/lib/canonical.mjs";

// Deterministic material acquisition. This layer never classifies semantically
// (that is the intake workflow's job) — it records source identity, bytes,
// hashes, parse status, and safe text excerpts. Nothing here executes or
// renders supplied content.

export const RECOGNIZED_ROLES = [
  "prd",
  "approved-prd",
  "brand-tokens",
  "design-system",
  "component-library",
  "html-template",
  "screenshot",
  "mockup",
  "wireframe",
  "ia-userflow",
  "research-package",
  "concept-output",
  "page-output",
  "adopted-concept",
  "reference",
];

const TEXT_EXTENSIONS = new Set(["md", "markdown", "txt", "json", "html", "htm", "css", "js", "mjs", "csv", "svg", "yaml", "yml", "ts", "tsx", "jsx"]);
const EXCERPT_LIMIT = 6000;

export function sniffContent(buffer) {
  if (buffer.length >= 8 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return "png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "jpeg";
  if (buffer.length >= 5 && buffer.slice(0, 5).toString("latin1") === "%PDF-") return "pdf";
  const head = buffer.slice(0, 512).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<!doctype html") || head.startsWith("<html")) return "html";
  if (head.startsWith("{") || head.startsWith("[")) return "json";
  if (buffer.slice(0, 4096).includes(0)) return "binary";
  return "text";
}

function extensionOf(path) {
  const match = /\.([A-Za-z0-9]+)$/.exec(path);
  return match ? match[1].toLowerCase() : "";
}

export async function acquireOne(input, { baseDir, nowIso, index }) {
  const id = input.id || `mat-${String(index + 1).padStart(2, "0")}`;
  const base = {
    id,
    declaredRole: input.role ?? null,
    description: input.description ?? null,
    acquiredAt: nowIso,
  };
  if (input.url) {
    // URLs are never fetched by this deterministic layer; the intake workflow
    // must observe them through its own tools (WebFetch) and attach evidence.
    return {
      ...base,
      source: { kind: "url", url: input.url },
      parseStatus: "remote_unfetched",
      sha256: null,
      bytes: null,
      contentSniff: null,
      textExcerpt: null,
      observationRequired: true,
    };
  }
  if (!input.path) {
    return { ...base, source: { kind: "invalid" }, parseStatus: "missing", sha256: null, bytes: null, contentSniff: null, textExcerpt: null, observationRequired: false };
  }
  const absPath = isAbsolute(input.path) ? input.path : resolve(baseDir, input.path);
  const source = { kind: "file", path: absPath };
  let buffer;
  try {
    const info = await stat(absPath);
    if (!info.isFile()) throw new Error("not a regular file");
    buffer = await readFile(absPath);
  } catch (error) {
    return {
      ...base,
      source,
      parseStatus: "missing",
      error: String(error.message || error),
      sha256: null,
      bytes: null,
      contentSniff: null,
      textExcerpt: null,
      observationRequired: false,
    };
  }
  const sniff = sniffContent(buffer);
  const ext = extensionOf(absPath);
  const isText = sniff === "text" || sniff === "json" || sniff === "html" || (TEXT_EXTENSIONS.has(ext) && sniff !== "binary" && sniff !== "png" && sniff !== "jpeg" && sniff !== "pdf");
  return {
    ...base,
    source,
    parseStatus: isText ? "parsed_text" : "binary_unparsed",
    sha256: sha256(buffer),
    bytes: buffer.length,
    contentSniff: sniff,
    extension: ext || null,
    textExcerpt: isText ? buffer.toString("utf8").slice(0, EXCERPT_LIMIT) : null,
    // Binary inputs (screenshots, PDFs) require an actual model observation
    // before any extracted content may be claimed for them.
    observationRequired: !isText,
  };
}

export async function acquireMaterials(request, { baseDir, nowIso }) {
  const materials = [];
  const inputs = request.materials || [];
  for (let i = 0; i < inputs.length; i += 1) {
    materials.push(await acquireOne(inputs[i], { baseDir, nowIso, index: i }));
  }
  const ids = new Set();
  for (const material of materials) {
    if (ids.has(material.id)) throw new Error(`duplicate material id: ${material.id}`);
    ids.add(material.id);
  }
  return materials;
}

export function materialsFingerprint(materials) {
  const identity = materials.map((m) => ({ id: m.id, sha256: m.sha256, source: m.source, parseStatus: m.parseStatus, declaredRole: m.declaredRole }));
  return sha256(JSON.stringify(identity));
}
