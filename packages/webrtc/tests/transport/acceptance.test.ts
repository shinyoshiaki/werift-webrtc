import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { IceGatheringErrorReason, type RTCPeerConnection } from "../../src";
import {
  createGatheringRecordingPeer,
  reasonsOf,
  stubNetworkInterfaces,
  trackUncaught,
  withRemoteMdnsCandidate,
} from "./iceGatheringErrorUtils";

/**
 * Acceptance test of ticket 2f1fa505: where `os.networkInterfaces()` throws
 * (systemd `RestrictAddressFamilies=` denying `AF_NETLINK`), a peer
 * connection no longer crashes the process or hangs in "gathering": the
 * gathering completes, the failure is reported by `onIceGatheringError`, and
 * a connection on an explicit interface address still carries data.
 * Real sockets on 127.0.0.1; only `os.networkInterfaces()` is stubbed.
 */

const { interfaceEnumerationFailed, noCandidates } = IceGatheringErrorReason;
let os: ReturnType<typeof stubNetworkInterfaces>;
let crash: ReturnType<typeof trackUncaught>;
const peers: RTCPeerConnection[] = [];
const createPeer = (
  config: Parameters<typeof createGatheringRecordingPeer>[0] = {},
) => {
  const recording = createGatheringRecordingPeer(config);
  peers.push(recording.pc);
  return recording;
};

beforeEach(() => {
  os = stubNetworkInterfaces();
  crash = trackUncaught();
});
afterEach(async () => {
  for (const pc of peers.splice(0)) await pc.close();
  os.restore();
  crash.dispose();
});

describe("acceptance: a failing os.networkInterfaces() neither crashes nor hangs the gathering", () => {
  test.each([
    {
      mode: "候補の取得元なし",
      config: {},
      candidates: [],
      reasons: [interfaceEnumerationFailed, noCandidates],
    },
    {
      mode: "iceInterfaceAddresses 指定",
      config: { iceInterfaceAddresses: { udp4: "127.0.0.1" } },
      candidates: ["127.0.0.1"],
      reasons: [interfaceEnumerationFailed],
    },
  ])(
    "($mode) 2.1・2.3・6章: gathering は complete に達し、失敗が onIceGatheringError で届く",
    async ({ config, candidates, reasons }) => {
      const recording = createPeer(config);
      const { pc } = recording;
      pc.addTransceiver("audio");

      // Act: 列挙が throw する状態で offer を適用する。
      await pc.setLocalDescription(await pc.createOffer());

      // Assert: gathering は "gathering" で止まらず complete になり、end-of-candidates が届く。
      await vi.waitFor(() => expect(pc.iceGatheringState).toBe("complete"), {
        timeout: 3000,
      });
      expect(
        recording.candidates.map(
          (candidate) => candidate?.candidate.split(" ")[4],
        ),
      ).toEqual([...candidates, undefined]);
      // Assert: 失敗は transport 付きの onIceGatheringError で届き、icecandidateerror には混ざらない。
      expect(reasonsOf(recording.gatheringErrors)).toEqual(reasons);
      expect(recording.gatheringErrors[0].iceTransport).toBe(
        pc.iceTransports[0],
      );
      expect(recording.candidateErrors).toEqual([]);
    },
  );

  test("2.1・2.2・6章: 列挙できなくても明示アドレスで接続してデータが届き、リモートの .local 候補でもプロセスは落ちない", async () => {
    const config = { iceInterfaceAddresses: { udp4: "127.0.0.1" } };
    const offerer = createPeer(config).pc;
    const answerer = createPeer(config).pc;
    const sent = offerer.createDataChannel("acceptance");
    const received = new Promise<string>((resolve) => {
      answerer.onDataChannel.subscribe((channel) =>
        channel.onMessage.subscribe((data) => resolve(data.toString())),
      );
    });

    // Act: 列挙が throw する状態で offer / answer を交換する。offer にはブラウザが
    // 送るような .local の候補を入れ、answerer に mDNS で解決させる。
    await offerer.setLocalDescription(await offerer.createOffer());
    await answerer.setRemoteDescription(
      withRemoteMdnsCandidate(offerer.localDescription!),
    );
    await answerer.setLocalDescription(await answerer.createAnswer());
    await offerer.setRemoteDescription(answerer.localDescription!);

    // Assert: 接続が完了し、データチャネルでメッセージが届く。
    await vi.waitFor(() => expect(sent.readyState).toBe("open"), {
      timeout: 5000,
    });
    sent.send("hello");
    await expect(received).resolves.toBe("hello");
    expect(offerer.connectionState).toBe("connected");
    // Assert: その間、mDNS を含めて uncaughtException / unhandledRejection は起きていない。
    expect(crash.uncaught).toEqual([]);
  });
});
