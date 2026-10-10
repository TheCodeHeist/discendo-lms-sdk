import { describe, it, expect } from 'bun:test';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dir, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));

describe('packaging and publishing readiness', () => {
  it('does not declare unused peerDependencies', () => {
    expect(pkg.peerDependencies).toBeUndefined();
  });

  it('pins all devDependencies without using "latest"', () => {
    expect(pkg.devDependencies).toBeDefined();
    for (const [dep, version] of Object.entries(pkg.devDependencies as Record<string, string>)) {
      expect(version).not.toBe('latest');
      expect(version).toMatch(/^[~^]?\d+\.\d+/);
    }
  });

  it('specifies the files field including dist, README.md, and LICENSE', () => {
    expect(Array.isArray(pkg.files)).toBe(true);
    expect(pkg.files).toContain('dist');
    expect(pkg.files).toContain('README.md');
    expect(pkg.files).toContain('LICENSE');
  });

  it('has a prepack build script', () => {
    expect(pkg.scripts?.prepack).toBe('bun run build');
  });

  it('exports every subpath with explicit types and default condition', () => {
    const exports = pkg.exports as Record<string, unknown>;
    expect(exports).toBeDefined();
    for (const [subpath, target] of Object.entries(exports)) {
      expect(typeof target).toBe('object');
      const entry = target as { types?: string; default?: string };
      expect(entry.types).toBeDefined();
      expect(entry.types).toEndWith('.d.ts');
      expect(entry.default).toBeDefined();
      expect(entry.default).toEndWith('.js');
    }
  });

  it('has a CI workflow file configured', () => {
    expect(existsSync(join(root, '.github/workflows/ci.yml'))).toBe(true);
  });
});
