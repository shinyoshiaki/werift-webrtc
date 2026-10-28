import type { Page } from "playwright";

/** Arrange / Act helper: run one scenario of mediachannel/latency_budget. */
export function runLatencyBudgetScenario<T = any>(
  page: Page,
  scenario: "runA" | "runB" | "runC" | "runD",
  options: unknown,
): Promise<T> {
  return page.evaluate(
    async ([name, args]) => {
      const api = (window as any).latencyBudget;
      await api.audioContext();
      return api[name](args);
    },
    [scenario, options] as const,
  );
}

/** Arrange: wait until the Vite page has loaded the example. */
export async function waitLatencyBudgetPage(page: Page) {
  await page.waitForFunction(() => (window as any).latencyBudget, null, {
    timeout: 30_000,
  });
}

/**
 * Scenario A, adversarial on top of the periodic burst: the head is lost, the
 * tail is lost, and the last frames reach werift only after the stop notice.
 */
export const latencyBudgetAdversarialUpstream = {
  headLossPackets: 8,
  tailLossMs: 300,
  holdTailFrames: 10,
  holdTailMs: 1000,
};

export const latencyBudgetLoss = {
  /**
   * Upstream (scenario A): 15 of every 100 packets (300ms of every 2s). By
   * position in the stream, not by time, so it never covers the frames held
   * back past the stop (positions ~240-249 of ~250).
   */
  upstreamPeriodic: { every: 100, count: 15 },
  /** Downstream (scenario C): 800ms bursts every 3s */
  downstream: { intervalMs: 3000, durationMs: 800 },
  /**
   * Downstream (scenario C): one 3.5s burst (175 packets) from the very first
   * packet of the subscription, so the player only knows the holes from the
   * start notice werift sends.
   */
  downstreamLong: { intervalMs: 60_000, durationMs: 3500, offsetMs: 0 },
};
