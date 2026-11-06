import { afterAll, beforeAll, describe, expect, test, vi } from "vitest";

import { type PeerConfig, RTCPeerConnection } from "../../src";
import {
  connectPeerConnections,
  createGatheredPeers,
  createTurnRotationServers,
  firstIceTransport,
  generationCandidateLabels,
  observeConfigurationRestart,
  relatedAddressOf,
  sdpCandidateLabels,
  sdpRelayRelatedAddresses,
  waitForLocalCandidatesEnd,
} from "../utils";

/**
 * setConfiguration() after gathering → the next createOffer() restarts ICE.
 * Each row checks that the restarted generation follows the new settings in
 * every output: the restart request, the candidates of the restart offer,
 * what is trickled after the commit, the agent's options, the TURN
 * credential used and the previous TURN allocation.
 */
describe("setConfiguration → ICE restart: 設定 × 出力マトリクス", () => {
  let servers: Awaited<ReturnType<typeof createTurnRotationServers>>;
  beforeAll(async () => {
    servers = await createTurnRotationServers();
  });
  afterAll(async () => {
    await servers.close();
  });

  const tlsOptions = { rejectUnauthorized: false };

  type Row = {
    name: string;
    initial: () => Partial<PeerConfig>;
    change: () => Partial<PeerConfig>;
    expected: {
      needRestart: boolean;
      /** Candidate kinds the restart offer must carry (exactly). */
      offer?: string[];
      /** Candidate kinds that must be trickled after the commit. */
      trickledIncludes?: string[];
      /** Candidate kinds that must never appear in the new generation. */
      absent?: string[];
      options?: Record<string, unknown>;
      /** TURN usernames authenticated after the change (exactly). */
      authenticated: string[];
      staleAllocationsClosed?: boolean;
      /**
       * raddr of the relay candidates trickled and in the new generation:
       * "hidden" (0.0.0.0:9, the relay policy) or "mapped" (the address the
       * TURN server saw).
       */
      relayRelated?: "hidden" | "mapped";
    };
  };

  const rows: Row[] = [
    {
      name: "TURN A → TURN B",
      initial: () => ({ iceServers: servers.iceServers("a") }),
      change: () => ({ iceServers: servers.iceServers("b") }),
      expected: {
        needRestart: true,
        offer: ["udp/host", "udp/srflx"],
        trickledIncludes: ["udp/relay"],
        options: { turnUsername: "user-b" },
        relayRelated: "mapped",
        authenticated: ["user-b"],
        staleAllocationsClosed: true,
      },
    },
    {
      name: "TURN → STUN のみ",
      initial: () => ({ iceServers: servers.iceServers("a") }),
      change: () => ({ iceServers: servers.iceServers() }),
      expected: {
        needRestart: true,
        absent: ["udp/relay"],
        options: { turnServer: undefined, turnUsername: undefined },
        authenticated: [],
        staleAllocationsClosed: true,
      },
    },
    {
      name: "STUN のみ → TURN",
      initial: () => ({ iceServers: servers.iceServers() }),
      change: () => ({ iceServers: servers.iceServers("a") }),
      expected: {
        needRestart: true,
        offer: ["udp/host", "udp/srflx"],
        trickledIncludes: ["udp/relay"],
        options: { turnUsername: "user-a" },
        authenticated: ["user-a"],
      },
    },
    {
      name: "iceTransportPolicy all → relay",
      initial: () => ({ iceServers: servers.iceServers("a") }),
      change: () => ({ iceTransportPolicy: "relay" }),
      expected: {
        needRestart: true,
        offer: [],
        trickledIncludes: ["udp/relay"],
        absent: ["udp/host", "udp/srflx", "tcp/host"],
        options: { forceTurn: true },
        relayRelated: "hidden",
        authenticated: ["user-a"],
        staleAllocationsClosed: true,
      },
    },
    {
      name: "iceTransportPolicy relay → all",
      initial: () => ({
        iceServers: servers.iceServers("a"),
        iceTransportPolicy: "relay",
      }),
      change: () => ({ iceTransportPolicy: "all" }),
      expected: {
        needRestart: true,
        trickledIncludes: ["udp/host", "udp/srflx", "udp/relay"],
        options: { forceTurn: false },
        relayRelated: "mapped",
        authenticated: ["user-a"],
        staleAllocationsClosed: true,
      },
    },
    {
      name: "STUN のみ: iceTransportPolicy all → relay (TURN 未設定)",
      initial: () => ({ iceServers: servers.iceServers() }),
      change: () => ({ iceTransportPolicy: "relay" }),
      expected: {
        needRestart: true,
        offer: [],
        absent: ["udp/host", "udp/srflx", "tcp/host"],
        options: { forceTurn: true, turnServer: undefined },
        authenticated: [],
      },
    },
    {
      name: "relay のまま TURN → STUN のみ",
      initial: () => ({
        iceServers: servers.iceServers("a"),
        iceTransportPolicy: "relay",
      }),
      change: () => ({ iceServers: servers.iceServers() }),
      expected: {
        needRestart: true,
        offer: [],
        absent: ["udp/host", "udp/srflx", "udp/relay", "tcp/host"],
        options: { forceTurn: true, turnServer: undefined },
        authenticated: [],
        staleAllocationsClosed: true,
      },
    },
    {
      name: "iceUseTcp true → false",
      initial: () => ({ iceServers: servers.iceServers(), iceUseTcp: true }),
      change: () => ({ iceUseTcp: false }),
      expected: {
        needRestart: true,
        offer: ["udp/host", "udp/srflx"],
        absent: ["tcp/host"],
        options: { useTcp: false },
        authenticated: [],
      },
    },
    {
      name: "iceUseTcp false → true",
      initial: () => ({ iceServers: servers.iceServers() }),
      change: () => ({ iceUseTcp: true }),
      expected: {
        needRestart: true,
        trickledIncludes: ["tcp/host"],
        options: { useTcp: true },
        authenticated: [],
      },
    },
    {
      name: "turnTransport udp → tcp",
      initial: () => ({ iceServers: servers.iceServers("a") }),
      change: () => ({ turnTransport: "tcp" }),
      expected: {
        needRestart: true,
        offer: ["udp/host", "udp/srflx"],
        trickledIncludes: ["udp/relay"],
        options: { turnTransport: "tcp" },
        authenticated: ["user-a"],
        staleAllocationsClosed: true,
      },
    },
    {
      name: "turnTlsOptions 設定",
      initial: () => ({ iceServers: servers.iceServers("a") }),
      change: () => ({ turnTlsOptions: tlsOptions }),
      expected: {
        needRestart: true,
        trickledIncludes: ["udp/relay"],
        options: { turnTlsOptions: tlsOptions },
        authenticated: ["user-a"],
        staleAllocationsClosed: true,
      },
    },
    {
      name: "turnTlsOptions 解除",
      initial: () => ({
        iceServers: servers.iceServers("a"),
        turnTlsOptions: tlsOptions,
      }),
      change: () => ({ turnTlsOptions: undefined }),
      expected: {
        needRestart: true,
        trickledIncludes: ["udp/relay"],
        options: { turnTlsOptions: undefined },
        authenticated: ["user-a"],
        staleAllocationsClosed: true,
      },
    },
    {
      name: "turnUdpFamily 設定",
      initial: () => ({ iceServers: servers.iceServers("a") }),
      change: () => ({ turnUdpFamily: 4 }),
      expected: {
        needRestart: true,
        trickledIncludes: ["udp/relay"],
        options: { turnUdpFamily: 4 },
        authenticated: ["user-a"],
        staleAllocationsClosed: true,
      },
    },
    {
      name: "turnUdpFamily 解除",
      initial: () => ({
        iceServers: servers.iceServers("a"),
        turnUdpFamily: 4,
      }),
      change: () => ({ turnUdpFamily: undefined }),
      expected: {
        needRestart: true,
        trickledIncludes: ["udp/relay"],
        options: { turnUdpFamily: undefined },
        authenticated: ["user-a"],
        staleAllocationsClosed: true,
      },
    },
    {
      name: "同じ設定の再設定",
      initial: () => ({ iceServers: servers.iceServers("a") }),
      change: () => ({ iceServers: servers.iceServers("a") }),
      expected: {
        needRestart: false,
        offer: ["udp/host", "udp/relay", "udp/srflx"],
        options: { turnUsername: "user-a" },
        authenticated: [],
        staleAllocationsClosed: false,
      },
    },
  ];

  test.each(rows)(
    "$name",
    async ({ initial, change, expected }) => {
      // Act: gathering 完了後に setConfiguration し、restartIce() なしで 1 回交渉する
      const observed = await observeConfigurationRestart(
        servers,
        initial(),
        change(),
      );

      // Assert: 設定が変わったときだけ restart が要求され、実際に restart する
      expect(observed.needRestart).toBe(expected.needRestart);
      expect(observed.restarted).toBe(expected.needRestart);
      // Assert: restart offer の候補は新しい設定で gather した場合と同じ種類だけ
      if (expected.offer) expect(observed.offer).toEqual(expected.offer);
      // Assert: commit 後に新しい設定の候補が trickle される
      for (const label of expected.trickledIncludes ?? []) {
        expect(observed.trickled).toContain(label);
        expect(observed.generation).toContain(label);
      }
      // Assert: 新しい設定では出ない種類の候補は offer にも trickle にも generation にも出ない
      for (const label of expected.absent ?? []) {
        expect(observed.offer).not.toContain(label);
        expect(observed.trickled).not.toContain(label);
        expect(observed.generation).not.toContain(label);
      }
      // Assert: ICE agent は新しい設定を使う
      for (const [key, value] of Object.entries(expected.options ?? {})) {
        expect(observed.options[key as keyof typeof observed.options]).toEqual(
          value,
        );
      }
      // Assert: relay ポリシーでは relay 候補の raddr / rport を trickle・generation・localDescription の SDP のすべてで秘匿する
      if (expected.relayRelated) {
        const related = expected.relayRelated === "hidden" ? ["0.0.0.0:9"] : [];
        for (const observedRelated of [
          observed.trickledRelayRelated,
          observed.generationRelayRelated,
          observed.localDescriptionRelayRelated,
        ]) {
          expect(observedRelated.length).toBeGreaterThan(0);
          if (expected.relayRelated === "hidden") {
            expect(observedRelated).toEqual(related);
          } else {
            expect(observedRelated).not.toContain("0.0.0.0:9");
            expect(observedRelated).not.toContain("none");
          }
        }
      }
      // Assert: restart 後の TURN 認証は新しい credential だけ
      expect(observed.authenticated).toEqual(expected.authenticated);
      // Assert: 旧 TURN allocation は restart で close される (restart しなければ残る)
      if (expected.staleAllocationsClosed !== undefined) {
        expect(observed.staleAllocations).toBeGreaterThan(0);
        expect(observed.staleAllocationsClosed).toBe(
          expected.staleAllocationsClosed,
        );
      }
    },
    30_000,
  );
});

