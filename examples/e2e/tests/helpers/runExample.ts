import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import type { Page } from "playwright";
import type { TaskContext } from "vitest";

import type { CatalogEntry } from "./catalog.js";
import { type ExampleHandles, cleanupExample } from "./cleanup.js";
import {
  attachFixtureFile,
  clickNamedButton,
  openExamplePage,
  supportsAv1,
} from "./openPage.js";
import { examplePath, fixtureWebm } from "./paths.js";
import {
  clientPageUrl,
  startStaticServer,
  startViteServer,
} from "./serveClient.js";
import {
  assertMediaPidsAlive,
  assertNoFatalLogs,
  commandExists,
  getAvailablePort,
  listMediaPids,
  spawnExampleTsx,
  spawnVideotestsrc,
  type SpawnedProcess,
  waitForLog,
  waitForMediaPids,
  waitForPortFree,
  waitForPortOpen,
  watchUnexpectedExit,
} from "./spawnExample.js";
import { listenUdp } from "./waitPeer.js";

export type ExampleSession = {
  entry: CatalogEntry;
  page?: Page;
  processes: SpawnedProcess[];
  workDir: string;
  udpListener?: { packets: number };
  mediaPids: Set<number>;
};

function needsMediaChild(entry: CatalogEntry) {
  return Boolean(entry.binary || entry.extraGstPorts?.length);
}

function expectsProcessExit(entry: CatalogEntry) {
  return entry.kind === "process-exit" || entry.expectExit != null;
}

function skipMissingBinary(entry: CatalogEntry, ctx?: TaskContext) {
  if (!entry.binary) {
    return false;
  }
  const command = entry.binary === "gst" ? "gst-launch-1.0" : "ffmpeg";
  if (commandExists(command)) {
    return false;
  }
  const message = `${command} is not on PATH`;
  if (process.env.CI) {
    throw new Error(`${message} (required in CI for ${entry.id})`);
  }
  console.warn(`skip ${entry.id}: ${message}`);
  ctx?.skip();
  return true;
}

export async function withExample(
  entry: CatalogEntry,
  act: (session: ExampleSession) => Promise<void>,
  ctx?: TaskContext,
) {
  if (skipMissingBinary(entry, ctx)) {
    return;
  }

  const workDir = mkdtempSync(path.join(os.tmpdir(), `werift-ex-${entry.id}-`));
  const handles: ExampleHandles = {
    pages: [],
    processes: [],
    servers: [],
    mediaPidsBefore: await listMediaPids(),
    tmpDirs: [workDir],
    udpClosers: [],
  };

  try {
    if (entry.port > 0) {
      await waitForPortFree(entry.port);
    }
    for (const extra of entry.extraGstPorts ?? []) {
      await waitForPortFree(extra);
    }

    let udpListener: { packets: number } | undefined;
    if (entry.rtpForwardPort) {
      await waitForPortFree(entry.rtpForwardPort);
      const listener = listenUdp(entry.rtpForwardPort);
      udpListener = listener;
      handles.udpClosers.push(() => listener.close());
    }

    const env = {
      ...process.env,
      WERIFT_EXAMPLE_MEDIA_PATH: fixtureWebm,
      WERIFT_EXAMPLE_OUTPUT_PATH: path.join(workDir, "rtp.webm"),
      ...entry.env,
    };

    for (const extraPort of entry.extraGstPorts ?? []) {
      handles.processes.push(spawnVideotestsrc(extraPort, workDir));
    }

    const nodeFiles = entry.node.map((relative) => examplePath(relative));
    const primary = spawnExampleTsx(nodeFiles[0], { cwd: workDir, env });
    handles.processes.push(primary);
    if (entry.waitLog !== false) {
      await waitForLog(primary, entry.waitLog ?? "start");
    }
    if (entry.port > 0) {
      await waitForPortOpen(entry.port);
    }

    let client: SpawnedProcess | undefined;
    if (nodeFiles[1]) {
      client = spawnExampleTsx(nodeFiles[1], { cwd: workDir, env });
      handles.processes.push(client);
    }

    let page: Page | undefined;
    if (entry.client !== "none" && entry.html) {
      const clientPort = await getAvailablePort();
      const htmlDir = path.dirname(examplePath(entry.html));
      const server =
        entry.client === "vite"
          ? await startViteServer({ root: htmlDir, port: clientPort })
          : await startStaticServer({
              port: clientPort,
              signalingPort: entry.port,
            });
      handles.servers.push(server);

      const opened = await openExamplePage(
        clientPageUrl(server.url, entry.html, entry.client),
        entry.port,
      );
      handles.pages.push(opened);
      page = opened.page;

      if (entry.skipIfNoAv1 && !(await supportsAv1(page))) {
        console.warn(`skip ${entry.id}: Chrome has no AV1 sender capability`);
        ctx?.skip();
        return;
      }

      if (entry.fileInput) {
        await attachFixtureFile(page, entry.fileInput);
      }
      if (entry.id === "interop-browser") {
        await page.locator("#signalingUrl").fill("http://127.0.0.1:8080/offer");
      }
      if (entry.click) {
        await clickNamedButton(page, entry.click);
      }
      if (entry.id === "pubsub") {
        const subscribe = page
          .getByRole("button", { name: "subscribe" })
          .first();
        await subscribe.waitFor({ state: "visible", timeout: 20_000 });
        await subscribe.click();
      }
    }

    const session: ExampleSession = {
      entry,
      page,
      processes: handles.processes,
      workDir,
      udpListener,
      mediaPids: new Set(),
    };

    const exitGuards = expectsProcessExit(entry)
      ? []
      : handles.processes.map((spawned) => watchUnexpectedExit(spawned));
    const throwIfCrashed = () => {
      for (const guard of exitGuards) {
        guard.throwIfExited();
      }
      for (const spawned of handles.processes) {
        assertNoFatalLogs(spawned);
      }
    };

    if (needsMediaChild(entry)) {
      session.mediaPids = await waitForMediaPids(handles.processes, {
        before: handles.mediaPidsBefore,
      });
      await assertMediaPidsAlive(session.mediaPids);
    }
    throwIfCrashed();
    await act(session);
    throwIfCrashed();
  } finally {
    await cleanupExample(handles);
  }
}
