import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import * as sdk from '../src/index.js';
import { DEFAULT_RULES } from '../src/core/index.js';

/**
 * Keeps the documentation from drifting away from the code. These checks are deliberately
 * mechanical (a name is mentioned, a link resolves) and cannot say whether a page is any
 * good, but they catch the usual rot: a new action, subpath or export nobody wrote up, and a
 * link or file path that no longer exists.
 *
 * Limits worth knowing: only *runtime* exports are checked (types are erased, so a new
 * interface is invisible to this test), and only top-level ones, not the methods of a class.
 * A name merely appearing somewhere in the docs satisfies it, so it cannot tell a real
 * explanation from a passing mention.
 */

const root = resolve(import.meta.dir, '..');
const docsDir = join(root, 'docs');
const read = (path: string) => readFileSync(path, 'utf8');

/** Pages that are not part of the module reference and need no entry in the index. */
const REDIRECT_PAGES = new Set(['OTHER_MODULES.md']);

const pages = readdirSync(docsDir)
  .filter((f) => f.endsWith('.md'))
  .sort();
const text = (name: string) => read(join(docsDir, name));
const allDocs = pages.map(text).join('\n');
const index = text('INDEX.md');

describe('documentation: coverage', () => {
  it('lists every built-in permission action in PERMISSIONS.md', () => {
    const permissions = text('PERMISSIONS.md');
    const missing = Object.keys(DEFAULT_RULES).filter((action) => !permissions.includes(`\`${action}\``));
    expect(missing).toEqual([]);
  });

  it('lists every package subpath in the index', () => {
    const exportsMap = JSON.parse(read(join(root, 'package.json'))).exports as Record<string, string>;
    const missing = Object.keys(exportsMap)
      .filter((key) => key !== '.')
      .map((key) => `discendo-sdk/${key.slice(2)}`)
      .filter((subpath) => !index.includes(`\`${subpath}\``));
    expect(missing).toEqual([]);
  });

  it('mentions every runtime export of the SDK somewhere in the docs', () => {
    const missing = Object.keys(sdk)
      .filter((name) => !new RegExp(`\\b${name}\\b`).test(allDocs))
      .sort();
    expect(missing).toEqual([]);
  });

  it('links every page from the index', () => {
    const missing = pages
      .filter((page) => page !== 'INDEX.md' && !REDIRECT_PAGES.has(page))
      .filter((page) => !index.includes(`(./${page})`));
    expect(missing).toEqual([]);
  });

  it('gives every module page a "Known limitations" section', () => {
    const modulePages = pages.filter((p) => !['INDEX.md', 'GETTING_STARTED.md', ...REDIRECT_PAGES].includes(p));
    const missing = modulePages.filter((p) => !/^## Known limitations/m.test(text(p)));
    expect(missing).toEqual([]);
  });
});

describe('documentation: links and paths', () => {
  const markdownFiles = [
    ...pages.map((p) => join(docsDir, p)),
    join(root, 'README.md'),
    join(root, 'src/core/README.md'),
    join(root, 'src/domains/README.md'),
    join(root, 'src/services/README.md'),
  ];

  it('has no broken relative links', () => {
    const broken: string[] = [];
    for (const file of markdownFiles) {
      for (const [, target] of read(file).matchAll(/\]\(([^)\s]+)\)/g)) {
        if (!target || /^(https?:|mailto:|#)/.test(target)) continue;
        const path = resolve(dirname(file), target.split('#')[0] ?? '');
        if (!existsSync(path)) broken.push(`${file.replace(root + '/', '')} -> ${target}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it('only mentions source and test paths that exist', () => {
    const missing: string[] = [];
    for (const file of markdownFiles) {
      for (const [, path] of read(file).matchAll(/`((?:src|test|docs)\/[^`\s]*)`/g)) {
        if (!path || /[*<>{}]/.test(path)) continue; // patterns and placeholders
        if (!existsSync(join(root, path.replace(/\/$/, '')))) missing.push(`${file.replace(root + '/', '')}: ${path}`);
      }
    }
    expect(missing).toEqual([]);
  });
});
