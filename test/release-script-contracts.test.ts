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
  it('declares every section 10.7 script name and 0.7.0 metadata', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8')) as {
      version: string;
      peerDependencies: Record<string, string>;
      scripts: Record<string, string>;
    };
    expect(pkg.version).toBe('0.7.0');
    expect(pkg.peerDependencies['@earendil-works/pi-coding-agent']).toBe('>=0.80.7');
    expect(Object.keys(pkg.scripts)).toEqual(expect.arrayContaining(required));
    for (const name of required) expect(pkg.scripts[name]?.length).toBeGreaterThan(0);
  });
});
