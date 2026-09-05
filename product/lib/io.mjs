import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync, readdirSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, relative, sep, join } from 'node:path';

export const sha = value => createHash('sha256').update(value).digest('hex');
export const canonical = value => JSON.stringify(value, (_key, v) => v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v);
export const digest = value => sha(canonical(value));
export const readJSON = path => JSON.parse(readFileSync(path, 'utf8'));
export function writeJSON(path, value) { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, JSON.stringify(value, null, 2) + '\n'); }
export function localPath(root, path) {
  if (typeof path !== 'string' || !path || path.startsWith('/')) throw new Error('Expected a relative artifact path');
  const full = resolve(root, path), rel = relative(realpathSync(root), realpathSync(full));
  if (rel === '..' || rel.startsWith('..' + sep)) throw new Error(`Artifact escapes input root: ${path}`);
  return full;
}
export function files(root, prefix = '') {
  return readdirSync(join(root, prefix)).sort().flatMap(name => {
    if (['node_modules', '.git', 'dist', 'storybook-static', 'evidence'].includes(name)) return [];
    const path = join(prefix, name), st = lstatSync(join(root, path));
    if (st.isSymbolicLink()) throw new Error(`Symlink is not portable: ${path}`);
    return st.isDirectory() ? files(root, path) : [path];
  });
}
export const inventory = root => files(root).map(path => ({ path, sha256: sha(readFileSync(join(root, path))) }));
