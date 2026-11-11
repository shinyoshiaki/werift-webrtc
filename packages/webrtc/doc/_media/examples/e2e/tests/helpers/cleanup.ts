import { readdirSync, rmSync } from "node:fs";
import path from "node:path";

import type { BrowserContext, Page } from "playwright";

import { closePage } from "./openPage.js";
import { examplePath } from "./paths.js";
import {
  killPids,
  listMediaPids,
  type SpawnedProcess,
  stopProcessTree,
} from "./spawnExample.js";

export type ExampleHandles = {
  pages: Array<{ page: Page; context: BrowserContext }>;
  processes: SpawnedProcess[];
  servers: Array<{ close: () => Promise<void> }>;
  mediaPidsBefore: Set<number>;
  tmpDirs: string[];
  udpClosers: Array<() => Promise<void>>;
};

export async function cleanupExample(handles: ExampleHandles) {
  for (const { page, context } of handles.pages) {
    await closePage(page, context);
  }
  for (const server of handles.servers) {
    await server.close().catch(() => undefined);
  }
  for (const closeUdp of handles.udpClosers) {
    await closeUdp().catch(() => undefined);
  }
  for (const spawned of handles.processes) {
    await stopProcessTree(spawned.child);
  }

  const after = await listMediaPids();
  const leftover: number[] = [];
  for (const pid of after) {
    if (!handles.mediaPidsBefore.has(pid)) {
      leftover.push(pid);
    }
  }
  await killPids(leftover);

  for (const dir of handles.tmpDirs) {
    rmSync(dir, { recursive: true, force: true });
  }

  const dumpDir = examplePath("mediachannel/recvonly");
  try {
    for (const name of readdirSync(dumpDir)) {
      if (name.startsWith("dump_") && name.endsWith(".rtp")) {
        rmSync(path.join(dumpDir, name), { force: true });
      }
    }
  } catch {
    // example dir might be missing in a broken checkout
  }
}
