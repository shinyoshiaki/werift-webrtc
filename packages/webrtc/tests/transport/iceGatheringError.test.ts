import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { createSilentUdpServer } from "../../../ice/tests/utils";
import { IceGatheringErrorReason, type RTCPeerConnection } from "../../src";
import { RTCIceGatherer } from "../../src/transport/ice";
import {
  createFixedMappingStunServer,
  createGatheringRecordingPeer,
  gatheringComplete,
  offerAndGather,
  reasonsOf,
  recordTransportGatheringErrors,
  stubNetworkInterfaces,
  trackUncaught,
} from "./iceGatheringErrorUtils";

const { interfaceEnumerationFailed, noCandidates, gatheringFailed } =
  IceGatheringErrorReason;

// os.networkInterfaces() は各テストで stub する（既定は throw）。
let os: ReturnType<typeof stubNetworkInterfaces>;
let crash: ReturnType<typeof trackUncaught>;
const peers: RTCPeerConnection[] = [];
const cleanups: (() => Promise<void>)[] = [];

/** A recording peer closed after the test. */
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
  for (const cleanup of cleanups.splice(0)) await cleanup();
  os.restore();
  crash.dispose();
  vi.restoreAllMocks();
});

describe("RTCPeerConnection.onIceGatheringError when os.networkInterfaces() throws", () => {
  test("without STUN / TURN: gathering completes with end-of-candidates and both reasons are reported", async () => {
    const { pc, gatheringErrors, candidateErrors, candidates } = createPeer();

    // Act: 列挙が失敗する状態で offer を適用する。
    await offerAndGather(pc);

    // Assert: setLocalDescription は成功し、gathering は complete で end-of-candidates が届く。
    expect(pc.localDescription?.type).toBe("offer");
    expect(pc.iceGatheringState).toBe("complete");
    expect(candidates).toEqual([undefined]);
    // Assert: transport 付きで 2 つの理由が通知され、icecandidateerror は出ない。
    const [transport] = pc.iceTransports;
    expect(reasonsOf(gatheringErrors)).toEqual([
      interfaceEnumerationFailed,
      noCandidates,
    ]);
    expect(gatheringErrors[0].iceTransport).toBe(transport);
    expect(gatheringErrors[0].cause).toBe(os.error);
    expect(gatheringErrors[0]).not.toHaveProperty("generation");
    expect(candidateErrors).toEqual([]);
    expect(crash.uncaught).toEqual([]);
  });

  test("RTCIceTransport.onGatheringError reports the same reasons", async () => {
    const { pc } = createPeer();
    pc.addTransceiver("audio");
    await pc.setLocalDescription(await pc.createOffer());
    // 2 回目の offer は同じ transport を使い、gathering はやり直さない。
    const errors = recordTransportGatheringErrors(pc.iceTransports[0]);
    pc.restartIce();

    // Act: ICE restart の offer で新世代を収集する。
    await offerAndGather(pc);

    // Assert: transport にも新世代の理由が届く。
    expect(reasonsOf(errors)).toEqual([
      interfaceEnumerationFailed,
      noCandidates,
    ]);
  });

  test("a reachable STUN server gives a server-reflexive candidate and only interface-enumeration-failed", async () => {
    const stun = await createFixedMappingStunServer("127.0.0.1", [
      "203.0.113.5",
      40000,
    ]);
    cleanups.push(stun.close);
    const { pc, gatheringErrors, candidateErrors, candidates } = createPeer({
      iceServers: [{ urls: `stun:127.0.0.1:${stun.address[1]}` }],
    });

    // Act: STUN ありで offer を適用する。
    await offerAndGather(pc);

    // Assert: srflx が得られ、no-candidates も icecandidateerror も出ない。
    expect(
      candidates.map(
        (candidate) => candidate?.candidate.match(/typ (\w+)/)?.[1],
      ),
    ).toEqual(["srflx", undefined]);
    expect(reasonsOf(gatheringErrors)).toEqual([interfaceEnumerationFailed]);
    expect(candidateErrors).toEqual([]);
  });

  test("an unreachable STUN server still gives only its 701 as icecandidateerror", async () => {
    const silent = await createSilentUdpServer();
    cleanups.push(silent.close);
    const url = `stun:127.0.0.1:${silent.address[1]}`;
    const { pc, gatheringErrors, candidateErrors } = createPeer({
      iceServers: [{ urls: url }],
      iceStunGatherTimeout: 0.3,
    });

    // Act: 届かない STUN ありで offer を適用する。
    await offerAndGather(pc);

    // Assert: icecandidateerror は 701 だけ（3 経路に同じイベント）で、列挙失敗は含まれない。
    expect(
      candidateErrors.map(({ url, errorCode }) => [url, errorCode]),
    ).toEqual([
      [url, 701],
      [url, 701],
      [url, 701],
    ]);
    // Assert: 列挙失敗と候補 0 個は onIceGatheringError で通知される。
    expect(reasonsOf(gatheringErrors)).toEqual([
      interfaceEnumerationFailed,
      noCandidates,
    ]);
  });

  test("without BUNDLE each transport reports its own errors", async () => {
    const { pc, gatheringErrors } = createPeer({ bundlePolicy: "disable" });
    pc.addTransceiver("audio");
    pc.addTransceiver("video");

    // Act: transport 2 個で offer を適用する。
    await offerAndGather(pc);

    // Assert: transport ごとに 1 回ずつ（重複排除しない）。
    expect(pc.iceTransports).toHaveLength(2);
    for (const transport of pc.iceTransports) {
      expect(
        reasonsOf(
          gatheringErrors.filter((event) => event.iceTransport === transport),
        ),
      ).toEqual([interfaceEnumerationFailed, noCandidates]);
    }
  });

  test("nothing is reported after close", async () => {
    const silent = await createSilentUdpServer();
    cleanups.push(silent.close);
    const { pc, gatheringErrors } = createPeer({
      iceServers: [{ urls: `stun:127.0.0.1:${silent.address[1]}` }],
      iceStunGatherTimeout: 0.3,
    });
    pc.addTransceiver("audio");
    const enumerationFailed = pc.onIceGatheringError.asPromise();
    const applying = pc.setLocalDescription(await pc.createOffer());
    await enumerationFailed;

    // Act: STUN の応答を待つ gathering の途中で close し、timeout を過ぎるまで待つ。
    await pc.close();
    await applying.catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, 500));

    // Assert: close 前の列挙失敗だけで、close 後の no-candidates は出ない。
    expect(reasonsOf(gatheringErrors)).toEqual([interfaceEnumerationFailed]);
  });

  test("a transport a rollback discards (pending only) reports nothing", async () => {
    const { pc, gatheringErrors } = createPeer();
    pc.addTransceiver("audio");
    const [transport] = pc.iceTransports;
    const transportErrors = recordTransportGatheringErrors(transport);
    // Arrange: rollback で破棄される（pending description だけが使う）transport とみなす。
    const { negotiation } = pc as unknown as {
      negotiation: { isPendingOnlyTransport: (id: string) => boolean };
    };
    vi.spyOn(negotiation, "isPendingOnlyTransport").mockImplementation(
      (id) => id === transport.id,
    );

    // Act: その transport で gathering する。
    await offerAndGather(pc);

    // Assert: transport では通知されるが、RTCPeerConnection からは通知されない。
    expect(reasonsOf(transportErrors)).toEqual([
      interfaceEnumerationFailed,
      noCandidates,
    ]);
    expect(gatheringErrors).toEqual([]);
    expect(crash.uncaught).toEqual([]);
  });
});

