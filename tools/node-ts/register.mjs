import { existsSync, statSync } from "node:fs";
import { registerHooks } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const TypeScriptExtensions = [".ts", ".mts", ".cts"];

export function resolveTypeScriptSpecifier(specifier, context, nextResolve) {
  const parentURL = context.parentURL;
  if (
    typeof parentURL !== "string" ||
    !parentURL.startsWith("file:") ||
    !/\.(?:ts|mts|cts)$/.test(fileURLToPath(parentURL))
  ) {
    return nextResolve(specifier, context);
  }

  const parentPath = fileURLToPath(parentURL);
  const parentDirectory = path.dirname(parentPath);
  if (parentPath.split(path.sep).includes("node_modules")) {
    return nextResolve(specifier, context);
  }

  let targetPath;
  if (path.isAbsolute(specifier)) targetPath = specifier;
  else if (specifier.startsWith("./") || specifier.startsWith("../")) {
    targetPath = path.resolve(parentDirectory, specifier);
  } else return nextResolve(specifier, context);

  if (targetPath.split(path.sep).includes("node_modules")) {
    return nextResolve(specifier, context);
  }

  const candidates = candidatesFor(targetPath);
  const resolvedPath = candidates.find((candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  });
  if (!resolvedPath || !existsSync(resolvedPath)) {
    return nextResolve(specifier, context);
  }

  return {
    url: context.conditions.includes("require")
      ? resolvedPath
      : pathToFileURL(resolvedPath).href,
    shortCircuit: true,
  };
}

function candidatesFor(targetPath) {
  const extension = path.extname(targetPath);
  const knownJavaScriptExtension = [".js", ".mjs", ".cjs"].includes(extension);
  const basePath = knownJavaScriptExtension
    ? targetPath.slice(0, -extension.length)
    : targetPath;
  const preferredExtension =
    extension === ".mjs" ? ".mts" : extension === ".cjs" ? ".cts" : ".ts";
  const hasExtension = extension !== "";
  const result = hasExtension
    ? [preferredExtension, ...TypeScriptExtensions.filter((item) => item !== preferredExtension)].map(
        (item) => `${basePath}${item}`,
      )
    : TypeScriptExtensions.map((item) => `${targetPath}${item}`);
  result.push(...TypeScriptExtensions.map((item) => path.join(targetPath, `index${item}`)));
  return result;
}

registerHooks({ resolve: resolveTypeScriptSpecifier });
