import { describe, it, expect } from 'bun:test';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve, dirname, sep } from 'node:path';

/**
 * Enforces the layering rules documented in src/domains/README.md,
 * src/services/README.md and src/core/README.md, so a contributor's PR
 * that quietly breaks them fails CI instead of relying on a reviewer to
 * notice.
 *
 * Layers:
 *   core      may import: nothing else in the SDK
 *   domains   may import: core, and files within its OWN module
 *   services  may import: core, and files within its OWN module
 *   interop   may import: core, and files within its OWN module
 */
const SRC = resolve(import.meta.dir, '../src');

function tsFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      if (name === 'testing') continue; // in-memory test helpers are exempt
      out.push(...tsFiles(full));
    } else if (name.endsWith('.ts') && !name.endsWith('.d.ts')) {
      out.push(full);
    }
  }
  return out;
}

/** Returns "core", "domains/scheduling", "services/reporting", "interop", or "root". */
function moduleOf(file: string): string {
  const parts = relative(SRC, file).split(sep);
  const layer = parts[0]!;
  if (layer === 'domains' || layer === 'services') return `${layer}/${parts[1]}`;
  if (parts.length === 1) return 'root';
  return layer;
}

function relativeImports(file: string): string[] {
  const text = readFileSync(file, 'utf8');
  const found: string[] = [];
  for (const m of text.matchAll(/(?:from|import)\s*['"](\.{1,2}\/[^'"]+)['"]/g)) {
    found.push(m[1]!);
  }
  return found;
}

describe('architecture: layering rules', () => {
  const files = tsFiles(SRC);

  it('finds source files to check (guards against this test silently checking nothing)', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('every module imports only core or itself', () => {
    const violations: string[] = [];
    for (const file of files) {
      const from = moduleOf(file);
      if (from === 'root') continue; // src/index.ts barrel legitimately imports everything
      for (const spec of relativeImports(file)) {
        const target = resolve(dirname(file), spec);
        const to = moduleOf(target + '.ts');
        if (to === from || to === 'core') continue;
        violations.push(`${relative(SRC, file)} imports ${spec} (${from} -> ${to})`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('core imports nothing outside core', () => {
    const violations: string[] = [];
    for (const file of files.filter((f) => moduleOf(f) === 'core')) {
      for (const spec of relativeImports(file)) {
        const to = moduleOf(resolve(dirname(file), spec) + '.ts');
        if (to !== 'core') violations.push(`${relative(SRC, file)} imports ${spec}`);
      }
    }
    expect(violations).toEqual([]);
  });

  it('every domain and service module has an index.ts barrel', () => {
    const missing: string[] = [];
    for (const layer of ['domains', 'services']) {
      for (const name of readdirSync(join(SRC, layer))) {
        const dir = join(SRC, layer, name);
        if (!statSync(dir).isDirectory()) continue;
        if (!readdirSync(dir).includes('index.ts')) missing.push(`${layer}/${name}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('src/ contains only the four layers and the root barrel', () => {
    // A module folder sitting directly under src/ (e.g. src/scheduling/) would
    // pass every other check here, because it just looks like a module named
    // "scheduling". That is exactly how leftover pre-restructure copies went
    // unnoticed, so the allowed top-level entries are spelled out.
    const allowed = ['core', 'domains', 'services', 'interop', 'index.ts'];
    const unexpected = readdirSync(SRC).filter((name) => !allowed.includes(name));
    expect(unexpected).toEqual([]);
  });

  it('every layer folder has a README explaining its rule', () => {
    for (const layer of ['core', 'domains', 'services']) {
      expect(readdirSync(join(SRC, layer))).toContain('README.md');
    }
  });
});
