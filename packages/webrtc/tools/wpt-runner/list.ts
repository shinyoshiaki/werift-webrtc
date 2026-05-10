import { loadAllowlist, printTargetList } from "./runner";

async function main() {
  const allowlist = await loadAllowlist();
  printTargetList(allowlist);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
