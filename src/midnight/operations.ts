/** One-shot authorization bound to the current account, network and form revision. */
export type OperationContext = Readonly<{ accountId: string; network: string; prover: string }>;
export type Review = Readonly<{ action: string; context: OperationContext; inputs: string; disclosure: string }>;
export const display = (value: unknown): string => JSON.stringify(value, (_, item) => typeof item === 'bigint' ? item.toString() : item, 2) ?? 'Not observed';

export type PrepareOptions = Readonly<{
  /** Once invoked, the operation cannot be withdrawn (for example a broadcast), so invalidation is refused until it settles. */
  irrevocable?: boolean;
}>;

export class OperationGate {
  private revision = 0;
  private pending?: { revision: number; review: Review; irrevocable: boolean; invoke: (assertCurrent: () => void) => Promise<unknown> };
  private running = false;
  private locked = false;
  get busy() { return this.running; }
  /** True while an irrevocable operation runs; its result must be reported, never discarded. */
  get irrevocable() { return this.locked; }
  get review() { return this.pending?.review; }
  get version() { return this.revision; }
  /** Discards the pending review and any late result. Returns false, changing nothing, while an irrevocable operation runs. */
  invalidate(): boolean {
    if (this.locked) return false;
    this.revision++; this.pending = undefined;
    return true;
  }
  assertVersion(version: number) {
    if (version !== this.revision) throw new Error('Operation cancelled or inputs changed. Prepare again.');
  }
  prepare(action: string, context: OperationContext, inputs: unknown, invoke: (assertCurrent: () => void) => Promise<unknown>, options: PrepareOptions = {}): Review {
    if (this.running) throw new Error('Wait for the current operation to settle.');
    this.invalidate();
    const review = Object.freeze({ action, context: Object.freeze({ ...context }), inputs: display(inputs),
      disclosure: 'Signing authorizes these exact inputs. Submission broadcasts to the selected network. Proving discloses transaction or circuit material to the configured prover; TEE requires successful attestation. A timeout may leave an uncertain outcome.' });
    this.pending = { revision: this.revision, review, irrevocable: options.irrevocable === true, invoke };
    return review;
  }
  async confirm(review: Review): Promise<unknown> {
    const pending = this.pending;
    if (!pending || pending.review !== review || this.running) throw new Error('No current confirmation. Prepare again.');
    this.assertVersion(pending.revision);
    this.pending = undefined; // consume before entering any asynchronous SDK code
    this.running = true;
    this.locked = pending.irrevocable;
    const assertCurrent = () => this.assertVersion(pending.revision);
    try {
      assertCurrent();
      const result = await pending.invoke(assertCurrent);
      assertCurrent(); // late results cannot become usable staged transactions
      return result;
    } finally { this.running = false; this.locked = false; }
  }
}

/**
 * Public outcome of one approved submission, keyed by the proved transaction's
 * activity hash. History is the authority for confirmation: a history row with
 * that hash settles the record whatever the SDK call later returns.
 */
export type SubmissionRecord = Readonly<{
  stage: 'idle' | 'submitting' | 'submitted' | 'uncertain' | 'failed' | 'confirmed' | 'failed-on-chain';
  summary: string;
  accountId?: string;
  activityHash?: string;
  txId?: string;
  historyType?: string;
  sdk?: 'pending' | 'returned' | 'error';
  error?: string;
}>;
type HistoryRow = Readonly<{ activityId?: unknown; type?: unknown }>;

/** Stages whose outcome is not yet known from history or a pre-broadcast failure. */
export const UNRESOLVED_STAGES: readonly SubmissionRecord['stage'][] = ['submitting', 'submitted', 'uncertain'];
/**
 * SDK error codes raised before any transaction is sent: while resolving the account's engine,
 * or when refusing a transaction built before that engine restarted or was reset.
 */
export const PRE_BROADCAST_ERROR_CODES: readonly string[] = ['midnight-account-not-found', 'midnight-network-not-configured', 'midnight-wallet-not-ready', 'midnight-stale-tx'];
const isPreBroadcast = (error: unknown) =>
  !!error && typeof error === 'object' && PRE_BROADCAST_ERROR_CODES.includes(String((error as { code?: unknown }).code));
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error)).split('\n')[0]!.slice(0, 300);
const IDLE: SubmissionRecord = Object.freeze({ stage: 'idle', summary: 'No submission attempted.' });

