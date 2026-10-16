import { request as httpsRequest } from 'node:https';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Readable } from 'node:stream';
import type { Plugin } from 'vite';
import { TEMENOS_LEDGER_QUERY, TEMENOS_MAX_IN_FLIGHT, TEMENOS_RELAY_HEADER, TEMENOS_RELAY_PATH, TEMENOS_TIMEOUT_MS, temenosRoute } from './src/midnight/temenos-transport';
import { readTemenosTokenFile, TemenosCredentialError } from './temenos-relay-credential';

class RelayFailure extends Error {
  readonly status: number;
  constructor(status: number) { super('Temenos transport refused'); this.status = status; }
}

function readBounded(stream: Readable, limit: number, signal: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const cleanup = () => {
      stream.off('data', data); stream.off('end', end); stream.off('error', fail); stream.off('aborted', aborted);
      signal.removeEventListener('abort', aborted);
    };
    const fail = (error: unknown) => { cleanup(); stream.pause(); reject(error); };
    const aborted = () => fail(new RelayFailure(504));
    const data = (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) fail(new RelayFailure(413));
      else chunks.push(chunk);
    };
    const end = () => { cleanup(); resolve(Buffer.concat(chunks)); };
    if (signal.aborted) { aborted(); return; }
    stream.on('data', data); stream.once('end', end); stream.once('error', fail); stream.once('aborted', aborted);
    signal.addEventListener('abort', aborted, { once: true });
  });
}

function base64(value: unknown, size?: number, minimum = 16): boolean {
  if (typeof value !== 'string' || value.length % 4 !== 0) return false;
  const decoded = Buffer.from(value, 'base64');
  return decoded.toString('base64') === value && (size === undefined ? decoded.length >= minimum : decoded.length === size);
}

const exactKeys = (value: unknown, names: string[]): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value) &&
  Object.keys(value).length === names.length && names.every(name => Object.hasOwn(value, name));

function pemCertificate(value: unknown): boolean {
  if (typeof value !== 'string') return false;
  const limit = temenosRoute('/warden/verify-attestation', 'POST')!.limit;
  if (Buffer.byteLength(value, 'utf8') > limit) return false;
  // Each PEM block needs at least 58 bytes, so the request limit bounds its count.
  // Sticky matching consumes every byte; only whitespace may separate blocks.
  const pem = /[ \t\r\n]*-----BEGIN CERTIFICATE-----\r?\n([A-Za-z0-9+/=\r\n]*\r?\n)-----END CERTIFICATE-----/y;
  let offset = 0;
  let count = 0;
  while (offset < value.length) {
    pem.lastIndex = offset;
    const block = pem.exec(value);
    if (!block) return count > 0 && /^[ \t\r\n]*$/.test(value.slice(offset));
    if (!base64(block[1].replace(/\r?\n/g, ''), undefined, 1)) return false;
    offset = pem.lastIndex;
    count++;
  }
  return count > 0;
}

function validWardenBody(body: Record<string, unknown>): boolean {
  if (!exactKeys(body, ['dapp_id', 'tee_attestation', 'payload']) ||
      typeof body.dapp_id !== 'string' || !/^[a-fA-F0-9]{64}$/.test(body.dapp_id) || !exactKeys(body.payload, [])) return false;
  const raw = body.tee_attestation;
  if (!exactKeys(raw, ['version', 'attestation', 'msg', 'sig', 'pcr']) && !exactKeys(raw, ['attestation', 'msg', 'sig', 'pcr'])) return false;
  if (raw.version !== undefined && raw.version !== '1') return false;
  const attestation = raw.attestation;
  if (!exactKeys(attestation, ['mode', 'evidence']) || attestation.mode !== 'raw_sev_snp') return false;
  const evidence = attestation.evidence;
  return exactKeys(evidence, ['report', 'vcek', 'runtime_data']) && base64(evidence.report, 1184) &&
    pemCertificate(evidence.vcek) &&
    base64(evidence.runtime_data, undefined, 1) && ['msg', 'sig', 'pcr'].every(field => base64(raw[field], undefined, 1));
}

/** Verifier 0.3 keeps the outer envelopes; its HTTP request is inside ciphertext. */
function validEnvelope(path: string, bytes: Buffer): boolean {
  try {
    const body = JSON.parse(bytes.toString('utf8'));
    if (path === '/ledger/contract-state') return exactKeys(body, ['query', 'variables']) && body.query === TEMENOS_LEDGER_QUERY &&
      exactKeys(body.variables, ['address']) && typeof body.variables.address === 'string' && /^[a-fA-F0-9]{64}$/.test(body.variables.address);
    if (path === '/warden/verify-attestation') return validWardenBody(body);
    const field = path.endsWith('/session') ? 'nonceC' : path.endsWith('/complete') ? 'enc' : 'ciphertext';
    return exactKeys(body, ['sid', field]) &&
      base64(body.sid, 16) && base64(body[field], field === 'ciphertext' ? undefined : 32);
  } catch { return false; }
}

/** Forward only public state; upstream diagnostics must never echo a credential. */
function ledgerResponse(status: number, bytes: Buffer): Buffer {
  if (status < 200 || status >= 300) return Buffer.from('{"error":"temenos_ledger_request_failed"}');
  try {
    const body = JSON.parse(bytes.toString('utf8'));
    if (Array.isArray(body.errors) && body.errors.length) return Buffer.from('{"errors":[{"message":"Temenos ledger read failed"}]}');
    const action = body.data?.contractAction;
    if (action === null) return Buffer.from('{"data":{"contractAction":null}}');
    if (typeof action?.state !== 'string' || !/^(?:0x)?[a-fA-F0-9]+$/.test(action.state) || action.state.replace(/^0x/, '').length % 2 !== 0) throw new RelayFailure(502);
    return Buffer.from(JSON.stringify({ data: { contractAction: { state: action.state } } }));
  } catch { throw new RelayFailure(502); }
}

