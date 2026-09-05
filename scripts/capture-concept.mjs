#!/usr/bin/env node
// Capture frozen HTML in an isolated Chromium context; never use a user's tab.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { hash, runFile } from './lib/visual-quality.mjs';

const [rootArg, artifactPath, prefix, widthArg, heightArg] = process.argv.slice(2);
const width = Number(widthArg), height = Number(heightArg);
if (!rootArg || !artifactPath || !/^[a-z0-9-]+$/.test(prefix ?? '') || !Number.isInteger(width) || !Number.isInteger(height) || width < 240 || width > 3840 || height < 240 || height > 3840) throw new Error('Usage: capture-concept.mjs <runDir> <html-file> <evidence-prefix> <width> <height>');
const root = resolve(rootArg), path = runFile(root, artifactPath), html = readFileSync(path);
const revisionHash = hash(html);
const require = createRequire(new URL('../product/package.json', import.meta.url));
let chromium;
try { ({ chromium } = require('playwright')); }
catch { throw new Error('Browser dependency missing. Run npm ci --prefix product first.'); }
const server = createServer((req, res) => {
  if (req.url !== '/concept.html') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'" });
  res.end(html);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
let browser;
try {
  const url = `http://127.0.0.1:${server.address().port}/concept.html`;
  browser = await chromium.launch({ channel: process.env.PRODUCT_BROWSER_CHANNEL ?? 'chrome', headless: true });
  const context = await browser.newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await context.route('**/*', route => route.request().url() === url ? route.continue() : route.abort());
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.goto(url, { waitUntil: 'load' });
  await page.evaluate(async () => { await document.fonts.ready; });
  const metrics = await page.evaluate(() => ({ fontsReady: document.fonts.status === 'loaded', viewportWidth: innerWidth, viewportHeight: innerHeight, overflowX: document.documentElement.scrollWidth > innerWidth, brokenImages: [...document.images].filter(i => !i.complete || !i.naturalWidth).length }));
  const bytes = await page.screenshot({ type: 'png', animations: 'disabled' });
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) throw new Error('Capture dimensions do not match the requested viewport; evidence was not saved');
  if (metrics.viewportWidth !== width || metrics.viewportHeight !== height) throw new Error('Browser viewport does not match the requested dimensions');
  if (hash(readFileSync(path)) !== revisionHash) throw new Error('HTML changed during capture');
  const screenshotPath = `visual-evidence/${prefix}.png`, capturePath = `visual-evidence/${prefix}.capture.json`;
  mkdirSync(dirname(resolve(root, screenshotPath)), { recursive: true });
  writeFileSync(resolve(root, screenshotPath), bytes);
  const receipt = { captureMethod: 'playwright-chromium', browserVersion: browser.version(), artifactPath, revisionHash, viewport: { width, height }, screenshotPath, screenshotHash: hash(bytes), capturedAt: new Date().toISOString(), metrics };
  writeFileSync(resolve(root, capturePath), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ capturePath, ...receipt }));
} finally { try { if (browser) await browser.close(); } finally { server.closeAllConnections(); await new Promise(r => server.close(r)); } }
