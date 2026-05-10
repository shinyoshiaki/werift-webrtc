import { discoverWptTargets, printTargetList } from "./runner";

async function main() {
  const targets = await discoverWptTargets();
  printTargetList(targets);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
