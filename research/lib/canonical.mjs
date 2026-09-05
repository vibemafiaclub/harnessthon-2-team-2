import { createHash } from "node:crypto";

// Minimal portable port of the lab's canonical hashing contract
// (team2-harness-lab/workbench/research-evidence.mjs). Kept dependency-free.

export function stableStringify(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .filter((key) => value[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`)
    .join(",")}}`;
}

export function sha256(value) {
  const bytes = typeof value === "string" || Buffer.isBuffer(value) ? value : stableStringify(value);
  return `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
}

export function isSha256(value) {
  return /^sha256:[a-f0-9]{64}$/.test(String(value || ""));
}

export function isIsoUtc(value) {
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(String(value || "")) && !Number.isNaN(Date.parse(value));
}

export class ContractError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ContractError";
    this.code = code;
  }
}

export function fail(code, message) {
  throw new ContractError(code, message);
}

export function requiredString(value, maximum, label) {
  const text = String(value ?? "").trim();
  if (!text || text.length > maximum) fail("string_invalid", `${label} must be a non-empty string up to ${maximum} characters.`);
  return text;
}

export function optionalString(value, maximum, label) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (text.length > maximum) fail("string_invalid", `${label} must be up to ${maximum} characters.`);
  return text || null;
}

export function requiredEnum(value, allowed, label) {
  const text = requiredString(value, 80, label);
  if (!allowed.has(text)) fail("enum_invalid", `${label} must be one of: ${[...allowed].join(", ")}.`);
  return text;
}

export function requiredTime(value, label) {
  const text = requiredString(value, 40, label);
  if (!isIsoUtc(text)) fail("time_invalid", `${label} must be an ISO UTC timestamp.`);
  return text;
}
