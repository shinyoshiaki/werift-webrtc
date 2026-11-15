// Rebuild wpt/baseline.json from repeated full runs: each argument is a
// coverage/webrtc-wpt/results.json saved after one `npm run wpt`. Only the
// subtests that are PASS in every run (and not kept out by the allowlist) are
// gated; see selectStableBaseline in baselineLogic.ts.
import { readFile } from "fs/promises";
import { selectStableBaseline } from "./baselineLogic";
import { loadAllowlist, type WptRunReport, writeBaseline } from "./runner";

async function main() {
  const paths = process.argv.slice(2);
  if (paths.length < 2) {
    throw new Error(
      "usage: npm run wpt:stable-baseline -- <results.json> <results.json> [...] (two or more full runs)",
    );
  }
  const runs = await Promise.all(
    paths.map(
      async (path) =>
        (JSON.parse(await readFile(path, "utf8")) as WptRunReport).results,
    ),
  );
  const baseline = selectStableBaseline(runs, await loadAllowlist());
  await writeBaseline(baseline);
  const files = new Set(baseline.map(({ file, variant }) => `${file}${variant}`));
  process.stdout.write(
    `wpt/baseline.json: ${baseline.length} subtests in ${files.size} files, PASS in all ${runs.length} runs\n`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
