import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const required = [
  'generate',
  'generate:check',
  'test:schema-bytes',
  'test:pi:min',
  'test:pi:current',
  'test:provider:fallback',
  'test:provider:anthropic',
  'test:provider:openai',
  'test:provider:google',
  'test:provider:proxy',
  'test:providers',
  'verify:package',
  'smoke:readonly',
  'verify:clean',
];

describe('bound release scripts', () => {
  it('declares every bound release script name and 0.9.0 metadata', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
      version: string;
      peerDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    const lock = JSON.parse(await readFile('package-lock.json', 'utf8')) as {
      version: string;
      packages: Record<string, { version?: string }>;
    };
    expect(pkg.version).toBe('0.9.0');
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages['']?.version).toBe(pkg.version);
    expect(pkg.peerDependencies['@earendil-works/pi-coding-agent']).toBe('>=0.80.7');
    expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining(required));
    for (const name of required) expect(pkg.scripts[name]?.length).toBeGreaterThan(0);
  });
});
