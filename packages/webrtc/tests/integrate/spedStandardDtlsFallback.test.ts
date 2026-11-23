/**
 * `sped: true` with DTLS 1.3 and 1.2 against a peer without SPED: the SPED
 * runtime falls back to the direct carrier and the same DTLS association
 * sends its first, dual-version ClientHello bytes directly (never
 * re-serialized; it carries the DTLS 1.2 extensions), so the peer completes
 * DTLS 1.2 with it (draft §3.3.4). The peer is a default PeerConnection
 * (DTLS 1.2 only, no SPED), like werift before DTLS 1.3. These cases cover
 * what the fallback must release and the paths it must keep working on
 * (relay, ICE-TCP, ICE restart, loss).
 */
import { setTimeout as delay } from "node:timers/promises";

import type { CandidatePair, Connection } from "../../../ice/src";
import { getConnectionSpedRuntime } from "../../../ice/src/internal/sped-bind";
import { getHostAddresses } from "../../../ice/src/utils";
import {
  createLocalTurnServer,
  TURN_TEST_PASSWORD,
  TURN_TEST_USERNAME,
} from "../../../ice/tests/utils";
import { DtlsVersion, type RTCDataChannel, RTCPeerConnection } from "../../src";
import {
  activeResources,
  LeakTracker,
  leakSupport,
  leftoverResources,
} from "../pbt/leak/leakProbe";
import { createDataChannelPair, getTransportStats, waitUntil } from "../utils";

type SpedSide = "offerer" | "answerer";

const dualSped = {
  sped: true,
  dtls: { protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2] },
};

const tcpOnly = {
  iceUseTcp: true,
  iceFilterCandidatePair: (pair: CandidatePair) =>
    pair.localCandidate.transport.toLowerCase() === "tcp" &&
    pair.remoteCandidate.transport.toLowerCase() === "tcp",
};

function iceConnection(pc: RTCPeerConnection) {
  return pc.iceTransports[0]!.connection as unknown as Connection;
}

/** The SPED side fell back: its SPED runtime reports the direct DTLS carrier. */
function fellBackToDirectDtls(pc: RTCPeerConnection) {
  const diagnostics = getConnectionSpedRuntime(
    iceConnection(pc),
  )?.diagnosticsSnapshot();
  return diagnostics?.state === "fallback" && diagnostics.carrier === "direct";
}

/**
 * Drop DTLS datagrams `pc` sends directly (standard DTLS uses
 * Connection.send) while `drop()` is true; returns how many were dropped.
 */
function dropOutgoingDtls(pc: RTCPeerConnection, drop: () => boolean) {
  const connection = iceConnection(pc) as unknown as {
    send: (data: Buffer) => Promise<void>;
  };
  const original = connection.send.bind(connection);
  const counter = { dropped: 0 };
  connection.send = async (data: Buffer) => {
    const first = data[0] ?? 0;
    if (first >= 20 && first <= 63 && drop()) {
      counter.dropped++;
      return;
    }
    return original(data);
  };
  return counter;
}

/**
 * Shared Arrange: a dual-version SPED PeerConnection on `spedSide` and a
 * default one that trickle candidates to each other, with a data channel
 * from the offerer. `negotiate()` runs the first offer / answer
 * (`beforeStart` runs on each peer once its transports exist, before its
 * DTLS starts); `open` resolves when both channel ends are open.
 */
