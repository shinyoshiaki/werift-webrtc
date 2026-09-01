import { createSocket } from "node:dgram";
import { readdirSync, statSync } from "node:fs";
import path from "node:path";
import type { Page } from "playwright";
import { expect } from "vitest";

import type { SpawnedProcess } from "./spawnExample.js";

const POLL_MS = 200;

async function waitUntil(
  predicate: () => Promise<boolean> | boolean,
  timeoutMs: number,
  message: string | (() => string),
) {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await predicate()) {
        return;
      }
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
  const text = typeof message === "function" ? message() : message;
  throw new Error(
    lastError ? `${text}: ${String(lastError)}` : text,
  );
}

export async function waitPeerConnected(
  page: Page,
  timeoutMs = 25_000,
  serverLogs?: () => string,
) {
  let snapshot = "";
  await waitUntil(
    async () => {
      const info = await page.evaluate(() => {
        const pc = (window as unknown as { rtc?: RTCPeerConnection }).rtc;
        return {
          hasRtc: Boolean(pc),
          connectionState: pc?.connectionState,
          iceConnectionState: pc?.iceConnectionState,
        };
      });
      snapshot = `url=${page.url()} rtc=${JSON.stringify(info)}`;
      if (
        info.connectionState === "connected" ||
        info.iceConnectionState === "connected" ||
        info.iceConnectionState === "completed"
      ) {
        return true;
      }
      return serverLogs
        ? /connection state connected|iceConnectionStateChange connected|ice connection state connected|ice connection state completed|\bconnected\b/i.test(
            serverLogs(),
          )
        : false;
    },
    timeoutMs,
    () => `peer did not become connected (${snapshot})`,
  );
}

export async function waitWeriftRtp(serverLogs: () => string, timeoutMs = 25_000) {
  await waitUntil(
    () => /on keyframe/i.test(serverLogs()),
    timeoutMs,
    "werift did not log inbound RTP",
  );
}

export function listenUdp(port: number) {
  const sock = createSocket("udp4");
  let packets = 0;
  sock.bind(port, "127.0.0.1");
  sock.on("message", () => {
    packets += 1;
  });
  return {
    get packets() {
      return packets;
    },
    close: () =>
      new Promise<void>((resolve) => {
        sock.close(() => resolve());
      }),
  };
}

export async function waitUdpPackets(
  listener: { packets: number },
  timeoutMs = 25_000,
) {
  await waitUntil(
    () => listener.packets > 0,
    timeoutMs,
    "no RTP forwarded to the harness UDP socket",
  );
}

export async function waitInboundRtp(page: Page, timeoutMs = 25_000) {
  await waitUntil(async () => {
    const received = await page.evaluate(async () => {
      const pc = (window as unknown as { rtc?: RTCPeerConnection }).rtc;
      if (!pc) {
        return 0;
      }
      const stats = await pc.getStats();
      let packets = 0;
      stats.forEach((report) => {
        if (
          report.type === "inbound-rtp" &&
          typeof report.packetsReceived === "number"
        ) {
          packets += report.packetsReceived;
        }
      });
      return packets;
    });
    return received > 0;
  }, timeoutMs, "inbound RTP packetsReceived stayed 0");
}

export async function waitDataChannelRoundtrip(
  page: Page,
  timeoutMs = 25_000,
  serverLogs?: () => string,
) {
  let snapshot = "";
  await waitUntil(async () => {
    const hooked = await page.evaluate(() => {
      const bag = (
        window as unknown as {
          __weriftE2e?: { dcMessages: string[]; dcStates: string[] };
        }
      ).__weriftE2e;
      if (!bag) {
        return { ok: false, detail: "no-bag" };
      }
      const ping = bag.dcMessages.some((text) => /ping/i.test(text));
      const pong = bag.dcMessages.some((text) => /pong/i.test(text));
      return {
        ok: ping && pong,
        detail: JSON.stringify({
          states: bag.dcStates,
          messages: bag.dcMessages.slice(-8),
        }),
      };
    });
    const body = (await page.locator("body").innerText()).toLowerCase();
    const url = page.url();
    snapshot = `url=${url} hooked=${hooked.detail} body=${body.slice(0, 300)}`;
    if (hooked.ok) {
      return true;
    }
    const browserSaw = body.includes("pong") || body.includes("ping");
    const serverSaw = serverLogs ? /ping|pong/i.test(serverLogs()) : true;
    return browserSaw && serverSaw;
  }, timeoutMs, () => `datachannel ping/pong roundtrip not observed (${snapshot})`);
}

export async function waitDataChannelClosed(
  page: Page,
  timeoutMs = 25_000,
  serverLogs?: () => string,
) {
  await waitUntil(async () => {
    const hooked = await page.evaluate(() => {
      const bag = (
        window as unknown as { __weriftE2e?: { dcStates: string[] } }
      ).__weriftE2e;
      return Boolean(
        bag?.dcStates.includes("closed") || bag?.dcStates.includes("closing"),
      );
    });
    if (hooked) {
      return true;
    }
    return serverLogs
      ? /dc\.state (closing|closed)/i.test(serverLogs())
      : false;
  }, timeoutMs, "datachannel did not reach closing/closed");
}

export async function waitPeerClosed(
  page: Page,
  timeoutMs = 25_000,
  serverLogs?: () => string,
) {
  await waitUntil(async () => {
    const hooked = await page.evaluate(() => {
      const pc = (window as unknown as { rtc?: RTCPeerConnection }).rtc;
      if (!pc) {
        return false;
      }
      return (
        pc.connectionState === "closed" ||
        pc.connectionState === "disconnected" ||
        pc.iceConnectionState === "closed" ||
        pc.iceConnectionState === "disconnected"
      );
    });
    if (hooked) {
      return true;
    }
    return serverLogs
      ? /iceConnectionStateChange closed|connectionStateChange closed/i.test(
          serverLogs(),
        )
      : false;
  }, timeoutMs, "peer connection did not close");
}

export async function waitNonEmptyOutput(
  directory: string,
  glob: string,
  timeoutMs = 30_000,
) {
  await waitUntil(() => {
    if (!existsDir(directory)) {
      return false;
    }
    return listOutputFiles(directory, glob).some((file) => {
      try {
        return statSync(file).size > 0;
      } catch {
        return false;
      }
    });
  }, timeoutMs, `no non-empty output matching ${glob} in ${directory}`);
}

function existsDir(directory: string) {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

export function listOutputFiles(directory: string, glob: string) {
  const names = readdirSync(directory);
  if (!glob.includes("*")) {
    return names
      .filter((name) => name === glob)
      .map((name) => path.join(directory, name));
  }
  const [prefix, suffix] = glob.split("*");
  return names
    .filter((name) => name.startsWith(prefix) && name.endsWith(suffix ?? ""))
    .map((name) => path.join(directory, name));
}

export async function waitSpawnedExit(
  spawned: SpawnedProcess,
  expectedCode = 0,
  timeoutMs = 40_000,
) {
  const result = await Promise.race([
    spawned.waitForExit(),
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error(`process did not exit in time\n${spawned.logs.slice(-2_000)}`)),
        timeoutMs,
      ),
    ),
  ]);
  expect(result.code, spawned.logs.slice(-2_000)).toBe(expectedCode);
}