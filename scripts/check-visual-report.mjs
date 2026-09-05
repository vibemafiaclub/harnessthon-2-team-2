#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { assertVisualReport, hash, runFile } from './lib/visual-quality.mjs';
const [runDir, artifactId, artifactPath, width, height, reportPath] = process.argv.slice(2);
if (!reportPath) throw new Error('Usage: check-visual-report.mjs runDir artifactId html width height reportPath');
assertVisualReport(runDir, { id: artifactId, path: artifactPath, revisionHash: hash(readFileSync(runFile(runDir, artifactPath))) }, { width: Number(width), height: Number(height) }, reportPath);
console.log('Rendered visual quality passed');
