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
  commandExists,
  getAvailablePort,
  listMediaPids,
  spawnExampleTsx,
  spawnVideotestsrc,
  type SpawnedProcess,
  waitForLog,
  waitForPortFree,
  waitForPortOpen,
} from "./spawnExample.js";
import {
  waitDataChannelClosed,
  waitDataChannelRoundtrip,
  waitInboundRtp,
  waitNonEmptyOutput,
  waitPeerClosed,
  waitPeerConnected,
  waitSpawnedExit,
  waitUdpPackets,
  waitWeriftRtp,
  listenUdp,
} from "./waitPeer.js";

export type ExampleSession = {
  entry: CatalogEntry;
  page?: Page;
  processes: SpawnedProcess[];
  workDir: string;
  udpListener?: { packets: number };
};

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
    };

    if (
      entry.kind === "process-exit" ||
      (entry.kind === "node-gst" && entry.expectExit != null)
    ) {
      const exiting = client ?? primary;
      await waitSpawnedExit(exiting, entry.expectExit ?? 0);
      return;
    }

    await act(session);
  } finally {
    await cleanupExample(handles);
  }
}

export async function assertCatalogEntry(
  entry: CatalogEntry,
  session: ExampleSession,
  ctx?: TaskContext,
) {
  const page = session.page;
  const primary = session.processes[0];

  switch (entry.kind) {
    case "datachannel": {
      if (!page) throw new Error("page required");
      // Act: HTML がマウント直後にシグナリングし DataChannel を開くのを待つ
      // Assert: readyState=open のあと ping/pong が少なくとも 1 往復している
      await waitDataChannelRoundtrip(page, 25_000, () => primary?.logs ?? "");
      break;
    }
    case "media-inbound": {
      if (!page) throw new Error("page required");
      try {
        // Act: ICE 接続と受信 RTP を待つ（画質や video.play 完了は必須にしない）
        await waitPeerConnected(page, 25_000, () => primary?.logs ?? "");
      } catch (error) {
        if (entry.skipIfNoAv1) {
          console.warn(`skip ${entry.id}: AV1 did not connect`);
          ctx?.skip();
          return;
        }
        throw error;
      }
      if (entry.inbound === "werift") {
        if (session.udpListener) {
          await waitUdpPackets(session.udpListener);
        } else if (entry.outputGlob) {
          await waitNonEmptyOutput(
            session.workDir,
            entry.outputGlob,
            20_000,
          );
        } else {
          // Assert: werift 側が RTP を受けた（codec の keyframe ログなど）
          await waitWeriftRtp(() => primary?.logs ?? "");
        }
      } else {
        // Assert: connectionState が connected かつ inbound-rtp の packetsReceived > 0
        await waitInboundRtp(page);
      }
      break;
    }
    case "media-record": {
      if (page) {
        try {
          await waitPeerConnected(page);
        } catch {
          if (entry.skipIfNoAv1) {
            console.warn(`skip ${entry.id}: AV1 did not connect`);
            ctx?.skip();
            return;
          }
        }
      }
      if (primary) {
        await waitForLog(primary, "stop", (entry.recordWaitMs ?? 15_000) + 10_000).catch(
          () => undefined,
        );
      }
      if (entry.outputGlob) {
        try {
          // Assert: 録画ファイルが空でないこと
          await waitNonEmptyOutput(
            session.workDir,
            entry.outputGlob,
            10_000,
          );
        } catch (error) {
          if (entry.skipIfNoAv1) {
            console.warn(`skip ${entry.id}: AV1 recording was empty`);
            ctx?.skip();
            return;
          }
          throw error;
        }
      }
      break;
    }
    case "close-dc": {
      if (!page) throw new Error("page required");
      // Act: デモが DC を閉じるまで待つ
      await waitDataChannelClosed(page, 25_000, () => primary?.logs ?? "");
      break;
    }
    case "close-pc": {
      if (!page) throw new Error("page required");
      // Act: デモが PeerConnection を閉じるまで待つ
      await waitPeerClosed(page, 25_000, () => primary?.logs ?? "");
      break;
    }
    case "ice-restart": {
      if (!page) throw new Error("page required");
      // Act: 初回接続のあと restart ボタンを押し、再接続を待つ
      await waitPeerConnected(page, 25_000, () => primary?.logs ?? "");
      await waitInboundRtp(page);
      await clickNamedButton(page, "restart");
      // Assert: restart 後も connected に戻る
      await waitPeerConnected(page, 25_000, () => primary?.logs ?? "");
      break;
    }
    case "node-gst": {
      if (entry.outputGlob) {
        if (primary) {
          await waitForLog(primary, "stop", (entry.recordWaitMs ?? 8_000) + 5_000).catch(
            () => undefined,
          );
        }
        await waitNonEmptyOutput(
          session.workDir,
          entry.outputGlob,
          10_000,
        );
      }
      break;
    }
    default:
      break;
  }
}