function createPlainPeerSession(
  spedSide: SpedSide,
  options: {
    spedConfig?: Record<string, unknown>;
    plainConfig?: Record<string, unknown>;
  } = {},
) {
  const spedConfig = { iceServers: [], ...dualSped, ...options.spedConfig };
  const plainConfig = { iceServers: [], ...options.plainConfig };
  const offerer = new RTCPeerConnection(
    (spedSide === "offerer" ? spedConfig : plainConfig) as never,
  );
  const answerer = new RTCPeerConnection(
    (spedSide === "offerer" ? plainConfig : spedConfig) as never,
  );
  const sped = spedSide === "offerer" ? offerer : answerer;
  const plain = spedSide === "offerer" ? answerer : offerer;
  offerer.onIceCandidate.subscribe((c) => {
    if (c) answerer.addIceCandidate(c.toJSON()).catch(() => {});
  });
  answerer.onIceCandidate.subscribe((c) => {
    if (c) offerer.addIceCandidate(c.toJSON()).catch(() => {});
  });
  const local = offerer.createDataChannel("fallback");
  const remote = new Promise<RTCDataChannel>((resolve) => {
    answerer.ondatachannel = ({ channel }) => {
      channel.onopen = () => resolve(channel);
    };
  });
  const localOpen = new Promise<void>((resolve) => {
    local.onopen = () => resolve();
  });
  const open = Promise.all([remote, localOpen]).then(([channel]) => ({
    offerer: local,
    answerer: channel,
  }));
  return {
    offerer,
    answerer,
    sped,
    plain,
    open,
    async negotiate(
      beforeStart?: (pc: RTCPeerConnection, role: "sped" | "plain") => void,
    ) {
      const roleOf = (pc: RTCPeerConnection) =>
        pc === sped ? ("sped" as const) : ("plain" as const);
      // The offerer starts DTLS when the answer is applied, the answerer
      // when its answer is set locally.
      await offerer.setLocalDescription(await offerer.createOffer());
      beforeStart?.(offerer, roleOf(offerer));
      await answerer.setRemoteDescription(offerer.localDescription!);
      beforeStart?.(answerer, roleOf(answerer));
      await answerer.setLocalDescription(await answerer.createAnswer());
      await offerer.setRemoteDescription(answerer.localDescription!);
    },
    close: async () => {
      await Promise.allSettled([offerer.close(), answerer.close()]);
    },
  };
}

/** Shared Arrange: {@link createPlainPeerSession} negotiated until both channel ends are open. */
async function connectAgainstPlainPeer(
  spedSide: SpedSide,
  options: Parameters<typeof createPlainPeerSession>[1] = {},
) {
  const session = createPlainPeerSession(spedSide, options);
  await session.negotiate();
  return { ...session, channels: await session.open };
}

async function roundTrip(
  channels: { offerer: RTCDataChannel; answerer: RTCDataChannel },
  text: string,
) {
  const atAnswerer = new Promise<string>((resolve) => {
    channels.answerer.onmessage = ({ data }) => resolve(String(data));
  });
  const atOfferer = new Promise<string>((resolve) => {
    channels.offerer.onmessage = ({ data }) => resolve(String(data));
  });
  channels.offerer.send(`${text}->`);
  channels.answerer.send(`<-${text}`);
  return Promise.all([atAnswerer, atOfferer]);
}

async function expectDtls12(...pcs: RTCPeerConnection[]) {
  for (const pc of pcs) {
    expect((await getTransportStats(pc))?.tlsVersion).toBe("DTLS 1.2");
  }
}

const spedSides: SpedSide[] = ["offerer", "answerer"];
const leakUnsupported = leakSupport();

