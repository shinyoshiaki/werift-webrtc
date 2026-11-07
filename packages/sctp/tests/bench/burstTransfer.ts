// Burst transfer benchmark (not part of the vitest suite).
// usage: npx tsx tests/bench/burstTransfer.ts [counts=1000,5000,20000] [size=1000]
import {
  createConnectedSctpPair,
  createMessages,
  runBurstTransfer,
} from "../utils";

const counts = (process.argv[2] ?? "1000,5000,20000").split(",").map(Number);
const size = Number(process.argv[3] ?? 1000);

const main = async () => {
  for (const count of counts) {
    const pair = await createConnectedSctpPair();
    const { elapsedMs, maxLagMs } = await runBurstTransfer(
      pair.client,
      pair.server,
      createMessages(count, size),
    );
    console.log(
      `N=${count} size=${size} elapsed=${elapsedMs.toFixed(0)}ms maxLag=${maxLagMs.toFixed(0)}ms`,
    );
    await pair.stop();
  }
};

main().then(() => process.exit(0));