describe("setConfiguration between a restart offer and its answer", () => {
  let servers: Awaited<ReturnType<typeof createTurnRotationServers>>;
  beforeAll(async () => {
    servers = await createTurnRotationServers();
  });
  afterAll(async () => {
    await servers.close();
  });

  test("offer 適用後・answer 前の relay 化は、その restart の gathering に commit 時点で反映される", async () => {
    // Arrange: credential A の TURN で接続済みの offerer と answerer
    const { offerer, answerer } = await createGatheredPeers(servers, {
      iceServers: servers.iceServers("a"),
    });
    try {
      // Act: credential B に変えて restart offer を作り、適用する
      offerer.setConfiguration({ iceServers: servers.iceServers("b") });
      const offer = await offerer.createOffer();
      await offerer.setLocalDescription(offer);
      const { connection } = firstIceTransport(offerer);
      const hostSockets = (
        connection as unknown as {
          protocols: { localCandidate?: { type: string }; close(): unknown }[];
        }
      ).protocols.filter(
        (protocol) => protocol.localCandidate?.type === "host",
      );
      const closes = hostSockets.map((protocol) => vi.spyOn(protocol, "close"));

      // Act: answer の前に relay ポリシーへ変える
      offerer.setConfiguration({ iceTransportPolicy: "relay" });

      // Assert: 適用済み offer は作成時の設定で host / srflx を announce している
      expect(sdpCandidateLabels(offer.sdp)).toEqual(["udp/host", "udp/srflx"]);

      // Act: answer を受けて restart generation を commit する
      await answerer.setRemoteDescription(offerer.localDescription!);
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
      await waitForLocalCandidatesEnd(offerer);

      // Assert: commit 時点の最新設定 (credential B + relay) で gather し、host socket は閉じる
      expect(connection.options.turnUsername).toBe("user-b");
      expect(connection.options.forceTurn).toBe(true);
      expect(generationCandidateLabels(offerer)).toEqual(["udp/relay"]);
      expect(hostSockets.length).toBeGreaterThan(0);
      for (const close of closes) expect(close).toHaveBeenCalled();
    } finally {
      await Promise.all([offerer.close(), answerer.close()]);
    }
  }, 30_000);
});

