import {
  AbortChunk,
  ShutdownChunk,
  parsePacket,
} from "../../../sctp/src/chunk";
import { RTCPeerConnection } from "../../src";
import type { RTCDataChannel } from "../../src/dataChannel";
import { createDataChannelPair } from "../utils";

type CloseSequenceEvent = "abort" | "shutdown" | "ice-close";

type InstrumentedPair = {
  local: RTCPeerConnection;
  remote: RTCPeerConnection;
  localChannel: RTCDataChannel;
  remoteChannel: RTCDataChannel;
  events: CloseSequenceEvent[];
  receivedChunkTypes: number[];
  waitForRemoteAbort: () => Promise<void>;
};

async function createInstrumentedPair(options?: {
  bundlePolicy?: "max-bundle";
  withAudio?: boolean;
}): Promise<InstrumentedPair> {
  const local = new RTCPeerConnection({
    bundlePolicy: options?.bundlePolicy,
  });
  const remote = new RTCPeerConnection({
    bundlePolicy: options?.bundlePolicy,
  });

  if (options?.withAudio) {
    local.addTransceiver("audio", { direction: "sendrecv" });
  }

  const [localChannel, remoteChannel] = await createDataChannelPair(
    {},
    local,
    remote,
  );

  const events: CloseSequenceEvent[] = [];
  const receivedChunkTypes: number[] = [];

  const localSctp = local.sctpTransport?.sctp;
  const iceConnection =
    local.sctpTransport?.dtlsTransport.iceTransport.connection;
  const remoteDtls = remote.sctpTransport?.dtlsTransport;
  if (!localSctp || !iceConnection || !remoteDtls) {
    await Promise.allSettled([local.close(), remote.close()]);
    throw new Error("SCTP/ICE が DataChannel 確立後に存在しない");
  }

  const originalSendChunk = localSctp.sendChunk.bind(localSctp);
  localSctp.sendChunk = async (chunk) => {
    recordOutboundChunk(events, chunk.type);
    return originalSendChunk(chunk);
  };

  const originalTransportSend = localSctp.transport.send.bind(
    localSctp.transport,
  );
  localSctp.transport.send = async (data: Buffer) => {
    try {
      const [, , , chunks] = parsePacket(data);
      for (const chunk of chunks) {
        recordOutboundChunk(events, chunk.type);
      }
    } catch {
      // DTLS 上の非 SCTP は無視する
    }
    return originalTransportSend(data);
  };

  const remoteDtlsSocket = remoteDtls.dtls;
  if (!remoteDtlsSocket) {
    await Promise.allSettled([local.close(), remote.close()]);
    throw new Error("remote DTLS socket が DataChannel 確立後に存在しない");
  }

  const originalIceClose = iceConnection.close.bind(iceConnection);
  iceConnection.close = async () => {
    events.push("ice-close");
    return originalIceClose();
  };

  let resolveAbort!: () => void;
  const abortReceived = new Promise<void>((resolve) => {
    resolveAbort = resolve;
  });
  remoteDtlsSocket.onData.subscribe((buf) => {
    try {
      const [, , , chunks] = parsePacket(buf);
      for (const chunk of chunks) {
        receivedChunkTypes.push(chunk.type);
        if (chunk.type === AbortChunk.type) {
          resolveAbort();
        }
      }
    } catch {
      // SCTP 以外の DTLS アプリデータは無視する
    }
  });

  return {
    local,
    remote,
    localChannel,
    remoteChannel,
    events,
    receivedChunkTypes,
    waitForRemoteAbort: () =>
      waitForRemoteAbort(abortReceived, receivedChunkTypes, events),
  };
}

function recordOutboundChunk(events: CloseSequenceEvent[], type: number) {
  if (type === AbortChunk.type && !events.includes("abort")) {
    events.push("abort");
  }
  if (type === ShutdownChunk.type && !events.includes("shutdown")) {
    events.push("shutdown");
  }
}

async function waitForRemoteAbort(
  abortReceived: Promise<void>,
  receivedChunkTypes: number[],
  events: CloseSequenceEvent[],
  timeoutMs = 5_000,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(
        new Error(
          `remote が AbortChunk を ${timeoutMs}ms 以内に受信しなかった (受信 chunk types: [${receivedChunkTypes.join(", ")}], local events: [${events.join(", ")}])`,
        ),
      );
    }, timeoutMs);
  });
  try {
    await Promise.race([abortReceived, timeout]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

function assertAbortBeforeIceClose(events: CloseSequenceEvent[]) {
  const abortIndex = events.indexOf("abort");
  const iceCloseIndex = events.indexOf("ice-close");
  expect(abortIndex).toBeGreaterThanOrEqual(0);
  expect(iceCloseIndex).toBeGreaterThanOrEqual(0);
  expect(abortIndex).toBeLessThan(iceCloseIndex);
  expect(events).not.toContain("shutdown");
}

describe("https://github.com/shinyoshiaki/werift-webrtc/issues/681", () => {
  test("DataChannel 確立後の pc.close() は ICE close より先に AbortChunk を送る", async () => {
    const pair = await createInstrumentedPair();
    try {
      // 実行: DataChannel 確立済みの local だけを close する
      const abortWait = pair.waitForRemoteAbort();
      await pair.local.close();

      // 検証: リモートが AbortChunk を受け取り、その送信は local ICE close より前
      await abortWait;
      expect(pair.receivedChunkTypes).toContain(AbortChunk.type);
      assertAbortBeforeIceClose(pair.events);
    } finally {
      await pair.remote.close();
    }
  }, 15_000);

  test("max-bundle でメディアと SCTP が同一 DTLS を共有しても AbortChunk を先に送る", async () => {
    const pair = await createInstrumentedPair({
      bundlePolicy: "max-bundle",
      withAudio: true,
    });
    try {
      const audioTransceiver = pair.local
        .getTransceivers()
        .find((transceiver) => transceiver.kind === "audio");

      // 検証: audio と DataChannel が同一 DTLS/ICE を共有している
      expect(audioTransceiver?.dtlsTransport.id).toBe(
        pair.local.sctpTransport!.dtlsTransport.id,
      );

      // 実行: 共有トランスポート上で local を close する
      const abortWait = pair.waitForRemoteAbort();
      await pair.local.close();

      // 検証: 共有 DTLS でも ABORT が ICE close より先にリモートへ届く
      await abortWait;
      expect(pair.receivedChunkTypes).toContain(AbortChunk.type);
      assertAbortBeforeIceClose(pair.events);
    } finally {
      await pair.remote.close();
    }
  }, 15_000);

  test("pc.close() は SHUTDOWN ではなく ABORT であり未送信アプリメッセージの到達を保証しない", async () => {
    const pair = await createInstrumentedPair();
    try {
      // 実行: 到達待ちせずに send した直後へ close する（graceful flush ではない）
      const abortWait = pair.waitForRemoteAbort();
      pair.localChannel.send("bye");
      await pair.local.close();

      // 検証: close 経路は AbortChunk であり ShutdownChunk ではない。
      // "bye" の到達は保証対象外なので assert しない。
      await abortWait;
      expect(pair.receivedChunkTypes).toContain(AbortChunk.type);
      expect(pair.receivedChunkTypes).not.toContain(ShutdownChunk.type);
      assertAbortBeforeIceClose(pair.events);
    } finally {
      await pair.remote.close();
    }
  }, 15_000);
});
