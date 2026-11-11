// -----------------------------------------------------------------------------
// Mutation run: `node scripts/mutants.mjs [label-prefix,...]` (run it under
// `memcap`). Copies the repository (without .git) into its own mkdtemp
// directory, applies each mutant of scripts/mutants.list.mjs one at a time,
// runs every test/*.test.js and reports KILLED / SURVIVED / HUNG; the whole
// process group of a run is killed after 90 s. The copy is removed at the end.
// -----------------------------------------------------------------------------

import { spawn } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('..', import.meta.url));
const dir = mkdtempSync(path.join(tmpdir(), 'bticino-mutants-'));
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => process.exit(130));
cpSync(REPO, dir, { recursive: true, filter: (src) => path.basename(src) !== '.git' });
const list = (await import(path.join(REPO, 'scripts/mutants.list.mjs'))).default;
const only = process.argv[2]?.split(',');
const tests = readdirSync(path.join(dir, 'test'))
  .filter((f) => f.endsWith('.test.js'))
  .map((f) => `test/${f}`);

const run = (ms) =>
  new Promise((resolve) => {
    const { NODE_TEST_CONTEXT: _ignored, ...env } = process.env;
    const child = spawn(process.execPath, ['--test', '--test-timeout=20000', ...tests], {
      cwd: dir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (out += d));
    const kill = setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        // already gone
      }
      resolve({ code: 'HUNG', out });
    }, ms);
    child.on('close', (code) => {
      clearTimeout(kill);
      resolve({ code, out });
    });
  });

const baseline = await run(120000);
console.log('baseline', baseline.code === 0 ? 'green' : `FAILED (${baseline.code})`);
if (baseline.code !== 0) process.exit(1);
const survived = [];
for (const [label, file, from, to] of list) {
  if (only && !only.some((o) => label.startsWith(`${o} `))) continue;
  const target = path.join(dir, file);
  const original = readFileSync(target, 'utf8');
  const n = original.split(from).length - 1;
  if (n !== 1) {
    console.log(`SKIP     ${label}: found ${n} times`);
    survived.push(label);
    continue;
  }
  writeFileSync(
    target,
    original.replace(from, () => to),
  );
  const started = Date.now();
  const r = await run(90000);
  writeFileSync(target, original);
  const verdict = r.code === 'HUNG' ? 'HUNG    ' : r.code !== 0 ? 'KILLED  ' : 'SURVIVED';
  if (r.code === 0 || r.code === 'HUNG') survived.push(label);
  console.log(`${verdict} ${label} ${((Date.now() - started) / 1000).toFixed(1)}s`);
}
console.log(`-- ${survived.length} not killed${survived.length ? `: ${survived.join('; ')}` : ''}`);
process.exit(survived.length ? 1 : 0);