const historySummary = (stage: 'confirmed' | 'failed-on-chain', activityHash: string, historyType: string | undefined, txId?: string) => {
  const identifier = txId ? ` (txId ${txId})` : '';
  return stage === 'confirmed' ? `Confirmed: history lists transaction ${activityHash}${identifier}${historyType ? ` as ${historyType}` : ''}.`
    : `History reports transaction ${activityHash}${identifier} as Failed.`;
};

/**
 * Receives each changed record and the whole list. `announce` is true only for the newest
 * record or one whose SDK call is in flight; an older record resolved from background
 * history is listed but must not take over a status line about another operation.
 */
export type SubmissionListener = (changed: SubmissionRecord, all: readonly SubmissionRecord[], announce: boolean) => void;

/**
 * Every submission of the session, newest first. A later submission never replaces an
 * earlier one, so an uncertain hash stays visible until history resolves it.
 */
export class SubmissionTracker {
  private entries: SubmissionRecord[] = [];
  private history = new Map<string, readonly HistoryRow[]>();
  private readonly onChange: SubmissionListener;
  constructor(onChange: SubmissionListener = () => {}) { this.onChange = onChange; }
  /** The newest submission, or an idle record. */
  get state(): SubmissionRecord { return this.entries[0] ?? IDLE; }
  get records(): readonly SubmissionRecord[] { return this.entries; }
  get unresolved(): readonly SubmissionRecord[] { return this.entries.filter(entry => UNRESOLVED_STAGES.includes(entry.stage)); }
  /** Accounts whose history can still resolve a record; watch them even when not selected. */
  get watchedAccounts(): readonly string[] { return [...new Set(this.reconcilable().map(entry => entry.accountId!))]; }
  /** Finds the record of a submitted hash. */
  find(activityHash: string): SubmissionRecord | undefined { return this.entries.find(entry => entry.activityHash === activityHash); }

  /** Records a submission that may broadcast from this point on. */
  begin(accountId: string, activityHash: string) {
    this.put({ stage: 'submitting', accountId, activityHash, sdk: 'pending',
      summary: `Submitting (may broadcast from now on), hash ${activityHash}. Awaiting the SDK's finality result; history is watched for this hash.` });
    this.reconcile(activityHash);
  }
  /** Records a failure before anything was sent. */
  failBeforeBroadcast(accountId: string, error: unknown, activityHash?: string) {
    this.put({ stage: 'failed', accountId, ...(activityHash ? { activityHash } : {}), sdk: 'error', error: errorText(error),
      summary: `Submission failed before broadcast: ${errorText(error)}. Nothing was sent; prepare again.` });
  }
  /** Records the SDK's settled result for that hash; ignored unless its call is still pending. */
  settle(activityHash: string, outcome: { txId: string } | { error: unknown }) {
    const current = this.find(activityHash);
    if (!current || current.sdk !== 'pending') return;
    if ('txId' in outcome) {
      this.put(current.stage === 'confirmed' || current.stage === 'failed-on-chain'
        ? { ...current, txId: outcome.txId, sdk: 'returned', summary: historySummary(current.stage, activityHash, current.historyType, outcome.txId) }
        : { ...current, stage: 'submitted', txId: outcome.txId, sdk: 'returned',
          summary: `Submitted: the SDK returned txId ${outcome.txId}. Awaiting history confirmation of hash ${activityHash}.` });
    } else if (current.stage === 'confirmed' || current.stage === 'failed-on-chain') {
      this.put({ ...current, sdk: 'error', error: errorText(outcome.error) });
    } else if (isPreBroadcast(outcome.error)) {
      this.failBeforeBroadcast(current.accountId!, outcome.error, activityHash);
    } else {
      this.put({ ...current, stage: 'uncertain', sdk: 'error', error: errorText(outcome.error),
        summary: `Submission uncertain: check history/chain for hash ${activityHash} before retrying. The SDK reported: ${errorText(outcome.error)}.` });
    }
    this.reconcile(activityHash);
  }
  /** Feeds the latest history rows of an account; a row with a submitted hash settles its record. */
  observeHistory(accountId: string, rows: readonly HistoryRow[]) {
    this.history.set(accountId, rows);
    for (const entry of this.reconcilable()) if (entry.accountId === accountId) this.reconcile(entry.activityHash!);
  }

