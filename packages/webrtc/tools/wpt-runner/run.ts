import { runSelectedWpt } from "./runner";

async function main() {
  const updateBaseline = process.argv.includes("--update-baseline");
  const report = await runSelectedWpt({
    compareWithBaseline: true,
    updateBaseline,
  });

  console.log(
    JSON.stringify(
      {
        summary: report.summary,
        regressions: report.regressions,
      },
      null,
      2,
    ),
  );

  if (
    report.summary.failed > 0 ||
    report.summary.timedOut > 0 ||
    report.regressions.length > 0
  ) {
    process.exitCode = 1;
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
