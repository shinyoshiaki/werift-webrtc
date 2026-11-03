import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, test } from "node:test";
import { resolveTypeScriptSpecifier } from "./register.mjs";

const temporaryDirectory = mkdtempSync(path.join(os.tmpdir(), "node-ts-hook-"));
after(() => rmSync(temporaryDirectory, { recursive: true, force: true }));

function arrange(parentName = "entry.ts") {
  const directory = path.join(temporaryDirectory, path.basename(parentName, ".ts"));
  mkdirSync(directory, { recursive: true });
  const parentPath = path.join(directory, parentName);
  writeFileSync(parentPath, "");
  return { directory, parentURL: pathToFileURL(parentPath).href };
}

const fallback = (specifier) => ({ url: `fallback:${specifier}` });

test("resolves extensionless, javascript-suffixed, and directory imports to TypeScript", () => {
  // Arrange
  const { directory, parentURL } = arrange();
  writeFileSync(path.join(directory, "plain.ts"), "");
  writeFileSync(path.join(directory, "module.mts"), "");
  mkdirSync(path.join(directory, "nested"));
  writeFileSync(path.join(directory, "nested", "index.cts"), "");

  // Act: 拡張子なし・.js 付き・ディレクトリ指定をそれぞれ解決する
  const plain = resolveTypeScriptSpecifier("./plain", { parentURL, conditions: ["import"] }, fallback);
  const module = resolveTypeScriptSpecifier("./module.js", { parentURL, conditions: ["import"] }, fallback);
  const nested = resolveTypeScriptSpecifier("./nested", { parentURL, conditions: ["import"] }, fallback);

  // Assert: いずれも同じ場所にある TypeScript ファイルの file URL になる
  assert.equal(plain.url, pathToFileURL(path.join(directory, "plain.ts")).href);
  assert.equal(module.url, pathToFileURL(path.join(directory, "module.mts")).href);
  assert.equal(nested.url, pathToFileURL(path.join(directory, "nested", "index.cts")).href);
});

test("returns a filesystem path for require and skips node_modules", () => {
  // Arrange
  const { directory, parentURL } = arrange("consumer.cts");
  writeFileSync(path.join(directory, "required.cts"), "");
  const dependencyDirectory = path.join(directory, "node_modules", "dependency");
  mkdirSync(dependencyDirectory, { recursive: true });
  writeFileSync(path.join(dependencyDirectory, "inside.ts"), "");

  // Act: require 経由の解決と node_modules 配下への相対指定を解決する
  const required = resolveTypeScriptSpecifier("./required.js", { parentURL, conditions: ["require"] }, fallback);
  const dependency = resolveTypeScriptSpecifier(
    "./node_modules/dependency/inside",
    { parentURL, conditions: ["import"] },
    fallback,
  );

  // Assert: require はファイルパスで返り、node_modules 配下は Node に委ねる
  assert.equal(required.url, path.join(directory, "required.cts"));
  assert.equal(dependency.url, "fallback:./node_modules/dependency/inside");
});

test("leaves bare specifiers and non-TypeScript parents to Node", () => {
  // Arrange
  const { directory } = arrange("entry.mjs");
  const context = {
    parentURL: pathToFileURL(path.join(directory, "entry.mjs")).href,
    conditions: ["import"],
  };

  // Act: TypeScript 以外から読み込まれた bare 指定子を解決する
  const bare = resolveTypeScriptSpecifier("vitest", context, fallback);

  // Assert: hook は介入せず次の resolve に委ねる
  assert.deepEqual(bare, { url: "fallback:vitest" });
});

test("resolves bare dot specifiers to the directory index", () => {
  // Arrange
  const { directory, parentURL } = arrange("child.ts");
  writeFileSync(path.join(directory, "index.ts"), "");
  writeFileSync(path.join(temporaryDirectory, "index.ts"), "");

  // Act: "." と ".." を解決する
  const current = resolveTypeScriptSpecifier(".", { parentURL, conditions: ["import"] }, fallback);
  const parent = resolveTypeScriptSpecifier("..", { parentURL, conditions: ["import"] }, fallback);

  // Assert: それぞれのディレクトリの index.ts になる
  assert.equal(current.url, pathToFileURL(path.join(directory, "index.ts")).href);
  assert.equal(parent.url, pathToFileURL(path.join(temporaryDirectory, "index.ts")).href);
});
