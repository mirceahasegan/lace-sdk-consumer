/** The networks a live run can target: Preview, or the local chain of lace-platform's `compose/midnight.yml`. */
export type LiveNetwork = 'preview' | 'undeployed';
/** The local chain's node and indexer, as lace-platform's `compose/midnight.yml` publishes them. */
export const LOCAL_CHAIN_ENDPOINTS = { nodeAddress: 'http://localhost:9944', indexerAddress: 'http://localhost:8088/api/v4/graphql' } as const;
/** `MIDNIGHT_LIVE`: `preview` or `undeployed` (the local chain); anything else disables the live suites. */
export function liveNetwork(value: string | undefined): LiveNetwork | undefined {
  return value === 'preview' || value === 'undeployed' ? value : undefined;
}
/** The endpoints a live run enters as custom endpoints: none for Preview's public ones. */
export function liveEndpoints(network: LiveNetwork): { nodeAddress: string; indexerAddress: string } | undefined {
  return network === 'undeployed' ? { ...LOCAL_CHAIN_ENDPOINTS } : undefined;
}

export type TestWallet = { mnemonicWords: string[]; password: string; accountIndex: number; network: LiveNetwork; address: string };

// Deliberately generic errors: never serialize the caller's secret-bearing input.
export function parseTestWallet(value: unknown, network: LiveNetwork = 'preview'): TestWallet {
  const v = value as Partial<TestWallet> & { passwordHex?: unknown };
  if (!v || v.network !== network || typeof v.address !== 'string' || !v.address.startsWith(`mn_addr_${network}`)) throw new Error(`A ${network} wallet with its expected public unshielded address is required.`);
  const password = v.passwordHex ?? v.password;
  if (typeof password !== 'string' || !password || !Array.isArray(v.mnemonicWords) || v.mnemonicWords.length < 12 || !v.mnemonicWords.every(w => typeof w === 'string' && !!w.trim())) throw new Error('Disposable wallet requires mnemonicWords and a nonempty session password or passwordHex.');
  const accountIndex = v.accountIndex ?? 0;
  if (!Number.isInteger(accountIndex) || accountIndex < 0 || accountIndex >= 2 ** 31) throw new Error('Invalid test account index.');
  return { mnemonicWords: [...v.mnemonicWords], password, accountIndex, network, address: v.address };
}

export type PublicBalances = { address: { unshielded: string }; night: { available: string }; dust: { available: string }; synced: { unshielded: boolean; dust: boolean }; nightTokenId: string };
export function canSpend(state: PublicBalances, address: string, needsDust: boolean): boolean {
  try {
    return state.address.unshielded === address && state.synced.unshielded && state.synced.dust &&
      BigInt(state.night.available) >= 1n && (!needsDust || BigInt(state.dust.available) > 0n);
  } catch { return false; }
}

// A manual bounded wait deliberately propagates terminal failures immediately;
// assertion polling can otherwise turn a startup error into an address timeout.
export async function withinPublicDeadline<T>(work: () => Promise<T>, timeout: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const expired = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(message)), Math.max(0, timeout)); });
  try { return await Promise.race([Promise.resolve().then(work), expired]); }
  finally { clearTimeout(timer!); }
}

export async function waitForPublicReady(
  read: () => Promise<{ stage: unknown; ready: boolean; progress?: { fraction?: number; completed?: number } }>,
  timeout: number,
  message: string,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 250)),
  onProgress?: () => void,
): Promise<void> {
  let deadline = Date.now() + timeout;
  let fraction = -1, completed = 0, startup = -1;
  // High-water marks belong to this wait. A restart/oscillation alone is not
  // progress; another explicit restore/resync wait starts fresh marks.
  while (Date.now() < deadline) {
      const { stage, ready, progress } = await withinPublicDeadline(read, deadline - Date.now(), message);
      if (stage === 'sync-failed') throw new Error('Midnight account synchronization failed after startup retries; no signing authorized.');
      if (stage === 'balance-stream-failed') throw new Error('Midnight public balance stream failed; engine readiness not established.');
      if (stage === 'restore-failed') throw new Error('Midnight restore failed; secret-bearing library errors are withheld.');
      if (Date.now() >= deadline) break;
      if (ready) return;
      const rank = ['idle', 'restore-started', 'waiting-for-engine', 'state-observed', 'synchronized'].indexOf(String(stage));
      const nextFraction = progress?.fraction;
      const nextCompleted = progress?.completed;
      let advanced = rank > startup;
      startup = Math.max(startup, rank);
      if (typeof nextFraction === 'number' && Number.isFinite(nextFraction) && nextFraction >= 0 && nextFraction <= 1 && nextFraction > fraction) {
        fraction = nextFraction; advanced = true;
      }
      if (typeof nextCompleted === 'number' && Number.isInteger(nextCompleted) && nextCompleted >= 0 && nextCompleted <= 7 && (nextCompleted | completed) !== completed) {
        completed |= nextCompleted; advanced = true;
      }
      // Progress-aware waits are explicit; other callers retain their original
      // fixed deadline, including the separate non-proving suite.
      if (advanced && onProgress) { deadline = Date.now() + timeout; onProgress(); }
      // Each read and pause is bounded, including when the browser stops replying.
      // A late read cannot restart this loop after its race has rejected.
      await withinPublicDeadline(pause, deadline - Date.now(), message);
  }
  throw new Error(message);
}
