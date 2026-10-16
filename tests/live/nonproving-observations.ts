// Public, bounded observations only. No wallet, raw errors or signature material in reports.
import { addressFromKey } from '@midnight-ntwrk/ledger-v8';
import { MidnightBech32m, UnshieldedAddress } from '@midnightntwrk/wallet-sdk-address-format';
export const CHECKS = ['restore', 'cancel-message', 'sign-text', 'sign-hex', 'sign-base64', 'dust', 'registration-details', 'unsigned-estimate', 'native-rename', 'resync'] as const;
export type Check = typeof CHECKS[number];
export type Outcome = 'not-run' | 'pass' | 'failed' | 'timeout' | 'prerequisite-missing';
export const REGISTRATION_HASH = '117b143a62747c225a081f280537acc99d4a78283f6df4b40472d729876988d0';
export const MESSAGE = 'LW-15713 disposable test: café 🌙';

export function nonprovingBlockedURLs(appOrigin: string): RegExp {
  const app = new URL(appOrigin);
  if (!['http:', 'https:'].includes(app.protocol) || app.origin !== appOrigin || app.username || app.password) throw new Error('Invalid non-proving app origin.');
  const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const appHTTP = escape(app.origin), appWS = escape(app.origin.replace(/^http/, 'ws'));
  // A serializable negative RegExp leaves approved streams in browser passthrough.
  // A function predicate would make Playwright intercept every socket instead.
  const allowed = `(?:(?:${appHTTP}|${appWS})/(?!temenos-relay)(?![^?#]*%)[^#]*|(?:https|wss)://(?:rpc|indexer)\\.preview\\.midnight\\.network/[^#]*)`;
  return new RegExp(`^(?!${allowed}$)`);
}

export function allowsNonprovingRequest(url: string, appOrigin: string): boolean {
  try { return !nonprovingBlockedURLs(appOrigin).test(new URL(url).href); }
  catch { return false; }
}

const unsigned = (v: unknown): v is string => typeof v === 'string' && /^[0-9]+$/.test(v);
export function dustObservation(value: unknown) {
  const v = value as { generated?: unknown; spendable?: unknown; generation?: Record<string, unknown> } | null;
  const g = v?.generation;
  const optionalTime = (key: string) => g?.[key] === undefined || (typeof g[key] === 'number' && Number.isFinite(g[key]));
  return {
    balancePresent: unsigned(v?.generated) && unsigned(v?.spendable),
    positive: unsigned(v?.generated) && unsigned(v?.spendable) && BigInt(v.generated) > 0n && BigInt(v.spendable) > 0n,
    generationPresent: !!g && unsigned(g.currentValue) && unsigned(g.maxCap) && unsigned(g.rate) && BigInt(g.currentValue) <= BigInt(g.maxCap) && optionalTime('decayTime') && optionalTime('maxCapReachedAt'),
    decayTimePresent: g?.decayTime !== undefined,
    maxCapReachedAtPresent: g?.maxCapReachedAt !== undefined,
  };
}

export function signatureChecks(signature: string, verifyingKey: string, verify: (key: string, bytes: Uint8Array, sig: string) => boolean, restoredAddress: string) {
  const expectedAddress = UnshieldedAddress.codec.decode('preview', MidnightBech32m.parse(restoredAddress));
  const keyMatchesWallet = addressFromKey(verifyingKey) === expectedAddress.hexString;
  const bytes = new TextEncoder().encode(MESSAGE);
  const prefix = new TextEncoder().encode(`midnight_signed_message:${bytes.length}:`);
  const separated = new Uint8Array(prefix.length + bytes.length);
  separated.set(prefix); separated.set(bytes, prefix.length);
  const altered = separated.slice(); altered[altered.length - 1] ^= 1;
  return {
    valid: keyMatchesWallet && verify(verifyingKey, separated, signature),
    rawRejected: !verify(verifyingKey, bytes, signature),
    alteredRejected: !verify(verifyingKey, altered, signature),
  };
}
