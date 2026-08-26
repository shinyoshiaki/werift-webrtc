#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

execFileSync("npm", ["run", "doc"], { cwd: root, stdio: "inherit" });

const docPaths = ["doc"];
for (const name of readdirSync(join(root, "packages"))) {
  const relative = join("packages", name, "doc");
  if (existsSync(join(root, relative))) {
    docPaths.push(relative);
  }
}

const porcelain = execFileSync("git", ["status", "--porcelain", "--", ...docPaths], {
  cwd: root,
  encoding: "utf8",
});

if (porcelain.trim().length > 0) {
  process.stderr.write(
    "Generated docs differ from the worktree (root doc/ and packages/*/doc):\n",
  );
  process.stderr.write(porcelain);
  process.exit(1);
}
