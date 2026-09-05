#!/usr/bin/env node
// Capture an exact local HTML snapshot in a dedicated Aside tab, never an existing user tab.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { hash, runFile } from './lib/visual-quality.mjs';

const [rootArg, artifactPath, prefix, widthArg, heightArg] = process.argv.slice(2);
const width = Number(widthArg), height = Number(heightArg);
if (!rootArg || !artifactPath || !/^[a-z0-9-]+$/.test(prefix ?? '') || !Number.isInteger(width) || !Number.isInteger(height) || width < 240 || width > 3840 || height < 240 || height > 3840) throw new Error('Usage: capture-concept.mjs <runDir> <html-file> <evidence-prefix> <width> <height>');
const root = resolve(rootArg), path = runFile(root, artifactPath), html = readFileSync(path);
const revisionHash = hash(html);
const server = createServer((req, res) => {
  if (req.url !== '/concept.html') { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; img-src data:; font-src data:; connect-src 'none'; frame-src 'none'; form-action 'none'" });
  res.end(html);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
try {
  const url = `http://127.0.0.1:${server.address().port}/concept.html`;
  // Aside exposes target-scoped CDP, not Playwright's setViewportSize.
  const code = `const p=await openTab(${JSON.stringify(url)}); try { await p._sendToTarget('Emulation.setDeviceMetricsOverride',{width:${width},height:${height},deviceScaleFactor:1,mobile:false}); await p.waitForLoadState('load'); await p.evaluate(async()=>{await document.fonts.ready; return true}); await p.bringToFront(); await p.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(()=>r(true))))); const metrics=await p.evaluate(()=>({fontsReady:document.fonts.status==='loaded',viewportWidth:innerWidth,viewportHeight:innerHeight,overflowX:document.documentElement.scrollWidth>innerWidth,brokenImages:[...document.images].filter(i=>!i.complete||!i.naturalWidth).length})); const shot=await p._sendToTarget('Page.captureScreenshot',{format:'png',fromSurface:true,captureBeyondViewport:true,clip:{x:0,y:0,width:${width},height:${height},scale:1}}); console.log('CAPTURE_JSON_START'+JSON.stringify({metrics,png:shot.data})+'CAPTURE_JSON_END'); } finally { await p.close(); }`;
  const { stdout } = await promisify(execFile)('aside', ['repl', code], { timeout: 120000, maxBuffer: 48 * 1024 * 1024 });
  const match = stdout.match(/CAPTURE_JSON_START(\{[^\n]+\})CAPTURE_JSON_END/);
  if (!match) throw new Error(`Aside returned no capture; do not fabricate evidence. ${stdout.slice(0, 1200)}`);
  const result = JSON.parse(match[1]), bytes = Buffer.from(result.png, 'base64');
  if (bytes.length < 24 || bytes.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a' || bytes.readUInt32BE(16) !== width || bytes.readUInt32BE(20) !== height) throw new Error('Capture dimensions do not match the requested viewport; evidence was not saved');
  if (result.metrics.viewportWidth !== width || result.metrics.viewportHeight !== height) throw new Error('Browser viewport does not match the requested dimensions');
  if (hash(readFileSync(path)) !== revisionHash) throw new Error('HTML changed during capture');
  const screenshotPath = `visual-evidence/${prefix}.png`, capturePath = `visual-evidence/${prefix}.capture.json`;
  mkdirSync(dirname(resolve(root, screenshotPath)), { recursive: true });
  writeFileSync(resolve(root, screenshotPath), bytes);
  const receipt = { captureMethod: 'aside-browser', artifactPath, revisionHash, viewport: { width, height }, screenshotPath, screenshotHash: hash(bytes), capturedAt: new Date().toISOString(), metrics: result.metrics };
  writeFileSync(resolve(root, capturePath), JSON.stringify(receipt, null, 2) + '\n');
  console.log(JSON.stringify({ capturePath, ...receipt }));
} finally { server.closeAllConnections(); await new Promise(r => server.close(r)); }
