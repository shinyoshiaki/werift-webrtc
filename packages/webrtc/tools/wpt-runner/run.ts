import {
  formatMarkdownReport,
  hasWptRegressions,
  runSelectedWpt,
} from "./runner";

async function main() {
  const updateBaseline = process.argv.includes("--update-baseline");
  const report = await runSelectedWpt({
    compareWithBaseline: true,
    updateBaseline,
  });

  await new Promise<void>((resolve) => {
    process.stdout.write(formatMarkdownReport(report), () => resolve());
  });
  process.exit(hasWptRegressions(report) ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
