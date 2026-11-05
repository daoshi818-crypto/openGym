/* Static Docker COPY/import closure regression. Real boot is separately exercised by api-image CI. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const api = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = fs.readFileSync(path.join(api, 'Dockerfile'), 'utf8');
function missingCopies(docker) {
  const sources = [...docker.matchAll(/^COPY\s+(.+?)\s+\.\/?\s*$/gm)].flatMap(m => m[1].split(/\s+/)).map(s => s.replace(/^\.\//, ''));
  // The directory COPY instructions have an explicit ./destination and are not covered above.
  for (const m of docker.matchAll(/^COPY\s+(\S+)\s+\.\/(\S+)\s*$/gm)) if (m[1] === m[2]) sources.push(m[1]);
  const covered = file => sources.some(src => file === src || file.startsWith(src + '/'));
  const seen = new Set(), missing = new Set();
  function visit(file) {
    if (seen.has(file)) return;
    seen.add(file);
    if (!covered(file)) missing.add(file);
    const text = fs.readFileSync(path.join(api, file), 'utf8');
    for (const m of text.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*)['"]([^'"]+)['"]/g)) {
      if (!m[1].startsWith('.')) continue;
      const child = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1]));
      if (child.endsWith('.js')) visit(child);
    }
  }
  visit('server.js');
  return [...missing].sort();
}
test('API Docker COPY declarations cover the literal local server import graph', () => {
  assert.deepEqual(missingCopies(dockerfile), []);
});
test('Docker import closure guard catches the integrations/net-guard boot regression', () => {
  const old = dockerfile.replace(' net-guard.js', '').replace(/^COPY integrations \.\/integrations\r?\n/m, '');
  const missing = missingCopies(old);
  assert.ok(missing.includes('net-guard.js'));
  assert.ok(missing.includes('integrations/index.js'));
});
