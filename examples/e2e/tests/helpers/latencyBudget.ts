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

export const latencyBudgetLoss = {
  /** Upstream (scenario A): 300ms bursts every 2s */
  upstream: { intervalMs: 2000, durationMs: 300 },
  /** Downstream (scenario C): 800ms bursts every 3s */
  downstream: { intervalMs: 3000, durationMs: 800 },
  /** Downstream (scenario C): one 3.5s burst (175 packets) */
  downstreamLong: { intervalMs: 8000, durationMs: 3500 },
};
