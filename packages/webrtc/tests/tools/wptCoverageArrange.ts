import { tmpdir } from "os";
import { resolve } from "path";
import { mkdir, mkdtemp, writeFile } from "fs/promises";

export async function createCoverageTempDir(prefix: string) {
  return mkdtemp(resolve(tmpdir(), prefix));
}

export async function createNamedCoverageTempDir(
  parentDir: string,
  name: string,
) {
  const directoryPath = resolve(parentDir, name);
  await mkdir(directoryPath);
  return directoryPath;
}

export function createScriptCoverage(url: string, count = 1) {
  return {
    scriptId: "1",
    url,
    functions: [
      {
        functionName: "",
        isBlockCoverage: true,
        ranges: [{ count, endOffset: 8, startOffset: 0 }],
      },
    ],
  };
}

export async function writeCoverageJson(
  directoryPath: string,
  fileName: string,
  payload: unknown,
) {
  const filePath = resolve(directoryPath, fileName);
  await writeFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
  return filePath;
}

export async function writePartialCoverageJson(
  directoryPath: string,
  fileName: string,
) {
  const filePath = resolve(directoryPath, fileName);
  await writeFile(filePath, '{"result":', "utf8");
  return filePath;
}
