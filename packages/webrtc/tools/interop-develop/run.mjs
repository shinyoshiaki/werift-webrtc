/**
 * Runs `tests/interop/develop` (this branch against another revision, over
 * real wire bytes in one process).
 *
 *   npm run test:interop-develop [-- <vitest args>]
 *
 * - `WERIFT_DEVELOP_ROOT=<dir>`: use an existing checkout of the other
 *   revision (its dependencies must resolve, e.g. a linked node_modules).
 * - otherwise a temporary detached worktree of `WERIFT_DEVELOP_REV`
 *   (default `develop`) is created, this checkout's node_modules are linked
 *   into it, and it is removed afterwards. The active worktree is never
 *   checked out or reset.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const packageDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const repoRoot = path.resolve(packageDir, "../..");
const workspaces = [
  "common",
  "dtls",
  "ice",
  "ice-server",
  "rtp",
  "sctp",
  "webrtc",
];

function git(...args) {
  const result = spawnSync("git", args, { cwd: repoRoot, stdio: "inherit" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

let root = process.env.WERIFT_DEVELOP_ROOT;
let temporary;
if (!root) {
  const rev = process.env.WERIFT_DEVELOP_REV ?? "develop";
  temporary = mkdtempSync(path.join(tmpdir(), "werift-interop-"));
  rmSync(temporary, { recursive: true });
  git("worktree", "add", "--detach", temporary, rev);
  symlinkSync(
    path.join(repoRoot, "node_modules"),
    path.join(temporary, "node_modules"),
  );
  for (const name of workspaces) {
    const modules = path.join(repoRoot, "packages", name, "node_modules");
    const target = path.join(temporary, "packages", name, "node_modules");
    if (existsSync(modules) && !existsSync(target))
      symlinkSync(modules, target);
  }
  root = temporary;
}

let status = 1;
try {
  const result = spawnSync(
    "npx",
    ["vitest", "run", "tests/interop/develop", ...process.argv.slice(2)],
    {
      cwd: packageDir,
      stdio: "inherit",
      env: { ...process.env, WERIFT_DEVELOP_ROOT: root },
    },
  );
  status = result.status ?? 1;
} finally {
  if (temporary) git("worktree", "remove", "--force", temporary);
}
process.exit(status);