  /**
   * Records history can still settle: unresolved ones, and failures that carry a hash. History
   * overrides a failure classified as pre-broadcast, so a misclassified error cannot keep
   * claiming that nothing was sent.
   */
  private reconcilable() {
    return this.entries.filter(entry => !!entry.activityHash && !!entry.accountId && (UNRESOLVED_STAGES.includes(entry.stage) || entry.stage === 'failed'));
  }
  private reconcile(activityHash: string) {
    const current = this.find(activityHash);
    if (!current || !this.reconcilable().includes(current)) return;
    const row = this.history.get(current.accountId!)?.find(item => item.activityId === activityHash);
    if (!row || row.type === 'Pending') return;
    const historyType = typeof row.type === 'string' && row.type ? row.type : undefined;
    const stage = historyType === 'Failed' ? 'failed-on-chain' : 'confirmed';
    const { historyType: _previous, ...rest } = current;
    this.put({ ...rest, stage, ...(historyType ? { historyType } : {}), summary: historySummary(stage, activityHash, historyType, current.txId) });
  }
  /** Replaces the record of the same hash in place, or adds a new record first. */
  private put(record: SubmissionRecord) {
    const frozen = Object.freeze({ ...record });
    const index = frozen.activityHash ? this.entries.findIndex(entry => entry.activityHash === frozen.activityHash) : -1;
    if (index >= 0) this.entries[index] = frozen; else this.entries.unshift(frozen);
    this.onChange(frozen, this.entries, this.entries[0] === frozen || frozen.sdk === 'pending');
  }
}

/**
 * Runs one approved submission and reports it through the tracker. The activity hash, the
 * proved transaction's `activityHash` field, is recorded before the SDK call; errors after
 * that point are reported as uncertain unless the SDK identifies them as raised before
 * broadcast. A value without the field, such as an unproved recipe, is never submitted.
 * Never throws.
 */
export async function submitTracked(
  tracker: SubmissionTracker,
  accountId: string,
  transaction: { readonly activityHash?: unknown },
  submit: () => Promise<{ txId: string }>,
): Promise<SubmissionRecord> {
  const activityHash = transaction.activityHash;
  if (typeof activityHash !== 'string' || !activityHash) {
    tracker.failBeforeBroadcast(accountId, new Error('The transaction has no activity hash; prove it before submitting.'));
    return tracker.state;
  }
  tracker.begin(accountId, activityHash);
  try { tracker.settle(activityHash, { txId: (await submit()).txId }); }
  catch (error) { tracker.settle(activityHash, { error }); }
  return tracker.find(activityHash)!;
}

export function positiveAmount(value: unknown): bigint {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error('Amounts must be positive integer strings in smallest units.');
  return BigInt(value);
}
type TransferOutput = { to: string; tokenId: string; amount: bigint };
export function parseOutputs(text: string): [TransferOutput, ...TransferOutput[]] {
  const value: unknown = JSON.parse(text);
  if (!Array.isArray(value) || !value.length) throw new Error('Enter at least one output.');
  const outputs = value.map(item => {
    if (!item || typeof item.to !== 'string' || !item.to.trim() || typeof item.tokenId !== 'string' || !item.tokenId.trim()) throw new Error('Each output needs a recipient and token ID.');
    return { to: item.to.trim(), tokenId: item.tokenId.trim(), amount: positiveAmount(item.amount) };
  });
  // The nonempty input check above guarantees the first validated output.
  return [outputs[0]!, ...outputs.slice(1)];
}
export function parseHex(value: string): Uint8Array {
  if (!/^(?:[0-9a-fA-F]{2})*$/.test(value)) throw new Error('Expected even-length hexadecimal bytes.');
  return Uint8Array.from(value.match(/../g) ?? [], byte => parseInt(byte, 16));
}