describe("SPED (DTLS 1.3 + 1.2) falls back to standard DTLS against a peer without SPED", () => {
  test.skipIf(leakUnsupported).each(spedSides)(
    "SPED 側が %s: fallback 後も最初の DTLS socket のまま DTLS 1.2 で接続し、close 後に資源が解放される",
    async (spedSide) => {
      const before = activeResources();
      const tracker = new LeakTracker();
      // The peers live only inside this function, so nothing in the test
      // keeps them reachable once it returned.
      const runSession = async () => {
        const session = createPlainPeerSession(spedSide);
        let firstSocket: unknown;
        try {
          await session.negotiate((pc, role) => {
            if (role !== "sped") return;
            const transport = pc.dtlsTransports[0]!;
            const subscription = transport.onStateChange.subscribe((state) => {
              if (state !== "connecting") return;
              subscription.unSubscribe();
              // start() creates the SPED socket synchronously after connecting
              queueMicrotask(() => {
                firstSocket = transport.dtls;
                tracker.track(transport.dtls, "SPED DtlsSocket");
              });
            });
          });
          const channels = await session.open;
          // Act: fallback した接続でデータを往復させ、最初の flight の再送時間を過ぎるまで待つ
          expect(await roundTrip(channels, "release")).toEqual([
            "release->",
            "<-release",
          ]);
          await delay(2_500);

          // Assert: direct carrier へ fallback し、作り直さずに最初の socket で DTLS 1.2 が完了している
          expect(tracker.size).toBe(1);
          expect(fellBackToDirectDtls(session.sped)).toBe(true);
          expect(session.sped.dtlsTransports[0]!.dtls).toBe(firstSocket);
          await expectDtls12(session.offerer, session.answerer);
          expect(session.sped.connectionState).toBe("connected");
          tracker.trackPeer(session.offerer);
          tracker.trackPeer(session.answerer);
        } finally {
          // Act: 両端を閉じる
          await session.close();
        }
      };
      await runSession();

      // Assert: どの object も socket / timer も残らない
      expect(await tracker.survivors(5_000)).toEqual([]);
      expect(await leftoverResources(before, 5_000)).toEqual({});
    },
    30_000,
  );

  test.each(spedSides)(
    "SPED 側が %s: relay だけの経路でも DTLS 1.2 で接続する",
    async (spedSide) => {
      const host = getHostAddresses(true, false)[0]!;
      const turn = await createLocalTurnServer(host);
      const [turnHost, turnPort] = turn.address!;
      const relay = {
        iceTransportPolicy: "relay",
        iceServers: [
          {
            urls: `turn:${turnHost}:${turnPort}`,
            username: TURN_TEST_USERNAME,
            credential: TURN_TEST_PASSWORD,
          },
        ],
      };
      try {
        // Act: 両端とも relay 候補だけで接続する（relay 経路は SPED を載せない）
        const session = await connectAgainstPlainPeer(spedSide, {
          spedConfig: relay,
          plainConfig: relay,
        });
        try {
          // Assert: relay 経由で通常の DTLS 1.2 に落ちてデータが往復する
          expect(await roundTrip(session.channels, "relay")).toEqual([
            "relay->",
            "<-relay",
          ]);
          await expectDtls12(session.offerer, session.answerer);
          expect(
            iceConnection(session.sped).nominated?.localCandidate.type,
          ).toBe("relay");
        } finally {
          await session.close();
        }
      } finally {
        await turn.close();
      }
    },
    30_000,
  );

  test.each(spedSides)(
    "SPED 側が %s: ICE-TCP だけの経路で fallback して DTLS 1.2 で接続する",
    async (spedSide) => {
      // Act: TCP の pair だけを使って接続する
      const session = await connectAgainstPlainPeer(spedSide, {
        spedConfig: tcpOnly,
        plainConfig: tcpOnly,
      });
      try {
        // Assert: TCP 上で fallback し、データが往復する
        expect(await roundTrip(session.channels, "tcp")).toEqual([
          "tcp->",
          "<-tcp",
        ]);
        expect(fellBackToDirectDtls(session.sped)).toBe(true);
        await expectDtls12(session.offerer, session.answerer);
        expect(
          iceConnection(
            session.sped,
          ).nominated?.localCandidate.transport.toLowerCase(),
        ).toBe("tcp");
      } finally {
        await session.close();
      }
    },
    30_000,
  );

  test.each(spedSides)(
    "SPED 側が %s: fallback 後の handshake 中に ICE restart しても接続する",
    async (spedSide) => {
      // Arrange: 相手の DTLS 送信を止め、fallback 後の handshake を完了させない
      let hold = true;
      let held = { dropped: 0 };
      const session = createPlainPeerSession(spedSide);
      try {
        await session.negotiate((pc, role) => {
          if (role === "plain") held = dropOutgoingDtls(pc, () => hold);
        });
        await waitUntil(
          () => fellBackToDirectDtls(session.sped) && held.dropped > 0,
          "fallback handshake held",
        );
        expect(session.sped.dtlsTransports[0]!.state).toBe("connecting");

        // Act: 保留中に offerer から ICE restart して再ネゴシエーションし、保留を解く
        const ufrag = () =>
          session.offerer.localDescription!.sdp.match(/a=ice-ufrag:(\S+)/)![1];
        const before = ufrag();
        session.offerer.restartIce();
        await session.offerer.setLocalDescription(
          await session.offerer.createOffer(),
        );
        await session.answerer.setRemoteDescription(
          session.offerer.localDescription!,
        );
        await session.answerer.setLocalDescription(
          await session.answerer.createAnswer(),
        );
        await session.offerer.setRemoteDescription(
          session.answerer.localDescription!,
        );
        hold = false;
        const channels = await session.open;

        // Assert: restart 後の generation で DTLS 1.2 が完了し、SPED carrier に戻らずデータが往復する
        expect(ufrag()).not.toBe(before);
        expect(await roundTrip(channels, "restart")).toEqual([
          "restart->",
          "<-restart",
        ]);
        expect(fellBackToDirectDtls(session.sped)).toBe(true);
        await expectDtls12(session.offerer, session.answerer);
      } finally {
        await session.close();
      }
    },
    30_000,
  );

  test.each(
    spedSides.flatMap((spedSide) =>
      (["sped", "plain"] as const).map((loser) => [spedSide, loser] as const),
    ),
  )(
    "SPED 側が %s: fallback 直後に %s 側の最初の DTLS 送信が落ちても再送で接続する",
    async (spedSide, loser) => {
      // Arrange: 指定した側が直接送る最初の DTLS datagram だけを落とす
      let lost = { dropped: 0 };
      const session = createPlainPeerSession(spedSide);
      try {
        await session.negotiate((pc, role) => {
          if (role === loser)
            lost = dropOutgoingDtls(pc, () => lost.dropped === 0);
        });
        // Act: 再送を待って接続する
        const channels = await session.open;
        // Assert: 実際に 1 つ落とし、再送で DTLS 1.2 が完了してデータが往復する
        expect(lost.dropped).toBe(1);
        expect(await roundTrip(channels, "loss")).toEqual(["loss->", "<-loss"]);
        expect(fellBackToDirectDtls(session.sped)).toBe(true);
        await expectDtls12(session.offerer, session.answerer);
      } finally {
        await session.close();
      }
    },
    30_000,
  );
});

