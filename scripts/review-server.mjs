#!/usr/bin/env node
// Local-only review server: serves a run's review sheet and receives in-sheet
// feedback, appending it to <runDir>/feedback.json for the Claude session to read.
// Usage: node scripts/review-server.mjs <runDir> [port]
// Binds 127.0.0.1 only. No external publishing.

import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIME = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml' };

export function appendFeedback(runDir, payload) {
  if (!payload || !Array.isArray(payload.items)) throw new Error('payload.items must be an array');
  const entry = {
    submittedAt: new Date().toISOString(),
    items: payload.items
      .filter((i) => i && typeof i.text === 'string' && i.text.trim())
      .map((i) => ({ target: String(i.target ?? 'general'), text: i.text.trim() })),
    ...(payload.general && String(payload.general).trim() ? { general: String(payload.general).trim() } : {}),
    ...(Array.isArray(payload.revisions) ? { revisions: payload.revisions } : {}),
  };
  if (!entry.items.length && !entry.general) throw new Error('empty feedback');
  const path = join(runDir, 'feedback.json');
  const all = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : [];
  all.push(entry);
  writeFileSync(path, JSON.stringify(all, null, 2) + '\n');
  return entry;
}

export function startReviewServer(runDir, port = 4173) {
  const rootDir = resolve(runDir);
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/api/feedback') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        try {
          const entry = appendFeedback(rootDir, JSON.parse(body));
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: true, saved: entry }));
        } catch (e) {
          res.writeHead(400, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok: false, error: e.message }));
        }
      });
      return;
    }
    const rel = req.url === '/' ? 'review-sheet.html' : decodeURIComponent(req.url.slice(1).split('?')[0]);
    const path = resolve(rootDir, normalize(rel));
    if (!path.startsWith(rootDir) || !existsSync(path)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const ext = path.slice(path.lastIndexOf('.'));
    res.writeHead(200, { 'content-type': MIME[ext] ?? 'text/plain; charset=utf-8' });
    res.end(readFileSync(path));
  });
  server.on('error', (e) => {
    if (e.code === 'EADDRINUSE') {
      console.error(`port ${port} is already in use (another review/dev server?) - pick a different port`);
      process.exitCode = 1;
    } else {
      throw e;
    }
  });
  server.listen(port, '127.0.0.1');
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [runDir, port] = process.argv.slice(2);
  if (!runDir) {
    console.error('Usage: node scripts/review-server.mjs <runDir> [port]');
    process.exit(1);
  }
  const p = Number(port) || 4173;
  startReviewServer(runDir, p);
  console.log(`review server: http://127.0.0.1:${p}/ (feedback → ${join(runDir, 'feedback.json')})`);
}
