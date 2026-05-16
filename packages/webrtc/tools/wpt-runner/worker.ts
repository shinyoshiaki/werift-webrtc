import {
  readTargetFromEnvironment,
  runTargetInCurrentProcess,
  serializeWorkerResults,
} from "./runner";

async function main() {
  const target = readTargetFromEnvironment();
  const results = await runTargetInCurrentProcess(target);
  await new Promise<void>((resolve) => {
    process.stdout.write(serializeWorkerResults(results), () => resolve());
  });
  process.exit(0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
