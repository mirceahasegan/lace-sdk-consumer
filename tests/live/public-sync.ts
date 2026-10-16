// Self-contained for page.evaluate. Only fixed stages, a ratio and completion
// bits leave the page; never raw DOM, account IDs, timestamps or wallet state.
export function readPublicSync(input?: { initialization: unknown; sync: unknown; readiness: unknown } | void) {
  const read = (id: string) => {
    try { return JSON.parse(document.getElementById(id)?.textContent ?? '{}'); } catch { return {}; }
  };
  try {
    const initialization = input ? input.initialization : read('initialization');
    const sync = input ? input.sync : read('sync');
    const readiness = input ? input.readiness : read('readiness');
    const stage = (initialization as { stage?: unknown })?.stage;
    const stages = ['idle', 'restore-started', 'restore-failed', 'waiting-for-engine', 'state-observed', 'synchronized', 'sync-failed', 'balance-stream-failed'];
    const operations = (sync as { pendingSync?: { operations?: Record<string, { progress?: unknown }> } })?.pendingSync?.operations;
    const ratios = Object.values(operations ?? {}).map(op => op?.progress)
      .filter((value): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1);
    const flags = (readiness as { strictlySynced?: Record<string, unknown> })?.strictlySynced;
    const completed = (flags?.unshielded === true ? 1 : 0) | (flags?.shielded === true ? 2 : 0) | (flags?.dust === true ? 4 : 0);
    return { stage: stages.includes(stage as string) ? stage as string : 'not-observed',
      progress: { ...(ratios.length ? { fraction: Math.min(...ratios) } : {}), completed } };
  } catch { return { stage: 'not-observed', progress: { completed: 0 } }; }
}
