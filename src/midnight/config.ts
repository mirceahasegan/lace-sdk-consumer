export const BASELINE = '1374e7f1a0d3bc624830c669c2a1009a88e06acb';
export const NETWORKS = ['preview', 'preprod', 'mainnet', 'qanet', 'undeployed', 'devnet', 'testnet'] as const;
export type Network = typeof NETWORKS[number];
export const PREVIEW_ENDPOINTS = {
  nodeAddress: 'https://rpc.preview.midnight.network',
  indexerAddress: 'https://indexer.preview.midnight.network/api/v4/graphql',
};
export const TEMENOS_URL = 'https://api.proofserver.preview.wastedp.io';
// Features are fixed locally; remote flag configuration is not applied.
export const BASELINE_FLAGS = [
  'BLOCKCHAIN_MIDNIGHT', 'BLOCKCHAIN_MIDNIGHT_DAPP_CONNECTOR',
  'BLOCKCHAIN_MIDNIGHT_MAINNET_SUPPORT', 'BLOCKCHAIN_MIDNIGHT_PREPROD_SUPPORT',
  'BLOCKCHAIN_MIDNIGHT_PREVIEW_SUPPORT', 'BLOCKCHAIN_MIDNIGHT_REMOTE_PROOF_SERVER',
  'BLOCKCHAIN_MIDNIGHT_TEE_TEMENOS_PROOF_SERVER', 'BLOCKCHAIN_MIDNIGHT_UNSHIELDED',
] as const;
export type SessionConfig = { network: Network; index: number; nodeAddress: string; indexerAddress: string; prover: 'local' | 'temenos' };
export function validateConfig(config: SessionConfig): SessionConfig {
  if (!NETWORKS.includes(config.network)) throw new Error('Unsupported network.');
  if (!Number.isInteger(config.index) || config.index < 0 || config.index >= 2 ** 31) throw new Error('Account index must be an integer between 0 and 2147483647.');
  const custom = ['undeployed', 'devnet', 'testnet'].includes(config.network);
  if ((custom || config.nodeAddress || config.indexerAddress) && (!config.nodeAddress || !config.indexerAddress)) throw new Error('Provide both node and indexer endpoints.');
  for (const endpoint of [config.nodeAddress, config.indexerAddress].filter(Boolean)) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.hash || !(['https:', 'wss:'].includes(url.protocol) || (['http:', 'ws:'].includes(url.protocol) && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new Error('Endpoints require HTTPS/WSS, or HTTP/WS on loopback, without credentials or fragments.');
  }
  if (config.prover !== 'local' && config.prover !== 'temenos') throw new Error('Unsupported prover.');
  if (config.prover === 'temenos' && config.network !== 'preview') throw new Error('This pinned Temenos deployment is configured for Preview only.');
  return { ...config };
}
export function proverDisclosure(config: SessionConfig): string {
  return config.prover === 'temenos' ? `Temenos attested proving (${TEMENOS_URL}); no fallback` : 'Local proof server http://127.0.0.1:6300; receives transaction and circuit material';
}
