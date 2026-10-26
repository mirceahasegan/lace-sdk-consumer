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
export const LOCAL_PROOF_SERVER_URL = 'http://127.0.0.1:6300';
/** Where the engine runs: on this page, or in the SDK's SharedWorker (Worker mode). */
export const ENGINES = ['page', 'worker'] as const;
export type Engine = typeof ENGINES[number];
export const WORKER_STORAGE = ['memory', 'indexeddb'] as const;
export type WorkerStorage = typeof WORKER_STORAGE[number];
export type SessionConfig = {
  network: Network; index: number; nodeAddress: string; indexerAddress: string; prover: 'local' | 'temenos';
  /** `page` when absent. */
  engine?: Engine;
  /** Worker mode only: where the worker keeps the synced state; `memory` when absent. */
  workerStorage?: WorkerStorage;
  /** Worker mode only: use the settings of an engine another tab already runs for the account. */
  adopt?: boolean;
};
/** The `worker` option of `createMidnightModule` for this session; undefined runs the engine on the page. */
export function workerOption(config: SessionConfig): { storage: WorkerStorage; adopt: boolean } | undefined {
  return config.engine === 'worker' ? { storage: config.workerStorage ?? 'memory', adopt: config.adopt === true } : undefined;
}
/** A setup the app refuses before restoring; its message holds no wallet input. */
export class ConfigError extends Error { override name = 'ConfigError'; }
export function validateConfig(config: SessionConfig): SessionConfig {
  if (!NETWORKS.includes(config.network)) throw new ConfigError('Unsupported network.');
  if (!Number.isInteger(config.index) || config.index < 0 || config.index >= 2 ** 31) throw new ConfigError('Account index must be an integer between 0 and 2147483647.');
  const custom = ['undeployed', 'devnet', 'testnet'].includes(config.network);
  if ((custom || config.nodeAddress || config.indexerAddress) && (!config.nodeAddress || !config.indexerAddress)) throw new ConfigError('Provide both node and indexer endpoints.');
  for (const endpoint of [config.nodeAddress, config.indexerAddress].filter(Boolean)) {
    const url = new URL(endpoint);
    if (url.username || url.password || url.hash || !(['https:', 'wss:'].includes(url.protocol) || (['http:', 'ws:'].includes(url.protocol) && ['localhost', '127.0.0.1'].includes(url.hostname)))) throw new ConfigError('Endpoints require HTTPS/WSS, or HTTP/WS on loopback, without credentials or fragments.');
  }
  if (config.prover !== 'local' && config.prover !== 'temenos') throw new ConfigError('Unsupported prover.');
  if (config.prover === 'temenos' && config.network !== 'preview') throw new ConfigError('This pinned Temenos deployment is configured for Preview only.');
  const engine = config.engine ?? 'page', workerStorage = config.workerStorage ?? 'memory', adopt = config.adopt ?? false;
  if (!ENGINES.includes(engine)) throw new ConfigError('Unsupported engine location.');
  if (!WORKER_STORAGE.includes(workerStorage) || typeof adopt !== 'boolean') throw new ConfigError('Unsupported Worker mode settings.');
  // The SDK refuses this combination too (MidnightAttestedProverUnsupportedError): an attested prover is page code.
  if (engine === 'worker' && config.prover === 'temenos') throw new ConfigError('Worker mode proves only through a proof server URL. Select the local proof server, or run the engine on this page for Temenos.');
  return { ...config, engine, workerStorage, adopt };
}
export function proverDisclosure(config: SessionConfig): string {
  return config.prover === 'temenos' ? `Temenos attested proving (${TEMENOS_URL}); no fallback` : `Local proof server ${LOCAL_PROOF_SERVER_URL}; receives transaction and circuit material`;
}
export function engineDisclosure(config: SessionConfig): string {
  const worker = workerOption(config);
  return worker ? `Worker mode: the SDK's SharedWorker runs the engine, shared by this app's tabs; ${worker.storage} storage${worker.adopt ? '; adopts the settings of an engine another tab runs' : ''}` : 'This page runs the engine';
}