/** Fixed HTTPS upstream. The injectable request function is only an offline test seam. */
export function createTemenosRelay(requestImpl: typeof httpsRequest = httpsRequest,
  readToken = () => readTemenosTokenFile(process.env.TEMENOS_BLOCKFROST_PREPROD_TOKEN_FILE)) {
  let active = 0;
  return async (req: IncomingMessage, res: ServerResponse, next: () => void) => {
    const raw = req.url ?? '';
    if (raw !== TEMENOS_RELAY_PATH && !raw.startsWith(`${TEMENOS_RELAY_PATH}/`) && !raw.startsWith(`${TEMENOS_RELAY_PATH}?`)) { next(); return; }
    const answer = (status: number, body: Buffer | string = '{"error":"temenos_transport_refused"}', origin: 'relay' | 'upstream' = 'relay') => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store',
        [TEMENOS_RELAY_HEADER]: '1', 'x-content-type-options': 'nosniff', 'connection': 'close',
        ...(status < 200 || status >= 300 ? { 'x-lace-temenos-error-origin': origin } : {}),
        ...(status === 400 ? { 'x-lace-temenos-400-origin': origin } : {}) });
      res.end(body);
    };
    const path = raw.slice(TEMENOS_RELAY_PATH.length);
    const route = temenosRoute(path, req.method ?? '');
    if (!route) { answer(404); return; }
    const headers = req.headers;
    const protocol = (req.socket as { encrypted?: boolean }).encrypted ? 'https:' : 'http:';
    if ((headers.origin !== undefined && headers.origin !== `${protocol}//${headers.host}`) ||
        (headers['sec-fetch-site'] !== undefined && headers['sec-fetch-site'] !== 'same-origin') ||
        headers.authorization !== undefined || headers['proxy-authorization'] !== undefined || headers.cookie !== undefined || headers.project_id !== undefined) {
      answer(403); return;
    }
    if (headers['content-encoding'] !== undefined ||
        (route.method === 'POST' && headers['content-type']?.split(';')[0].trim().toLowerCase() !== 'application/json')) {
      answer(415); return;
    }
    if (route.method === 'GET' && (headers['transfer-encoding'] !== undefined || (headers['content-length'] ?? '0') !== '0')) {
      answer(400); return;
    }
    const requestLimit = route.kind === 'ledger' ? 4096 : route.limit;
    if (Number(headers['content-length'] ?? 0) > requestLimit) { answer(413); return; }
    if (active >= TEMENOS_MAX_IN_FLIGHT) { answer(503); return; }
    active++;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TEMENOS_TIMEOUT_MS);
    const disconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', disconnect);
    // An HTTP abort may emit `aborted` followed by `error`, after readBounded
    // has already settled. Keep late stream errors from escaping middleware.
    req.on('error', disconnect);
    let upstream: ReturnType<typeof httpsRequest> | undefined;
    let incoming: IncomingMessage | undefined;
    try {
      const body = await readBounded(req, route.method === 'GET' ? 0 : requestLimit, controller.signal);
      if (route.method === 'POST' && !validEnvelope(path, body)) throw new RelayFailure(400);
      const token = route.kind === 'ledger' ? readToken() : undefined;
      incoming = await new Promise<IncomingMessage>((resolve, reject) => {
        // No browser headers, credentials, environment proxy or redirect handler.
        // Explicit TLS validation also refuses an insecure Node TLS environment.
        upstream = requestImpl(route.target, {
          method: route.method, rejectUnauthorized: true, signal: controller.signal,
          headers: { accept: 'application/json', 'accept-encoding': 'identity',
            ...(token === undefined ? {} : { project_id: token }),
            ...(route.method === 'POST' ? { 'content-type': 'application/json', 'content-length': body.length } : {}) },
        }, resolve);
        upstream.on('error', reject);
        upstream.end(route.method === 'POST' ? body : undefined);
      });
      incoming.on('error', () => {});
      const status = incoming.statusCode ?? 502;
      if (status >= 300 && status < 400) throw new RelayFailure(502);
      if (incoming.headers['content-encoding'] && incoming.headers['content-encoding'] !== 'identity') throw new RelayFailure(502);
      if (Number(incoming.headers['content-length'] ?? 0) > route.limit) throw new RelayFailure(502);
      const responseBody = await readBounded(incoming, route.limit, controller.signal);
      answer(status, route.kind === 'ledger' ? ledgerResponse(status, responseBody) : responseBody, 'upstream');
    } catch (error) {
      if (error instanceof TemenosCredentialError) answer(503, '{"error":"temenos_ledger_not_configured","detail":"Configure TEMENOS_BLOCKFROST_PREPROD_TOKEN_FILE with an owner-only mode 600 token file and disable HTTP(S) debug logging"}');
      else answer(controller.signal.aborted ? 504 : error instanceof RelayFailure ? error.status : 502);
    } finally {
      clearTimeout(timer); res.off('close', disconnect);
      incoming?.destroy(); upstream?.destroy();
      active--;
    }
  };
}

/** Same middleware before SPA fallback in both dev and production preview. */
export function temenosRelayPlugin(): Plugin {
  return {
    name: 'lace-temenos-relay',
    configureServer(server) { server.middlewares.use(createTemenosRelay()); },
    configurePreviewServer(server) { server.middlewares.use(createTemenosRelay()); },
  };
}