describe("relay ポリシーの初回 gathering は relay 候補の raddr を秘匿する", () => {
  let servers: Awaited<ReturnType<typeof createTurnRotationServers>>;
  beforeAll(async () => {
    servers = await createTurnRotationServers();
  });
  afterAll(async () => {
    await servers.close();
  });

  test.each([
    // [iceTransportPolicy, 期待する relay 候補の raddr]
    ["relay", "hidden"],
    ["all", "mapped"],
  ] as const)(
    "iceTransportPolicy %s → raddr %s",
    async (policy, expected) => {
      // Arrange: TURN A を持つ offerer と STUN のみの answerer
      const offerer = new RTCPeerConnection({
        iceServers: servers.iceServers("a"),
        iceTransportPolicy: policy,
      });
      const answerer = new RTCPeerConnection({
        iceServers: servers.iceServers(),
      });
      const trickled: string[] = [];
      offerer.onIceCandidate.subscribe((candidate) => {
        if (candidate?.candidate.includes(" typ relay")) {
          trickled.push(relatedAddressOf(candidate.candidate));
        }
      });
      try {
        // Act: 接続して初回 gathering を完了させる
        await connectPeerConnections(offerer, answerer);
        await waitForLocalCandidatesEnd(offerer);
        const described = sdpRelayRelatedAddresses(
          offerer.localDescription!.sdp,
        );

        // Assert: relay ポリシーなら trickle と SDP の relay 候補はどちらも 0.0.0.0:9 だけ
        for (const related of [[...new Set(trickled)], described]) {
          expect(related.length).toBeGreaterThan(0);
          if (expected === "hidden") {
            expect(related).toEqual(["0.0.0.0:9"]);
          } else {
            expect(related).not.toContain("0.0.0.0:9");
            expect(related).not.toContain("none");
          }
        }
      } finally {
        await Promise.all([offerer.close(), answerer.close()]);
      }
    },
    30_000,
  );
});