describe("a gatherCandidates() that rejects", () => {
  test("of an ICE agent without onGatheringError: gathering-failed is reported and the gathering completes", async () => {
    // Arrange: onGatheringError を持たない IceConnection 実装に差し替える。
    os.succeed();
    const gatherer = new RTCIceGatherer({ useIpv6: false });
    const failure = new Error("gather failed");
    const fake = {
      generation: 0,
      state: "new",
      localCandidatesEnd: false,
      gatherCandidates: () => Promise.reject(failure),
    };
    Object.defineProperty(gatherer, "connection", { value: fake });
    const details: unknown[] = [];
    gatherer.onGatheringError = (error) => details.push(error);
    const ended: unknown[] = [];
    gatherer.onIceCandidate = (candidate) => ended.push(candidate);

    // Act: gather する。
    const gathering = gatherer.gather();

    // Assert: reject は呼び出し元へ届き、gathering-failed と end-of-candidates の後に complete になる。
    await expect(gathering).rejects.toBe(failure);
    expect(details).toEqual([
      {
        reason: gatheringFailed,
        errorText: "gathering failed: gather failed",
        cause: failure,
      },
    ]);
    expect(ended).toEqual([undefined]);
    expect(gatherer.gatheringState).toBe("complete");
  });

  test("of an agent restarted by the gathering-failed listener: the new generation is not completed", async () => {
    // Arrange: 通知リスナーの中で世代が進む IceConnection 実装にする。
    os.succeed();
    const gatherer = new RTCIceGatherer({ useIpv6: false });
    const failure = new Error("gather failed");
    const fake = {
      generation: 0,
      state: "new",
      localCandidatesEnd: false,
      gatherCandidates: () => Promise.reject(failure),
    };
    Object.defineProperty(gatherer, "connection", { value: fake });
    const ended: unknown[] = [];
    gatherer.onIceCandidate = (candidate) => ended.push(candidate);
    const states: string[] = [];
    gatherer.onGatheringError = () => {
      // ICE restart 相当: 世代が進み、gathering は新世代で未開始になる。
      fake.generation += 1;
      states.push(gatherer.gatheringState);
    };

    // Act: gather する（通知中に restart される）。
    await expect(gatherer.gather()).rejects.toBe(failure);

    // Assert: 古い世代の end-of-candidates は送られず、新世代の状態は上書きされない。
    expect(ended).toEqual([]);
    expect(gatherer.gatheringState).toBe(states[0]);
    expect(gatherer.gatheringState).not.toBe("complete");
  });

  test("a throwing transport onGatheringError listener does not stop the later ones", async () => {
    os.succeed();
    const { pc } = createPeer();
    pc.addTransceiver("audio");
    for (const transport of pc.iceTransports) {
      vi.spyOn(transport.connection, "gatherCandidates").mockRejectedValue(
        new Error("gather failed"),
      );
    }
    const later: unknown[] = [];
    for (const transport of pc.iceTransports) {
      transport.onGatheringError.subscribe(() => {
        throw new Error("listener failed");
      });
      transport.onGatheringError.subscribe((details) => later.push(details));
    }

    // Act: 収集失敗を通知させる。
    await pc.setLocalDescription(await pc.createOffer());
    await gatheringComplete(pc);

    // Assert: 先のリスナーが throw しても後続リスナーに届く。
    expect(later.length).toBeGreaterThan(0);
    expect(crash.uncaught).toEqual([]);
  });

  test("of a mocked agent: setLocalDescription succeeds and iceGatheringState reaches complete", async () => {
    os.succeed();
    const { pc, gatheringErrors, candidates } = createPeer();
    pc.addTransceiver("audio");
    const failure = new Error("gather failed");
    for (const transport of pc.iceTransports) {
      vi.spyOn(transport.connection, "gatherCandidates").mockRejectedValue(
        failure,
      );
    }

    // Act: offer を適用する。
    await pc.setLocalDescription(await pc.createOffer());
    await gatheringComplete(pc);

    // Assert: SLD は成功し、gathering-failed が 1 回だけ通知されて end-of-candidates が届く。
    expect(reasonsOf(gatheringErrors)).toEqual([gatheringFailed]);
    expect(gatheringErrors[0].cause).toBe(failure);
    expect(candidates).toEqual([undefined]);
    expect(crash.uncaught).toEqual([]);
  });

  test("of an agent that reported gathering-failed itself: it is not reported twice", async () => {
    os.succeed();
    const { pc, gatheringErrors } = createPeer();
    pc.addTransceiver("audio");
    const failure = new Error("unexpected");
    for (const transport of pc.iceTransports) {
      const { gatherer } = transport.connection as unknown as {
        gatherer: { candidatePromises: () => unknown };
      };
      vi.spyOn(gatherer, "candidatePromises").mockImplementation(() => {
        throw failure;
      });
    }

    // Act: ICE 層の gathering の同期部分で例外を起こす。
    await pc.setLocalDescription(await pc.createOffer());
    await gatheringComplete(pc);

    // Assert: ICE 層の gathering-failed → no-candidates だけで、二重通知はない。
    expect(reasonsOf(gatheringErrors)).toEqual([gatheringFailed, noCandidates]);
  });
});

describe("remote mDNS candidates when os.networkInterfaces() throws", () => {
  test("a remote .local candidate does not crash the peer connection", async () => {
    os.succeed();
    const offerer = createPeer().pc;
    const answerer = createPeer().pc;
    offerer.addTransceiver("audio");
    await offerer.setLocalDescription(await offerer.createOffer());
    await answerer.setRemoteDescription(offerer.localDescription!);
    await answerer.setLocalDescription(await answerer.createAnswer());
    os.fail();

    // Act: 列挙が失敗する状態で .local の候補を受け取る。
    await answerer.addIceCandidate({
      candidate:
        "candidate:1 1 udp 2130706431 0c3f1d2e-7f1a-4bd1-9f3e-4d8b2a1c9e7f.local 50000 typ host",
      sdpMid: offerer.localDescription!.sdp.match(/a=mid:(\S+)/)![1],
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    // Assert: .local の候補は破棄され（SDP の候補だけが残る）、uncaught は起きない。
    expect(
      answerer.iceTransports[0].connection.remoteCandidates.filter(
        ({ port }) => port === 50000,
      ),
    ).toEqual([]);
    expect(crash.uncaught).toEqual([]);
  });
});
