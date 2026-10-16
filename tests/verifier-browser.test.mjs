import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { verifierBrowserPlugin } from '../verifier-browser.ts';

test('browser Node refusals are limited to the pinned verifier modules and reject drift', async () => {
  const plugin = verifierBrowserPlugin();
  for (const file of ['phases/evidence.js', 'phases/channel/nodeTlsChannelBinder.js']) {
    const path = new URL(`../node_modules/@input-output-hk/temenos-attestation-verifier/dist/${file}`, import.meta.url).pathname;
    const code = await readFile(path, 'utf8');
    const transformed = plugin.transform(code, path).code;
    assert.match(transformed, /disabled in this browser consumer/);
    assert.doesNotMatch(transformed, /import\((?:undiciSpecifier|tlsSpec|httpsSpec|cryptoSpec)\)/);
    assert.equal(plugin.transform(code, path, { ssr: true }), undefined);
    assert.equal(plugin.transform(code, path.replace('temenos-attestation-verifier', 'another-package')), undefined);
    assert.throws(() => plugin.transform(code + '\n', path), /Review browser integration/);
  }
  const evidencePath = new URL('../node_modules/@input-output-hk/temenos-attestation-verifier/dist/phases/evidence.js', import.meta.url).pathname;
  const original = await readFile(evidencePath, 'utf8');
  const transformed = plugin.transform(original, evidencePath).code;
  // The parser shared with AKX remains byte-identical.
  assert.equal(transformed.slice(transformed.indexOf('export function parseRawSnpWireResponse')), original.slice(original.indexOf('export function parseRawSnpWireResponse')));
});
