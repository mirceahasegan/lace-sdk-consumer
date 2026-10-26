import type { Browser, CDPSession } from '@playwright/test';

// The SDK's Worker mode runs the engine in a SharedWorker. Playwright has no SharedWorker API and its
// routing does not see a SharedWorker's requests, so these helpers use the Chrome DevTools Protocol from
// a browser-level session. They keep URLs, counts and JSON-RPC method names only: never a frame's or a
// request's payload, which can carry wallet data such as an indexer session's viewing key.

/** What one SharedWorker of the browser did while it was observed. */
export type WorkerActivity = {
  readonly targetId: string;
  readonly title: string;
  readonly url: string;
  readonly closed: boolean;
  /** WebSocket URLs it opened, without query strings. */
  readonly sockets: readonly string[];
  /** How many of those WebSockets are still open. */
  readonly openSockets: number;
  /** The URLs of the WebSockets still open, without query strings. */
  readonly openSocketUrls: readonly string[];
  /** When each WebSocket opened or closed, in milliseconds since the observer started. */
  readonly socketEvents: readonly { readonly atMs: number; readonly event: 'created' | 'closed'; readonly url: string }[];
  /** `METHOD url` of its requests to a node, an indexer or a proof server, without query strings. */
  readonly requests: readonly string[];
  /** Node JSON-RPC frames it sent whose method starts with `author_submit`: transaction submissions. */
  readonly submitFrames: number;
};

type RemoteMessage = { id?: number; method?: string; params?: Record<string, unknown>; result?: Record<string, unknown>; error?: { message?: string } };
type Worker = {
  targetId: string; title: string; url: string; closed: boolean;
  sockets: string[]; requests: string[]; submitFrames: number;
  socketUrls: Map<string, string>; socketEvents: { atMs: number; event: 'created' | 'closed'; url: string }[];
  sessionId?: string; attached: Promise<void>;
  scripts: Map<string, string>; onPaused: Set<() => void>;
};

const ENDPOINT = /:9944\b|:8088\b|:6300\b|\.midnight\.network\b/;
const withoutQuery = (url: string) => url.split('?')[0]!;
const rpcMethod = (payload: unknown): string | undefined => {
  if (typeof payload !== 'string' || payload.length > 1_000_000) return undefined;
  try { const method = (JSON.parse(payload) as { method?: unknown })?.method; return typeof method === 'string' ? method : undefined; }
  catch { return undefined; }
};
const snapshot = (worker: Worker): WorkerActivity => ({
  targetId: worker.targetId, title: worker.title, url: withoutQuery(worker.url), closed: worker.closed,
  sockets: [...worker.sockets], requests: [...worker.requests], submitFrames: worker.submitFrames,
  openSockets: worker.socketUrls.size, openSocketUrls: [...worker.socketUrls.values()], socketEvents: worker.socketEvents.map(item => ({ ...item })),
});

/**
 * Watches every SharedWorker of the browser from now on, the ones already running included. With `attach` (the
 * default) it attaches a DevTools session to each worker to see its connections. Chromium keeps a worker that
 * ends while such a session is attached, and connects the next `new SharedWorker` of the same page to it, so a
 * scenario in which a worker ends by itself observes without attaching, and `close` detaches first.
 */
