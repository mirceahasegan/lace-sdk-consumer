import { Buffer } from 'buffer';
import { probeAddresses } from './address-probe';
(globalThis as Record<string, unknown>).Buffer = Buffer;

async function probe() {
  // No route replacement: load the app's actual lazy runtime, its public SDK
  // and pinned verifier. No wallet entity, secret, signing or network required.
  const runtime = await import('../../src/midnight/runtime');
  const sdk = await import('@laceio/sdk/midnight');
  const verifier = await import('@input-output-hk/temenos-attestation-verifier');
  const ledger = await import('@midnight-ntwrk/ledger-v8');
  // The verifier's compact-runtime re-exports this package's ContractState.
  // npm installs that compact-runtime under the verifier, because the SDK
  // declares a newer one as an optional peer, so load the runtime it wraps.
  const compact = await import('@midnight-ntwrk/onchain-runtime-v3');
  const zkir = await import('@midnight-ntwrk/zkir-v2');
  const module = sdk.createMidnightModule({ password: new Uint8Array() });
  const loaded = await Promise.all([
    module.store.load(),
    module.addons.loadSignerFactory(),
    module.addons.loadInMemoryWalletIntegration(),
  ]);
  // These imports sit inside the packaged restore/key-derivation functions,
  // so importing the store alone does not load them. Exercise the same public
  // package entries without deriving keys or starting a wallet's sync effects.
  const engines = await Promise.all([
    import('@midnightntwrk/wallet-sdk'),
    import('@midnightntwrk/wallet-sdk/hd'),
    import('@midnightntwrk/wallet-sdk/dust'),
    import('@midnightntwrk/wallet-sdk/facade'),
    import('@midnightntwrk/wallet-sdk/shielded'),
    import('@midnightntwrk/wallet-sdk/unshielded'),
  ]);
  const roundtrip = (State: typeof ledger.ContractState) => {
    const bytes = new State().serialize();
    return Buffer.from(State.deserialize(bytes).serialize()).equals(Buffer.from(bytes));
  };
  // Both independent wasm-bindgen runtimes must instantiate and execute.
  const wasm = [roundtrip(ledger.ContractState), roundtrip(compact.ContractState)];
  const addresses = await probeAddresses();
  let fetchCalls = 0;
  const refuseFetch: typeof fetch = async () => { fetchCalls++; throw new Error('No network in runtime probe'); };
  const rejects = async (action: () => unknown, pattern: RegExp) => {
    try { await action(); return false; }
    catch (error) {
      const messages: string[] = [];
      for (let current = error; current instanceof Error; current = current.cause) messages.push(current.message);
      return pattern.test(messages.join(' / '));
    }
  };
  const insecure = new verifier.RawSnpEvidenceProvider({ host: 'invalid.example', insecureTls: true, fetchImpl: refuseFetch });
  const insecureRefused = await rejects(() => insecure.obtainEvidence('00'), /Insecure Node TLS is disabled/);
  const nodeRefused = await rejects(() => new verifier.NodeTlsChannelBinder().bind('https://invalid.example', {
    kind: 'spki-pin', spkiSha256: '00'.repeat(32),
  }), /Node TLS channel binding is disabled/);
  const forbiddenFetchCalls = fetchCalls;
  // The normal provider still reaches its supplied transport. Only the Node
  // branch is removed; this is an intentional rejection, never fake evidence.
  const secure = new verifier.RawSnpEvidenceProvider({ host: 'invalid.example', fetchImpl: refuseFetch });
  const secureTransport = await rejects(() => secure.obtainEvidence('00'), /No network in runtime probe/);
  const secureFetchCalls = fetchCalls;
  const akx = new verifier.AkxEvidenceProvider({ akxServerUrl: 'https://invalid.example', attestationHost: 'invalid.example', fetchImpl: refuseFetch });
  const akxTransport = await rejects(() => akx.obtainEvidence('00'), /No network in runtime probe/);
  const httpRefused = await rejects(() => new verifier.AkxChannelBinder({ akxServerUrl: 'http://invalid.example' }), /https/i);
  const nonce = await verifier.verifyNonceFreshness(new TextEncoder().encode('{}'), '00');
  return {
    runtime: typeof runtime.restore,
    lazyModules: loaded.map(value => typeof value.default),
    engines: engines.map(value => Object.keys(value).length > 0),
    wasm, addresses, insecureRefused, nodeRefused, forbiddenFetchCalls,
    zkir: [typeof zkir.check, typeof zkir.prove],
    secureTransport, secureFetchCalls, akxTransport, akxFetchCalls: fetchCalls - secureFetchCalls,
    httpRefused, invalidNonceRejected: !nonce.ok,
    roots: verifier.AMD_ROOT_CERTIFICATES.length,
  };
}

document.getElementById('load')!.onclick = async () => {
  const result = document.getElementById('result')!;
  try { result.textContent = JSON.stringify(await probe()); }
  catch (error) { result.textContent = JSON.stringify({ error: String(error) }); }
};
