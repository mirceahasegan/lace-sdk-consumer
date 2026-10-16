import type { Page, Request, Response } from '@playwright/test';
import { TEMENOS_RELAY_PATH, TEMENOS_ROUTES } from '../../src/midnight/temenos-transport';

// Self-contained for page.evaluate: raw DOM status/detail never leaves the browser.
// The optional input is a synthetic unit-test seam, not a wallet/SDK inspection.
export function readPublicProvingState(input?: { status: unknown; progress: unknown; submitEnabled: boolean } | void) {
  const phases = ['obtain-evidence', 'fetch-expected-values', 'verify-locally', 'warden-verify', 'bind-channel', 'proving'];
  const result = { phase: 'not-observed', phaseStatus: 'not-observed', categories: [] as string[], httpStatuses: [] as number[], submitEnabled: false };
  try {
    const status = input ? input.status : document.getElementById('status')?.textContent;
    const progressText = input ? input.progress : document.getElementById('progress')?.textContent;
    let progress: { type?: unknown; phase?: unknown; status?: unknown; detail?: unknown } = {};
    try { progress = typeof progressText === 'string' ? JSON.parse(progressText) ?? {} : {}; } catch { /* Missing/malformed public progress is not success. */ }
    if (progress.type === 'phase' && phases.includes(progress.phase as string)) {
      result.phase = progress.phase as string;
      if (['started', 'completed', 'failed'].includes(progress.status as string)) result.phaseStatus = progress.status as string;
    }
    const text = [status, progress.detail].filter(value => typeof value === 'string').join('\n');
    // These are observations of known wording, never causal conclusions.
    for (const [category, pattern] of [
      ['wallet-proving', /\bWallet\.Proving\b/],
      ['client-error', /\bClientError\b/],
      ['generic-proving-failure', /\bFailed to prove transaction\b/],
      ['attestation-error', /\b(?:TemenosAttestationError|AttestationVerificationError)\b/],
      ['channel-binding-error', /\bChannelBindingError\b/],
      ['operation-unavailable', /\bProofOperationUnavailableError\b/],
      ['record-authentication-failure', /\b(?:proxy response failed authentication|record authentication failed)\b/],
      ['timeout', /\b(?:TimeoutError|AbortError)\b/],
    ] as const) if (pattern.test(text)) result.categories.push(category);
    for (const match of text.matchAll(/\breturned HTTP ([1-5][0-9]{2})\b/g)) {
      const code = Number(match[1]);
      if (!result.httpStatuses.includes(code) && result.httpStatuses.length < 8) result.httpStatuses.push(code);
    }
    result.submitEnabled = input ? input.submitEnabled === true : (document.getElementById('submit') as HTMLButtonElement | null)?.disabled === false;
  } catch { /* Fixed empty classification; never return the exception. */ }
  return result;
}

export async function waitForProving(
  read: () => Promise<ReturnType<typeof readPublicProvingState>>,
  timeout: number,
  pause: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 250)),
) {
  const deadline = Date.now() + timeout;
  do {
    let state: ReturnType<typeof readPublicProvingState>;
    try { state = await read(); }
    catch { throw new Error('Public proving state unavailable; no submission attempted.'); }
    // A terminal failure wins even if a stale button appears enabled.
    if (state.phaseStatus === 'failed') throw new Error('Proving stopped at a failed public phase; no submission attempted.');
    if (Date.now() >= deadline) break;
    if (state.submitEnabled) return;
    await pause();
  } while (Date.now() < deadline);
  throw new Error('Proving readiness timed out; outcome uncertain, no submission attempted.');
}

type RelayObservation = {
  route: string; status: number | null; outcome: 'response' | 'finished' | 'failed';
  responseStartMs: number | null; responseEndMs: number | null;
  requestBodyBytes: number | null; responseBodyBytes: number | null;
  http400Origin?: 'relay' | 'upstream' | null;
  errorOrigin?: 'relay' | 'upstream' | null;
};
const measured = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER ? value : null;

/** Observe only fixed relay metadata. Never read bodies, arbitrary headers or request.failure(). */
export function observeProvingRelay(page: Page) {
  const origin = new URL(page.url()).origin;
  const rows: RelayObservation[] = [];
  const requests = new WeakMap<Request, RelayObservation>();
  const pending = new Set<Promise<void>>();
  let truncated = false, metadataUnavailable = false;
  const rowFor = (request: Request) => {
    // Full equality intentionally rejects queries, credentials and extra path segments.
    const route = TEMENOS_ROUTES.find(route => request.url() === `${origin}${TEMENOS_RELAY_PATH}${route.path}` && request.method() === route.method);
    if (!route) return;
    const existing = requests.get(request);
    if (existing) return existing;
    if (rows.length >= 64) { truncated = true; return; }
    const row: RelayObservation = { route: `${TEMENOS_RELAY_PATH}${route.path}`, status: null, outcome: 'response', responseStartMs: null, responseEndMs: null, requestBodyBytes: null, responseBodyBytes: null };
    requests.set(request, row); rows.push(row);
    return row;
  };
  const timing = (request: Request, row: RelayObservation) => {
    const value = request.timing();
    row.responseStartMs = measured(value.responseStart);
    row.responseEndMs = measured(value.responseEnd);
  };
  const response = (value: Response) => {
    try {
      const request = value.request(), row = rowFor(request);
      if (!row) return;
      const status = value.status();
      row.status = Number.isInteger(status) && status >= 100 && status <= 599 ? status : null;
      timing(request, row);
      if (row.status !== null && (row.status < 200 || row.status >= 300)) {
        row.errorOrigin = null;
        if (row.status === 400) row.http400Origin = null;
        const collectOrigin = async () => {
          try {
            const origin = await value.headerValue('x-lace-temenos-error-origin');
            if (origin === 'relay' || origin === 'upstream') {
              row.errorOrigin = origin;
              if (row.status === 400) row.http400Origin = origin;
            }
          } catch { metadataUnavailable = true; }
        };
        const work = collectOrigin(); pending.add(work);
        void work.finally(() => pending.delete(work));
      }
    } catch { metadataUnavailable = true; }
  };
  const finished = (request: Request) => {
    const collect = async () => {
      try {
        const row = rowFor(request);
        if (!row) return;
        row.outcome = 'finished'; timing(request, row);
        const sizes = await request.sizes();
        row.requestBodyBytes = measured(sizes.requestBodySize);
        row.responseBodyBytes = measured(sizes.responseBodySize);
      } catch { metadataUnavailable = true; }
    };
    const work = collect(); pending.add(work);
    void work.finally(() => pending.delete(work));
  };
  const failed = (request: Request) => {
    try {
      const row = rowFor(request);
      if (row) { row.outcome = 'failed'; timing(request, row); }
    } catch { metadataUnavailable = true; }
  };
  page.on('response', response); page.on('requestfinished', finished); page.on('requestfailed', failed);
  return {
    stop: async () => {
      page.off('response', response); page.off('requestfinished', finished); page.off('requestfailed', failed);
      await Promise.all(pending);
      return { responses: rows.map(row => ({ ...row })), truncated, metadataUnavailable };
    },
  };
}
