#!/usr/bin/env node
// Append a human review decision to <runDir>/reviews.json, bound to the exact
// artifact revisions currently in lane-output.json (decision D4/D7).
// Usage:
//   node scripts/record-review.mjs <runDir> --decision approved|revise|rejected \
//     --decided-at <iso> [--feedback "..."] [--concept <conceptId>] [--axis-note axis="..."]...
// Refuses to record if any artifact file no longer matches its recorded hash.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValid } from './lib/validate.mjs';
import { sha256File } from './render-review-sheet.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const reviewSchema = JSON.parse(readFileSync(join(root, 'contracts/review-record.schema.json'), 'utf8'));

export function recordReview(runDir, { decision, decidedAt, feedback, selectedConceptId, axisNotes }) {
  const output = JSON.parse(readFileSync(join(runDir, 'lane-output.json'), 'utf8'));

  const boundRevisions = output.artifacts.map((a) => {
    const actual = sha256File(join(runDir, a.path));
    if (actual !== a.revisionHash) {
      throw new Error(`Cannot record review: ${a.id} changed since packaging (${a.revisionHash.slice(0, 12)}… → ${actual.slice(0, 12)}…).`);
    }
    return { artifactId: a.id, revisionHash: a.revisionHash };
  });

  const reviewsPath = join(runDir, 'reviews.json');
  const reviews = existsSync(reviewsPath) ? JSON.parse(readFileSync(reviewsPath, 'utf8')) : [];

  const record = {
    reviewId: `${output.runId}-r${output.round}-${reviews.length + 1}`,
    laneId: output.laneId,
    runId: output.runId,
    round: output.round,
    decision,
    decidedBy: 'human',
    decidedAt,
    boundRevisions,
    ...(selectedConceptId ? { selectedConceptId } : {}),
    ...(axisNotes && Object.keys(axisNotes).length ? { axisNotes } : {}),
    ...(feedback ? { feedback } : {}),
  };
  assertValid(reviewSchema, record, 'review record');

  reviews.push(record);
  writeFileSync(reviewsPath, JSON.stringify(reviews, null, 2) + '\n');
  return record;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [runDir, ...rest] = process.argv.slice(2);
  const opts = { axisNotes: {} };
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] === '--decision') opts.decision = rest[++i];
    else if (rest[i] === '--decided-at') opts.decidedAt = rest[++i];
    else if (rest[i] === '--feedback') opts.feedback = rest[++i];
    else if (rest[i] === '--concept') opts.selectedConceptId = rest[++i];
    else if (rest[i] === '--axis-note') {
      const [axis, ...note] = rest[++i].split('=');
      opts.axisNotes[axis] = note.join('=');
    }
  }
  if (!runDir || !opts.decision || !opts.decidedAt) {
    console.error('Usage: node scripts/record-review.mjs <runDir> --decision <d> --decided-at <iso> [--feedback ...] [--concept ...]');
    process.exit(1);
  }
  console.log(JSON.stringify(recordReview(runDir, opts), null, 2));
}
