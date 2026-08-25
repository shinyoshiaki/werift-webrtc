#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

execFileSync("npm", ["run", "doc"], { cwd: root, stdio: "inherit" });

const diff = execFileSync("git", ["diff", "--", "doc"], {
  cwd: root,
  encoding: "utf8",
});
const untracked = execFileSync(
  "git",
  ["ls-files", "--others", "--exclude-standard", "--", "doc"],
  { cwd: root, encoding: "utf8" },
);

if (diff.length > 0 || untracked.length > 0) {
  if (diff) {
    process.stderr.write(diff);
  }
  if (untracked) {
    process.stderr.write("untracked files under doc/:\n");
    process.stderr.write(untracked);
  }
  process.exit(1);
}
