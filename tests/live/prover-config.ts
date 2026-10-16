import { withinPublicDeadline } from './wallet-input';

export function liveProver(value: string | undefined): 'temenos' | 'local' {
  if (value === undefined) return 'temenos';
  if (value === 'temenos' || value === 'local') return value;
  throw new Error('MIDNIGHT_LIVE_PROVER must be local or temenos; no fallback.');
}

// Never run this prover preflight from the non-proving suite.
export async function preflightLocalProver(request: typeof fetch = fetch): Promise<void> {
  const controller = new AbortController();
  try {
    await withinPublicDeadline(async () => {
      const response = await request('http://127.0.0.1:6300/version', {
        method: 'GET', redirect: 'error', credentials: 'omit', signal: controller.signal,
      });
      if (response.status !== 200 || !response.body) throw new Error('Local prover version unavailable.');
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          size += part.value.byteLength;
          if (size > 256) throw new Error('Local prover version response too large.');
          chunks.push(part.value);
        }
      } finally { void reader.cancel().catch(() => {}); }
      const bytes = new Uint8Array(size);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const text = new TextDecoder().decode(bytes).trim();
      let version: unknown = text;
      try { const json = JSON.parse(text); version = typeof json === 'string' ? json : json?.version; } catch { /* plain version */ }
      if (version !== '8.1.3') throw new Error('Local prover version mismatch.');
    }, 5_000, 'Local prover version preflight timed out.');
  } catch { throw new Error('Local proof-server 8.1.3 version preflight failed; no wallet restore or fallback.'); }
  finally { controller.abort(); }
}
