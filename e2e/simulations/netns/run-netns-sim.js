/**
 * Chrome 受信側ボトルネックの GCC シミュレーション実行ランナー（CI 対象外）。
 *
 * 1. e2e の Playwright と同じ版の公式イメージに iproute2 を足したイメージを作る
 * 2. 特権コンテナで repo をマウントし、in-container.sh を実行する
 *    （network namespace と tc はコンテナ内だけで作り、ホストのネットワークは変えない）
 *
 * 実行: `cd e2e && npm run test:sim:netns`
 */
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const e2eRoot = path.join(__dirname, "..", "..");
const repoRoot = path.join(e2eRoot, "..");

function playwrightVersion() {
  return require(
    require.resolve("playwright-core/package.json", {
      paths: [e2eRoot],
    }),
  ).version;
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", ...options });
  if (result.error) throw result.error;
  return result.status ?? 1;
}

function main() {
  if (spawnSync("docker", ["version"], { stdio: "ignore" }).status !== 0) {
    console.error(
      "[netns-sim] docker is not available (needs a daemon that can run --privileged containers)",
    );
    process.exit(1);
  }

  const version = playwrightVersion();
  const image = `werift-e2e-netns:${version}`;
  console.log(`[netns-sim] building ${image}`);
  const built = run("docker", [
    "build",
    "--quiet",
    "--build-arg",
    `PLAYWRIGHT_VERSION=${version}`,
    "-t",
    image,
    __dirname,
  ]);
  if (built !== 0) process.exit(built);

  const name = `werift-netns-sim-${process.pid}`;
  const child = spawn(
    "docker",
    [
      "run",
      "--rm",
      "--init",
      // network namespace / veth / tc inside the container
      "--privileged",
      "--name",
      name,
      "-v",
      `${repoRoot}:${repoRoot}`,
      "-w",
      e2eRoot,
      image,
      "sh",
      "simulations/netns/in-container.sh",
    ],
    { stdio: "inherit" },
  );

  // Stop only this container (by its name), never by pattern.
  const stop = () => {
    spawnSync("docker", ["stop", "-t", "2", name], { stdio: "ignore" });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  child.once("exit", (code, signal) => {
    process.exit(code ?? (signal ? 1 : 0));
  });
}

main();