export async function observeSharedWorkers(browser: Browser, { attach: attachSessions = true }: { attach?: boolean } = {}) {
  const cdp: CDPSession = await browser.newBrowserCDPSession();
  const workers = new Map<string, Worker>();
  const bySession = new Map<string, Worker>();
  const replies = new Map<number, (message: RemoteMessage) => void>();
  let nextId = 0;
  let stopped = false;
  const started = Date.now();

  // Commands to a worker go through the browser session (Playwright offers no child sessions).
  const call = (worker: Worker, method: string, params: Record<string, unknown> = {}, limitMs = 15_000) =>
    new Promise<RemoteMessage>((resolve, reject) => {
      if (!worker.sessionId) { reject(new Error(`${method}: worker not attached`)); return; }
      const id = ++nextId;
      const timer = setTimeout(() => { replies.delete(id); reject(new Error(`${method}: no answer within ${limitMs} ms`)); }, limitMs);
      replies.set(id, message => { clearTimeout(timer); if (message.error) reject(new Error(`${method}: ${message.error.message ?? 'failed'}`)); else resolve(message); });
      cdp.send('Target.sendMessageToTarget', { sessionId: worker.sessionId, message: JSON.stringify({ id, method, params }) })
        .catch(error => { clearTimeout(timer); replies.delete(id); reject(error); });
    });

  cdp.on('Target.receivedMessageFromTarget', ({ sessionId, message }) => {
    const worker = bySession.get(sessionId);
    if (!worker) return;
    let parsed: RemoteMessage;
    try { parsed = JSON.parse(message) as RemoteMessage; } catch { return; }
    if (parsed.id !== undefined) { replies.get(parsed.id)?.(parsed); replies.delete(parsed.id); return; }
    const params = parsed.params ?? {};
    if (parsed.method === 'Network.webSocketCreated') {
      const url = withoutQuery(String(params.url));
      worker.sockets.push(url); worker.socketUrls.set(String(params.requestId), url);
      worker.socketEvents.push({ atMs: Date.now() - started, event: 'created', url });
    } else if (parsed.method === 'Network.webSocketClosed') {
      const url = worker.socketUrls.get(String(params.requestId));
      if (url !== undefined) { worker.socketUrls.delete(String(params.requestId)); worker.socketEvents.push({ atMs: Date.now() - started, event: 'closed', url }); }
    }
    else if (parsed.method === 'Network.webSocketFrameSent') {
      const method = rpcMethod((params.response as { payloadData?: unknown } | undefined)?.payloadData);
      if (method?.startsWith('author_submit')) worker.submitFrames++;
    } else if (parsed.method === 'Network.requestWillBeSent') {
      const request = params.request as { url?: string; method?: string } | undefined;
      if (request?.url && ENDPOINT.test(request.url)) worker.requests.push(`${request.method} ${withoutQuery(request.url)}`);
    } else if (parsed.method === 'Debugger.scriptParsed') {
      if (typeof params.url === 'string' && params.url) worker.scripts.set(String(params.scriptId), params.url);
    } else if (parsed.method === 'Debugger.paused') for (const listener of worker.onPaused) listener();
  });

  const attach = (info: { targetId: string; title: string; url: string }) => {
    if (workers.has(info.targetId) || stopped) return;
    const worker: Worker = { ...info, closed: false, sockets: [], requests: [], submitFrames: 0, socketUrls: new Map(), socketEvents: [], attached: Promise.resolve(), scripts: new Map(), onPaused: new Set() };
    workers.set(info.targetId, worker);
    if (!attachSessions) return;
    worker.attached = (async () => {
      const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: info.targetId, flatten: false });
      worker.sessionId = sessionId; bySession.set(sessionId, worker);
      await call(worker, 'Network.enable');
    })().catch(() => { /* a worker that closed before the attach finished */ });
  };
  cdp.on('Target.targetCreated', ({ targetInfo }) => { if (targetInfo.type === 'shared_worker') attach(targetInfo); });
  cdp.on('Target.targetDestroyed', ({ targetId }) => { const worker = workers.get(targetId); if (worker) worker.closed = true; });
  await cdp.send('Target.setDiscoverTargets', { discover: true });
  for (const info of (await cdp.send('Target.getTargets')).targetInfos) if (info.type === 'shared_worker') attach(info);

  const live = () => [...workers.values()].filter(worker => !worker.closed);
  const detach = async (worker: Worker) => {
    const { sessionId } = worker;
    if (!sessionId) return;
    worker.sessionId = undefined; bySession.delete(sessionId);
    await cdp.send('Target.detachFromTarget', { sessionId }).catch(() => {});
  };
  // A worker that has ended is gone from the browser's targets, whether or not its destroy event arrived.
  const refresh = async () => {
    const running = new Set((await cdp.send('Target.getTargets')).targetInfos.filter(info => info.type === 'shared_worker').map(info => info.targetId));
    for (const worker of workers.values()) if (!running.has(worker.targetId)) worker.closed = true;
  };
  const find = (targetId: string) => { const worker = workers.get(targetId); if (!worker) throw new Error('Unknown SharedWorker'); return worker; };

  // Browser-level request interception, which, unlike Playwright's routing, sees a SharedWorker's requests.
  // Only requests that match the enabled pattern pause here.
  let failing: { remaining: number; failed: string[]; passed: string[] } | undefined;
  cdp.on('Fetch.requestPaused', ({ requestId, request }) => {
    const rule = failing;
    const url = withoutQuery(request.url);
    if (rule && rule.remaining > 0) {
      rule.remaining--; rule.failed.push(url);
      void cdp.send('Fetch.failRequest', { requestId, errorReason: 'Failed' }).catch(() => {});
    } else {
      rule?.passed.push(url);
      void cdp.send('Fetch.continueRequest', { requestId }).catch(() => {});
    }
  });

  return {
    /** Every SharedWorker seen so far, closed ones included, as of the last check of the browser's targets. */
    all: () => [...workers.values()].map(snapshot),
    /** The SharedWorkers still running. */
    live: async () => { await refresh(); return live().map(snapshot); },
    /** Waits until the browser no longer runs this SharedWorker. */
    async waitForClosed(targetId: string, limitMs: number): Promise<void> {
      const end = Date.now() + limitMs;
      while (Date.now() < end) {
        await refresh();
        if (find(targetId).closed) return;
        await new Promise(resolve => setTimeout(resolve, 200));
      }
      throw new Error(`The SharedWorker still runs after ${limitMs} ms`);
    },
    /** Waits for a running SharedWorker other than `except`, attached and observed. */
    async waitForWorker(limitMs: number, except: readonly string[] = []): Promise<WorkerActivity> {
      const end = Date.now() + limitMs;
      while (Date.now() < end) {
        await refresh();
        const worker = live().find(item => !except.includes(item.targetId));
        if (worker) { await worker.attached; return snapshot(worker); }
        await new Promise(resolve => setTimeout(resolve, 100));
      }
      throw new Error(`No new SharedWorker within ${limitMs} ms`);
    },
    /** Ends a SharedWorker at once, as a crash would: detaches this observer, then `Target.closeTarget`. */
    async close(targetId: string): Promise<void> {
      await detach(find(targetId));
      const { success } = await cdp.send('Target.closeTarget', { targetId });
      if (!success) throw new Error('Target.closeTarget refused the SharedWorker');
    },
    /**
     * Ends a SharedWorker that is paused at a breakpoint without running the rest of the paused task: the
     * current execution is terminated as the worker resumes, then the observer detaches and the worker is
     * closed. The termination request is answered only once the worker runs again, so it is not awaited.
     */
    async closePaused(targetId: string): Promise<void> {
      const worker = find(targetId);
      await cdp.send('Target.sendMessageToTarget', { sessionId: worker.sessionId!, message: JSON.stringify({ id: ++nextId, method: 'Runtime.terminateExecution', params: {} }) });
      await call(worker, 'Debugger.resume');
      await detach(worker);
      const { success } = await cdp.send('Target.closeTarget', { targetId });
      if (!success) throw new Error('Target.closeTarget refused the SharedWorker');
    },
    /**
     * Sets a breakpoint in the worker's own scripts at the one place that matches `anchor`, and returns a
     * promise that settles when the worker pauses there. The worker's script names start with
     * `midnight-worker` in both the development server and a production build.
     */
    async pauseAt(targetId: string, anchor: RegExp, limitMs = 30_000): Promise<{ paused: Promise<void> }> {
      const worker = find(targetId);
      await worker.attached;
      await call(worker, 'Debugger.enable', {}, limitMs);
      // Enabling the debugger reports the scripts already parsed as events; let them arrive.
      await new Promise(resolve => setTimeout(resolve, 500));
      const matches: { scriptId: string; lineNumber: number; columnNumber: number }[] = [];
      for (const [scriptId, url] of worker.scripts) {
        if (!/midnight-worker/.test(url)) continue;
        const { result } = await call(worker, 'Debugger.getScriptSource', { scriptId }, limitMs);
        const source = String(result?.scriptSource ?? '');
        for (const match of source.matchAll(new RegExp(anchor.source, 'g'))) {
          const before = source.slice(0, match.index);
          const lineNumber = before.split('\n').length - 1;
          matches.push({ scriptId, lineNumber, columnNumber: match.index! - (before.lastIndexOf('\n') + 1) });
        }
      }
      if (matches.length !== 1) throw new Error(`Expected one breakpoint anchor in the worker's scripts, found ${matches.length}`);
      const paused = new Promise<void>(resolve => { const listener = () => { worker.onPaused.delete(listener); resolve(); }; worker.onPaused.add(listener); });
      await call(worker, 'Debugger.setBreakpoint', { location: matches[0] }, limitMs);
      return { paused };
    },
    /**
     * Fails the next `times` requests whose URL matches the DevTools glob `urlPattern`, from any page or
     * worker, and lets the later ones through.
     */
    async failRequests(urlPattern: string, times = 1) {
      const rule = { remaining: times, failed: [] as string[], passed: [] as string[] };
      failing = rule;
      await cdp.send('Fetch.enable', { patterns: [{ urlPattern }] });
      return { failed: () => [...rule.failed], passed: () => [...rule.passed] };
    },
    async stop() {
      stopped = true;
      if (failing) await cdp.send('Fetch.disable').catch(() => {});
      await cdp.send('Target.setDiscoverTargets', { discover: false }).catch(() => {});
      await cdp.detach().catch(() => {});
    },
  };
}
export type SharedWorkerObserver = Awaited<ReturnType<typeof observeSharedWorkers>>;
