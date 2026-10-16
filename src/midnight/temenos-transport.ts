// Transport allowlist for verifier 0.3.0 and the SDK's Preview deployment.
// The shared attestation ledger remains on Preprod. No trust configuration.
export const TEMENOS_RELAY_PATH = '/temenos-relay';
export const TEMENOS_UPSTREAM = 'https://attestation.proofserver.preview.wastedp.io';
export const TEMENOS_RELAY_HEADER = 'x-lace-temenos-relay';
export const TEMENOS_TIMEOUT_MS = 30_000;
export const TEMENOS_MAX_IN_FLIGHT = 4;
export const TEMENOS_LEDGER_QUERY = 'query ContractState($address: String!) { contractAction(address: $address) { state } }';

const AKX_ROUTES = [
  { path: '/attestation.json', method: 'GET', limit: 1024 * 1024 },
  { path: '/tee_attestation/enclave-key', method: 'GET', limit: 1024 * 1024 },
  { path: '/tee_attestation/session', method: 'POST', limit: 4096 },
  { path: '/tee_attestation/session/complete', method: 'POST', limit: 4096 },
  { path: '/tee_attestation/proxy', method: 'POST', limit: 16 * 1024 * 1024 },
].map(route => Object.freeze({ ...route, kind: 'akx', source: `${TEMENOS_UPSTREAM}${route.path}`, target: `${TEMENOS_UPSTREAM}${route.path}` }));
export const TEMENOS_ROUTES = Object.freeze([
  ...AKX_ROUTES,
  Object.freeze({ path: '/ledger/contract-state', method: 'POST', limit: 4 * 1024 * 1024, kind: 'ledger',
    source: 'https://indexer.preprod.midnight.network/api/v4/graphql', target: 'https://midnight-preprod.blockfrost.io/api/v0' }),
  Object.freeze({ path: '/warden/verify-attestation', method: 'POST', limit: 1024 * 1024, kind: 'warden',
    source: 'https://warden.wastedp.io/dapps/verify_attestation', target: 'https://warden.wastedp.io/dapps/verify_attestation' }),
]);

export function temenosRoute(path: string, method: string) {
  return TEMENOS_ROUTES.find(route => route.path === path && route.method === method);
}
