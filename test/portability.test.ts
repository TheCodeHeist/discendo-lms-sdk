import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

/**
 * The SDK runs anywhere JavaScript does (Node, Bun, Deno, browsers, edge runtimes), so nothing in
 * src/ may import a runtime's own modules (`node:*`, `bun:*`, `fs`, `crypto`, ...). Standard
 * globals such as `globalThis.crypto` are fine.
 */
const SRC = resolve(import.meta.dir, '../src');
const files = (dir: string): string[] =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    return statSync(full).isDirectory() ? files(full) : full.endsWith('.ts') ? [full] : [];
  });

const RUNTIME_MODULES = /from\s+['"](node:[^'"]+|bun(:[^'"]+)?|fs|path|crypto|os|child_process|worker_threads|http|https|net)['"]/;

describe('portability', () => {
  it('nothing in src/ imports a runtime-specific module', () => {
    const offenders = files(SRC).filter((f) => RUNTIME_MODULES.test(readFileSync(f, 'utf8')));
    expect(offenders).toEqual([]);
  });
});
