import { mkdir, writeFile } from "fs/promises";
import { dirname } from "path";
import {
  defaultMarkdownReportPath,
  formatProgressEvent,
  formatMarkdownReport,
  hasWptRegressions,
  runSelectedWpt,
} from "./runner";

async function main() {
  const updateBaseline = process.argv.includes("--update-baseline");
  const report = await runSelectedWpt({
    compareWithBaseline: true,
    onProgress: (event) => {
      process.stdout.write(`${formatProgressEvent(event)}\n`);
    },
    updateBaseline,
  });
  const markdown = formatMarkdownReport(report);

  await mkdir(dirname(defaultMarkdownReportPath), { recursive: true });
  await writeFile(defaultMarkdownReportPath, markdown, "utf8");

  await new Promise<void>((resolve) => {
    process.stdout.write(markdown, () => resolve());
  });
  process.exit(hasWptRegressions(report) ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