describe("SPED over relay-only paths (no path can carry SPED)", () => {
  const sped13 = {
    sped: true,
    dtls: { protocolVersions: [DtlsVersion.V1_3] },
  };
  const plain13 = { dtls: { protocolVersions: [DtlsVersion.V1_3] } };
  test.each([
    ["SPED x SPED", sped13, sped13],
    ["SPED なし x SPED", plain13, sped13],
    ["SPED x SPED なし", sped13, plain13],
    ["SPED 1.3/1.2 x SPED 1.3/1.2", dualSped, dualSped],
  ] as const)(
    "%s: 選択された relay pair で DTLS を直接送り、DTLS 1.3 で接続する",
    async (_name, offererConfig, answererConfig) => {
      const host = getHostAddresses(true, false)[0]!;
      const turn = await createLocalTurnServer(host);
      const [turnHost, turnPort] = turn.address!;
      const relay = {
        iceTransportPolicy: "relay" as const,
        iceServers: [
          {
            urls: `turn:${turnHost}:${turnPort}`,
            username: TURN_TEST_USERNAME,
            credential: TURN_TEST_PASSWORD,
          },
        ],
      };
      const offerer = new RTCPeerConnection({ ...relay, ...offererConfig });
      const answerer = new RTCPeerConnection({ ...relay, ...answererConfig });
      try {
        // Act: relay 候補だけで接続する（relay は SPED を載せず、support も決まらない）
        const [dc1, dc2] = await createDataChannelPair({}, offerer, answerer);
        const received = new Promise<string>((resolve) => {
          dc2.onmessage = ({ data }) => resolve(String(data));
        });
        dc1.send("relay-1.3");
        // Assert: 選択 pair で直接の DTLS 1.3 が完了し、データが届く
        expect(await received).toBe("relay-1.3");
        for (const pc of [offerer, answerer]) {
          expect((await getTransportStats(pc))?.tlsVersion).toBe("DTLS 1.3");
        }
      } finally {
        await offerer.close();
        await answerer.close();
        await turn.close();
      }
    },
    30_000,
  );
});
