// Every wallet operation/state read stays on the packaged public Midnight entry.
import * as sdk from '@laceio/sdk/midnight';
import { BASELINE_FLAGS, TEMENOS_URL, validateConfig, type SessionConfig } from './config';
import { createConsumerTemenosProver } from './temenos-provider';

export async function restore(words: string[], password: Uint8Array, requested: SessionConfig) {
  const config = validateConfig(requested);
  const featureFlags = [
    ...BASELINE_FLAGS.map(key => ({ key: key as typeof sdk.FEATURE_FLAG_MIDNIGHT })),
    { key: sdk.FEATURE_FLAG_NETWORK_TYPE, payload: config.network === 'mainnet' ? 'mainnet' : 'testnet' },
  ];
  const overrides: sdk.MidnightNetworkConfigOverrides = {
    [config.network]: {
      ...(config.nodeAddress ? { nodeAddress: config.nodeAddress, indexerAddress: config.indexerAddress } : {}),
      ...(config.prover === 'temenos' ? { proofServer: { kind: 'tee-delegated', url: TEMENOS_URL, label: 'Temenos' } } : {}),
    },
  };
  const wallet = await sdk.createLaceWallet({
    modules: [sdk.m.featureDev, sdk.m.storageInMemory, sdk.createMidnightModule({
      password, proofServerUrl: 'http://127.0.0.1:6300', networks: overrides,
      ...(config.prover === 'temenos' ? {
        createAttestedProver: createConsumerTemenosProver,
      } : {}),
    })] as const,
    environment: 'development', featureFlags,
    config: { defaultFeatureFlags: featureFlags, extraFeatureFlags: [], defaultMidnightTestnetNetworkId: config.network === 'mainnet' ? 'preview' : config.network },
  });
  sdk.selectMidnightNetwork(wallet, config.network);
  let entity = await sdk.createInMemoryWalletEntity(wallet, { mnemonicWords: words, password, walletName: 'Midnight developer session' });
  if (config.index !== 0) entity = await sdk.createMidnightAccounts(wallet, {
    wallet: entity, password, accountIndex: config.index, accountName: `Index ${config.index}`,
  });
  wallet.dispatch('wallets.addWallet', entity);
  return { wallet, entity, sdk, config };
}
export type Session = Awaited<ReturnType<typeof restore>>;
export type Recipe = sdk.MidnightTxRecipe;
export type Transaction = sdk.MidnightFinalizedTx;
export type Batch = sdk.MidnightTransferBatch;
export type CircuitKeys = sdk.KeyMaterialProvider;
export function stopSession(session: Session) {
  session.wallet.dispatch('wallets.removeWallet', session.entity.walletId, session.entity.accounts.map(a => a.accountId));
}

export type Account = sdk.MidnightAccountId;
