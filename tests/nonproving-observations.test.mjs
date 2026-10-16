import test from 'node:test';
import assert from 'node:assert/strict';
import { addressFromKey, signData, signatureVerifyingKey, verifySignature } from '@midnight-ntwrk/ledger-v8';
import { UnshieldedAddress } from '@midnightntwrk/wallet-sdk-address-format';
import { MESSAGE, allowsNonprovingRequest, dustObservation, signatureChecks } from './live/nonproving-observations.ts';

const addressFor = (verifyingKey, network = 'preview') => UnshieldedAddress.codec.encode(network,
  new UnshieldedAddress(Buffer.from(addressFromKey(verifyingKey), 'hex'))).asString();

test('non-proving network guard refuses prover/relay and unrelated destinations before send', () => {
  const origin = 'http://localhost:5198';
  for (const url of ['http://localhost:5198/temenos-relay/tee_attestation/proxy', 'http://127.0.0.1:6300/prove', 'https://attestation.proofserver.wastedp.io/attestation.json', 'https://api.proofserver.wastedp.io/prove', 'wss://api.proofserver.wastedp.io/prove', 'ws://localhost:5198/temenos-relay/prove', 'https://warden.wastedp.io/dapps/verify_attestation', 'https://indexer.preview.midnight.network.evil/api', 'http://rpc.preview.midnight.network', 'invalid']) assert.equal(allowsNonprovingRequest(url, origin), false);
  for (const url of [`${origin}/midnight`, `${origin}/src/midnight/app.ts`, 'ws://localhost:5198/', 'https://indexer.preview.midnight.network/api/v4/graphql', 'wss://indexer.preview.midnight.network/api/v4/graphql/ws', 'https://rpc.preview.midnight.network']) assert.equal(allowsNonprovingRequest(url, origin), true);
});

test('public DUST observations distinguish absent state, real zero and optional time fields', () => {
  const generation = { currentValue: '0', maxCap: '10', rate: '1' };
  assert.equal(dustObservation(null).balancePresent, false);
  const zero = dustObservation({ generated: '0', spendable: '0', generation });
  assert.equal(zero.balancePresent, true); assert.equal(zero.positive, false); assert.equal(zero.generationPresent, true);
  assert.equal(zero.decayTimePresent, false); assert.equal(zero.maxCapReachedAtPresent, false);
  assert.equal(dustObservation({ generated: '1', spendable: '1', generation: { ...generation, decayTime: 123, maxCapReachedAt: 456 } }).positive, true);
  assert.equal(dustObservation({ generated: '1', spendable: '1', generation: { ...generation, currentValue: '11' } }).generationPresent, false);
  assert.equal(dustObservation({ generated: '1', spendable: '1', generation: { ...generation, decayTime: '123' } }).generationPresent, false);
});

test('installed ledger verifier accepts actual UTF-8 domain signature and rejects raw/altered data', () => {
  // Synthetic fixed ledger key; no mnemonic, wallet restore, network or transaction.
  const key = '01'.repeat(32), verifyingKey = signatureVerifyingKey(key);
  const bytes = Buffer.from(MESSAGE, 'utf8');
  assert.notEqual(bytes.length, MESSAGE.length);
  const message = Buffer.concat([Buffer.from(`midnight_signed_message:${bytes.length}:`), bytes]);
  const signature = signData(key, message);
  const address = addressFor(verifyingKey);
  assert.deepEqual(signatureChecks(signature, verifyingKey, verifySignature, address), { valid: true, rawRejected: true, alteredRejected: true });
  const wrongLength = Buffer.concat([Buffer.from(`midnight_signed_message:${MESSAGE.length}:`), bytes]);
  assert.equal(signatureChecks(signData(key, wrongLength), verifyingKey, verifySignature, address).valid, false);
  const otherKey = signatureVerifyingKey('02'.repeat(32));
  assert.equal(signatureChecks(signature, otherKey, verifySignature, address).valid, false);
});

test('another account\'s valid domain signature cannot pass for the restored Preview address', () => {
  const restoredKey = signatureVerifyingKey('01'.repeat(32));
  const otherSigningKey = '02'.repeat(32), otherKey = signatureVerifyingKey(otherSigningKey);
  const bytes = Buffer.from(MESSAGE, 'utf8');
  const message = Buffer.concat([Buffer.from(`midnight_signed_message:${bytes.length}:`), bytes]);
  const signature = signData(otherSigningKey, message);
  assert.equal(verifySignature(otherKey, message, signature), true);
  assert.notEqual(addressFor(restoredKey), addressFor(otherKey));
  assert.deepEqual(signatureChecks(signature, otherKey, verifySignature, addressFor(restoredKey)),
    { valid: false, rawRejected: true, alteredRejected: true });
  assert.equal(signatureChecks(signature, otherKey, verifySignature, addressFor(otherKey)).valid, true);
});
