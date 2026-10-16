import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transformWithOxc } from 'vite';
import viteConfig from '../vite.config.ts';
import { probeAddresses } from './e2e/address-probe.ts';

const browserAssert = createRequire(import.meta.url)('assert/');

test('browser util initializes without process using the exact Node debug definition', async () => {
  const require = createRequire(import.meta.url);
  const filename = require.resolve('util/');
  const source = await readFile(filename, 'utf8');
  const load = code => {
    const exports = {};
    // No process/global environment; dependencies resolve from util's location.
    runInNewContext(code, { exports, require: createRequire(filename) });
    return exports;
  };
  assert.throws(() => load(source), /process is not defined/);
  // Calling the config factory registers plugins, but does not run their hooks
  // or read any .env files. Use Vite's actual transform with its definitions.
  const config = viteConfig({ command: 'serve', mode: 'development' });
  const transformed = await transformWithOxc(source, filename, { define: config.define });
  const util = load(transformed.code);
  assert.equal(util.format('%s:%d', 'public', 64), 'public:64');
});

test('installed address codecs round-trip public dummy values and reject invalid inputs', async () => {
  // Browser execution of these same vectors is required in runtime.spec.ts:
  // Node's built-in assert alone cannot prove the Vite browser resolution.
  assert.deepEqual(await probeAddresses(), {
    dust: [true, true, true, true, true, true, true, true, true], dust64ScaleHex: '0101',
    shielded: true, unshielded: true, negativeDustRejected: true,
    shieldedTextLength: 132, shieldedStringRoundtrip: true,
    invalidShieldedChecksumRejected: true, invalidShieldedPayloadRejected: true,
    wrongShieldedNetworkRejected: true, wrongShieldedTypeRejected: true,
    oversizedDustRejected: true, invalidUnshieldedRejected: true,
    wrongNetworkRejected: true, invalidDustPayloadRejected: true,
  });
});

test('installed browser assert preserves assertion failure semantics', () => {
  browserAssert(true, 'valid compact');
  assert.throws(() => browserAssert(false, 'invalid compact'), {
    name: 'AssertionError', code: 'ERR_ASSERTION', message: 'invalid compact',
  });
});
