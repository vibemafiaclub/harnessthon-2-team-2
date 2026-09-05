#!/usr/bin/env node
// Real screenshot capture through the Aside browser (requires the Aside app
// and its MCP/CLI installed and running — this project treats Aside MCP as a
// required base tool for evidence capture).
//
//   node research/bin/aside-capture.mjs <url> <outfile.jpg> [--settle-ms 4000]
//
// Recipe (discovered empirically; aside repl quirks):
// - ALWAYS open a dedicated tab with openTab(url). Never attach to or
//   screenshot the user's existing tabs (privacy), and background user tabs
//   time out on CDP capture anyway.
// - bringToFront() before capturing; a non-visible tab times out.
// - page.screenshot({path}) is sandboxed to an ephemeral session directory,
//   so return the buffer and stream it out as marked base64 on stdout.
// - The repl session teardown closes the tab automatically.

import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

const [url, outfile] = process.argv.slice(2);
const settleMs = Number(process.argv[process.argv.indexOf("--settle-ms") + 1]) || 4000;
if (!url || !outfile) {
  console.error("Usage: aside-capture.mjs <url> <outfile.jpg> [--settle-ms 4000]");
  process.exit(2);
}
if (!/^https:\/\//.test(url)) {
  console.error("Only HTTPS URLs are captured.");
  process.exit(2);
}

const code = `
const p = await openTab(${JSON.stringify(url)});
await p.waitForLoadState('load');
await new Promise(r => setTimeout(r, ${settleMs}));
await p.bringToFront();
await new Promise(r => setTimeout(r, 800));
const buf = await p.screenshot({ type: 'jpeg', quality: 70 });
console.log('B64START' + buf.toString('base64') + 'B64END');
`;

const raw = await new Promise((resolvePromise, rejectPromise) => {
  execFile("aside", ["repl", code], { maxBuffer: 64 * 1024 * 1024, timeout: 120_000 }, (error, stdout, stderr) => {
    if (error && !stdout.includes("B64START")) rejectPromise(new Error(`aside repl failed: ${stderr || error.message}`));
    else resolvePromise(stdout);
  });
});

const match = raw.match(/B64START([A-Za-z0-9+/=]+)B64END/);
if (!match) {
  console.error(`No screenshot data returned. Output head: ${raw.slice(0, 300)}`);
  process.exit(1);
}
const bytes = Buffer.from(match[1], "base64");
await writeFile(outfile, bytes);
const hash = `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
console.log(JSON.stringify({ url, file: outfile, bytes: bytes.byteLength, sha256: hash, capturedAt: new Date().toISOString(), captureMethod: "browser_capture", tool: "aside-repl" }, null, 2));
