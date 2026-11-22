/**
 * Interoperability between this branch and develop over real wire bytes.
 * Each scenario runs for every offerer/answerer pairing; develop x develop is
 * the baseline the mixed pairings must match. See `harness.ts`.
 */
import { setTimeout } from "node:timers/promises";

import {
  closeAll,
  createPeer,
  type DtlsFlight,
  dropFirstDtlsFlight,
  interopDisabled,
  loadIceServer,
  loadImpls,
  negotiate,
  negotiateWithoutTrickle,
  openDataChannel,
  type Pairing,
  pairingLabel,
  pairings,
  pumpRtp,
  recordConnectionStates,
  sampleMessages,
  transfer,
  transportTlsVersion,
  trickle,
  waitConnectionState,
  waitUntil,
  withTimeout,
} from "./harness";

type Impls = Awaited<ReturnType<typeof loadImpls>>;

describe.skipIf(interopDisabled)(
  "RTCPeerConnection interop with develop",
  { timeout: 30_000 },
  () => {
    let impls: Impls;
    beforeAll(async () => {
      impls = await loadImpls();
    });

    /** Shared Arrange: a trickling pair with an open data channel. */
    async function connectWithDataChannel(
      [offerSide, answerSide]: Pairing,
      offerConfig: Record<string, unknown> = {},
      answerConfig: Record<string, unknown> = {},
    ) {
      const offerer = createPeer(impls, offerSide, offerConfig);
      const answerer = createPeer(impls, answerSide, answerConfig);
      const offererStates = recordConnectionStates(offerer);
      const answererStates = recordConnectionStates(answerer);
      trickle(offerer, answerer);
      trickle(answerer, offerer);
      const channelPromise = openDataChannel(offerer, answerer);
      await negotiate(offerer, answerer);
      const channels = await channelPromise;
      await waitConnectionState(offerer, "connected");
      await waitConnectionState(answerer, "connected");
      return { offerer, answerer, channels, offererStates, answererStates };
    }

    async function assertBidirectionalData(
      channels: Awaited<ReturnType<typeof openDataChannel>>,
    ) {
      const messages = sampleMessages();
      // Act: 双方向に文字列・バイナリ・SCTP 断片化が必要な大きさのメッセージを送る
      const [toRemote, toLocal] = await Promise.all([
        transfer(channels.local, channels.remote, messages),
        transfer(channels.remote, channels.local, messages),
      ]);
      // Assert: 順序・内容とも欠けずに届く
      expect(toRemote).toEqual(messages);
      expect(toLocal).toEqual(messages);
    }

    describe.each(pairings.map((p) => [pairingLabel(p), p] as const))(
      "%s",
      (_label, pairing) => {
        test("trickle ICE + DTLS 1.2 + data channel", async () => {
          const { offerer, answerer, channels, offererStates, answererStates } =
            await connectWithDataChannel(pairing);
          try {
            await assertBidirectionalData(channels);
            // Assert: 既定は DTLS 1.2 で、connected は各 1 回だけ通知される
            expect(await transportTlsVersion(offerer)).toBe("DTLS 1.2");
            expect(await transportTlsVersion(answerer)).toBe("DTLS 1.2");
            expect(offererStates.filter((s) => s === "connected")).toHaveLength(
              1,
            );
            expect(
              answererStates.filter((s) => s === "connected"),
            ).toHaveLength(1);
          } finally {
            await closeAll(offerer, answerer);
          }
        });

        test("non-trickle (candidates in SDP)", async () => {
          const [offerSide, answerSide] = pairing;
          const offerer = createPeer(impls, offerSide);
          const answerer = createPeer(impls, answerSide);
          try {
            const channelPromise = openDataChannel(offerer, answerer);
            // Act: gathering 完了を待ってから候補入りの SDP だけで交換する
            await negotiateWithoutTrickle(offerer, answerer);
            const channels = await channelPromise;
            // Assert: trickle なしでも接続してデータが届く
            await assertBidirectionalData(channels);
          } finally {
            await closeAll(offerer, answerer);
          }
        });

        test("audio + video RTP/RTCP with data channel on one BUNDLE", async () => {
          const [offerSide, answerSide] = pairing;
          const offerImpl = impls[offerSide];
          const answerImpl = impls[answerSide];
          const offerer = createPeer(impls, offerSide);
          const answerer = createPeer(impls, answerSide);
          trickle(offerer, answerer);
          trickle(answerer, offerer);
          try {
            const offerTracks = {
              audio: new offerImpl.MediaStreamTrack({ kind: "audio" }),
              video: new offerImpl.MediaStreamTrack({ kind: "video" }),
            };
            const answerTracks = {
              audio: new answerImpl.MediaStreamTrack({ kind: "audio" }),
              video: new answerImpl.MediaStreamTrack({ kind: "video" }),
            };
            const received = new Set<string>();
            const rtcp = new Set<string>();
            for (const kind of ["audio", "video"] as const) {
              const transceiver = offerer.addTransceiver(offerTracks[kind], {
                direction: "sendrecv",
              });
              transceiver.onTrack.subscribe((track) =>
                track.onReceiveRtp.subscribe((rtp) => {
                  if (rtp.payload.toString() === `answer-${kind}`)
                    received.add(`offerer-${kind}`);
                }),
              );
              transceiver.receiver.onRtcp.subscribe(() =>
                rtcp.add(`offerer-${kind}`),
              );
            }
            answerer.onRemoteTransceiverAdded.subscribe((transceiver) => {
              const kind = transceiver.kind as "audio" | "video";
              transceiver.sender.replaceTrack(answerTracks[kind]);
              transceiver.setDirection("sendrecv");
              transceiver.onTrack.subscribe((track) =>
                track.onReceiveRtp.subscribe((rtp) => {
                  if (rtp.payload.toString() === `offer-${kind}`)
                    received.add(`answerer-${kind}`);
                }),
              );
              transceiver.receiver.onRtcp.subscribe(() =>
                rtcp.add(`answerer-${kind}`),
              );
            });
            const channelPromise = openDataChannel(offerer, answerer);
            await negotiate(offerer, answerer);
            const channels = await channelPromise;

            // Act: 双方が音声・映像の RTP を送り続ける
            await Promise.all(
              (["audio", "video"] as const).flatMap((kind) => [
                pumpRtp(
                  offerImpl,
                  offerTracks[kind],
                  Buffer.from(`offer-${kind}`),
                  () => received.has(`answerer-${kind}`),
                  `offer ${kind}`,
                ),
                pumpRtp(
                  answerImpl,
                  answerTracks[kind],
                  Buffer.from(`answer-${kind}`),
                  () => received.has(`offerer-${kind}`),
                  `answer ${kind}`,
                ),
              ]),
            );
            // Assert: 4 方向すべての RTP が届き、SRTCP も双方で受信できる
            expect([...received].sort()).toEqual([
              "answerer-audio",
              "answerer-video",
              "offerer-audio",
              "offerer-video",
            ]);
            await waitUntil(
              () => rtcp.has("offerer-video") && rtcp.has("answerer-video"),
              10_000,
              "rtcp both ways",
            );
            // Assert: 同じ BUNDLE 上のデータチャネルも使える
            const [echo] = await transfer(channels.local, channels.remote, [
              "after-media",
            ]);
            expect(echo).toBe("after-media");
          } finally {
            await closeAll(offerer, answerer);
          }
        });

        test("renegotiation started by the answerer adds a media section", async () => {
          const [, answerSide] = pairing;
          const { offerer, answerer, channels } =
            await connectWithDataChannel(pairing);
          try {
            const answerImpl = impls[answerSide];
            const track = new answerImpl.MediaStreamTrack({ kind: "video" });
            answerer.addTransceiver(track, { direction: "sendonly" });
            let got = false;
            offerer.onTrack.subscribe((remote) =>
              remote.onReceiveRtp.subscribe((rtp) => {
                if (rtp.payload.toString() === "reneg") got = true;
              }),
            );
            // Act: 役割を逆にして answerer 側から再 offer する
            await negotiate(answerer, offerer);
            await pumpRtp(
              answerImpl,
              track,
              Buffer.from("reneg"),
              () => got,
              "reneg",
            );
            // Assert: 追加した m-line で RTP が届き、既存チャネルも生きている
            expect(got).toBe(true);
            const [echo] = await transfer(channels.remote, channels.local, [
              "still-open",
            ]);
            expect(echo).toBe("still-open");
            expect(offerer.connectionState).toBe("connected");
            expect(answerer.connectionState).toBe("connected");
          } finally {
            await closeAll(offerer, answerer);
          }
        });

        test.each(["offerer", "answerer"] as const)(
          "ICE restart started by the %s keeps the session",
          async (initiator) => {
            const {
              offerer,
              answerer,
              channels,
              offererStates,
              answererStates,
            } = await connectWithDataChannel(pairing);
            try {
              const [first, second] =
                initiator === "offerer"
                  ? [offerer, answerer]
                  : [answerer, offerer];
              const beforeUfrag =
                first.localDescription!.sdp.match(/a=ice-ufrag:(\S+)/)![1];
              // Act: restartIce の後に再ネゴシエーションする
              first.restartIce();
              await negotiate(first, second);
              await waitConnectionState(offerer, "connected");
              await waitConnectionState(answerer, "connected");
              // Assert: ufrag が更新され、failed を経ずにデータが流れ続ける
              const afterUfrag =
                first.localDescription!.sdp.match(/a=ice-ufrag:(\S+)/)![1];
              expect(afterUfrag).not.toBe(beforeUfrag);
              const [a, b] = await Promise.all([
                transfer(channels.local, channels.remote, ["after-restart"]),
                transfer(channels.remote, channels.local, ["after-restart"]),
              ]);
              expect(a).toEqual(["after-restart"]);
              expect(b).toEqual(["after-restart"]);
              expect(offererStates).not.toContain("failed");
              expect(answererStates).not.toContain("failed");
            } finally {
              await closeAll(offerer, answerer);
            }
          },
        );

        test("ICE-lite answerer", async () => {
          // Act: answerer だけ ICE-lite で接続する（lite は controlled 側）
          const { offerer, answerer, channels } = await connectWithDataChannel(
            pairing,
            {},
            { iceLite: true },
          );
          try {
            // Assert: full × lite でも接続し、データが双方向に届く
            await assertBidirectionalData(channels);
          } finally {
            await closeAll(offerer, answerer);
          }
        });

        test("regular nomination by the controlling offerer", async () => {
          const { offerer, answerer, channels } = await connectWithDataChannel(
            pairing,
            { iceNomination: "regular" },
          );
          try {
            // Act/Assert: regular nomination（再 check で USE-CANDIDATE）でも接続する
            await assertBidirectionalData(channels);
          } finally {
            await closeAll(offerer, answerer);
          }
        });

        test("one-way trickle: the offerer learns peer-reflexive candidates", async () => {
          const [offerSide, answerSide] = pairing;
          const offerer = createPeer(impls, offerSide);
          const answerer = createPeer(impls, answerSide);
          // answerer の候補は offerer へ送らない（offerer は check から prflx を学習する）
          trickle(offerer, answerer);
          try {
            const channelPromise = openDataChannel(offerer, answerer);
            await offerer.setLocalDescription(await offerer.createOffer());
            await answerer.setRemoteDescription({
              type: "offer",
              sdp: offerer.localDescription!.sdp,
            });
            await answerer.setLocalDescription(await answerer.createAnswer());
            // Act: 候補行を除いた answer を渡す
            await offerer.setRemoteDescription({
              type: "answer",
              sdp: answerer
                .localDescription!.sdp.split("\r\n")
                .filter((line) => !line.startsWith("a=candidate:"))
                .join("\r\n"),
            });
            const channels = await channelPromise;
            // Assert: prflx 経由で接続し、データが双方向に届く
            await assertBidirectionalData(channels);
            const pair = offerer.iceTransports[0]!.connection.nominated;
            expect(pair?.remoteCandidate.type).toBe("prflx");
          } finally {
            await closeAll(offerer, answerer);
          }
        });

        test("stays connected across consent freshness checks", async () => {
          const { offerer, answerer, channels, offererStates, answererStates } =
            await connectWithDataChannel(pairing);
          try {
            // Act: consent check が複数回走る間データを流し続ける
            const deadline = Date.now() + 12_000;
            while (Date.now() < deadline) {
              const [echo] = await transfer(channels.local, channels.remote, [
                "tick",
              ]);
              expect(echo).toBe("tick");
              await setTimeout(1_000);
            }
            // Assert: 切断や失敗を経ずに connected のまま
            expect(offerer.connectionState).toBe("connected");
            expect(answerer.connectionState).toBe("connected");
            expect(offererStates).not.toContain("disconnected");
            expect(answererStates).not.toContain("disconnected");
          } finally {
            await closeAll(offerer, answerer);
          }
        });

        test("ICE-TCP only", async () => {
          const tcpOnly = {
            iceUseTcp: true,
            iceInterfaceAddresses: { udp4: "127.0.0.1", tcp4: "127.0.0.1" },
            iceFilterCandidatePair: (pair: {
              localCandidate: { transport: string };
            }) => pair.localCandidate.transport.toLowerCase() === "tcp",
          };
          const { offerer, answerer, channels } = await connectWithDataChannel(
            pairing,
            tcpOnly,
            tcpOnly,
          );
          try {
            // Act/Assert: TCP の経路だけでデータが双方向に届く
            await assertBidirectionalData(channels);
            const pair = offerer.iceTransports[0]!.connection.nominated;
            expect(pair?.localCandidate.transport.toLowerCase()).toBe("tcp");
          } finally {
            await closeAll(offerer, answerer);
          }
        });
      },
    );

    describe.each(pairings.map((p) => [pairingLabel(p), p] as const))(
      "close %s",
      (_label, pairing) => {
        test.each(["offerer", "answerer"] as const)(
          "%s closes: remote side observes the close",
          async (closer) => {
            const { offerer, answerer, channels } =
              await connectWithDataChannel(pairing);
            const [closing, remote] =
              closer === "offerer" ? [offerer, answerer] : [answerer, offerer];
            const remoteChannel =
              closer === "offerer" ? channels.remote : channels.local;
            try {
              const remoteStates = recordConnectionStates(remote);
              const channelClosed = remoteChannel.stateChanged.watch(
                (s) => s === "closed",
              );
              // Act: 片側だけ close する
              await closing.close();
              // Assert: 相手側のチャネルが閉じ、PeerConnection も closed 系に遷移する
              await withTimeout(channelClosed, 10_000, "remote channel closed");
              await waitUntil(
                () =>
                  ["closed", "failed", "disconnected"].includes(
                    remote.connectionState,
                  ),
                10_000,
                "remote connection state leaves connected",
              );
              expect(remoteStates).not.toContain("connected");
              observedClose.set(
                `${pairingLabel(pairing)} ${closer}`,
                remote.connectionState,
              );
            } finally {
              await closeAll(offerer, answerer);
            }
          },
        );
      },
    );

    // develop x develop と同じ遷移先になること（close のテストの後に評価する）
    const observedClose = new Map<string, string>();
    test("close outcome matches the develop baseline", () => {
      for (const closer of ["offerer", "answerer"]) {
        const baseline = observedClose.get(
          `${pairingLabel(pairings[0]!)} ${closer}`,
        );
        expect(baseline).toBeDefined();
        for (const pairing of pairings) {
          // Assert: 混在ペアでも相手側の最終状態が develop 同士と同じ
          expect(
            observedClose.get(`${pairingLabel(pairing)} ${closer}`),
            `${pairingLabel(pairing)} ${closer}`,
          ).toBe(baseline);
        }
      }
    });

    const flights: DtlsFlight[] = [
      "client-hello-1",
      "hello-verify-request",
      "client-hello-2",
      "flight4",
      "flight5",
      "flight6",
    ];
    /**
     * Shared Arrange + Act: connect with the first transmission of `flight`
     * dropped on whichever side sends it.
     */
    async function connectWithFlightLoss(
      [offerSide, answerSide]: Pairing,
      flight: DtlsFlight,
      offerConfig: Record<string, unknown> = {},
      answerConfig: Record<string, unknown> = {},
    ) {
      const offerer = createPeer(impls, offerSide, offerConfig);
      const answerer = createPeer(impls, answerSide, answerConfig);
      const offererStates = recordConnectionStates(offerer);
      const answererStates = recordConnectionStates(answerer);
      trickle(offerer, answerer);
      trickle(answerer, offerer);
      try {
        const channelPromise = openDataChannel(offerer, answerer);
        await offerer.setLocalDescription(await offerer.createOffer());
        const offererDrop = dropFirstDtlsFlight(offerer, flight);
        await answerer.setRemoteDescription({
          type: "offer",
          sdp: offerer.localDescription!.sdp,
        });
        await answerer.setLocalDescription(await answerer.createAnswer());
        const answererDrop = dropFirstDtlsFlight(answerer, flight);
        // Act: 対象 flight の初回送信だけを落として接続する
        await offerer.setRemoteDescription({
          type: "answer",
          sdp: answerer.localDescription!.sdp,
        });
        const channels = await withTimeout(
          channelPromise,
          20_000,
          "open after loss",
        );
        // Assert: 実際に落とし、再送で接続し、connected は各 1 回
        expect(offererDrop.dropped + answererDrop.dropped).toBeGreaterThan(0);
        const [echo] = await transfer(channels.local, channels.remote, [
          "after-loss",
        ]);
        expect(echo).toBe("after-loss");
        await waitConnectionState(offerer, "connected", 20_000);
        await waitConnectionState(answerer, "connected", 20_000);
        expect(offererStates.filter((s) => s === "connected")).toHaveLength(1);
        expect(answererStates.filter((s) => s === "connected")).toHaveLength(1);
        return { offerer, answerer };
      } finally {
        await closeAll(offerer, answerer);
      }
    }

    describe.each(pairings.map((p) => [pairingLabel(p), p] as const))(
      "DTLS 1.2 loss %s",
      (_label, pairing) => {
        test.each(flights)(
          "first %s lost: retransmission completes the handshake",
          async (flight) => {
            await connectWithFlightLoss(pairing, flight);
          },
          30_000,
        );
      },
    );

    const warpOptIns: [string, Record<string, unknown>][] = [
      // sped は DTLS 1.3 の提示が必須（README）。develop には 1.2 へ落ちる
      [
        "sped + DTLS 1.3/1.2",
        { sped: true, dtls: { protocolVersions: ["1.3", "1.2"] } },
      ],
      [
        "dtls.protocolVersions [1.3, 1.2]",
        { dtls: { protocolVersions: ["1.3", "1.2"] } },
      ],
      [
        "dtlsHandshakeValidation: standard",
        { dtlsHandshakeValidation: "standard" },
      ],
      ["compatibility: standard", { compatibility: "standard" }],
      [
        "sped + DTLS 1.3/1.2 + standard",
        {
          sped: true,
          dtls: { protocolVersions: ["1.3", "1.2"] },
          compatibility: "standard",
        },
      ],
    ];
    describe.each(warpOptIns)(
      "warp opt-in %s against develop",
      (_name, config) => {
        test.each([
          ["warp offers", ["warp", "develop"] as Pairing],
          ["warp answers", ["develop", "warp"] as Pairing],
        ])("%s: falls back to the develop protocol", async (_case, pairing) => {
          const warpIsOfferer = pairing[0] === "warp";
          // Act: warp 側だけ opt-in して develop と接続する
          const { offerer, answerer, channels } = await connectWithDataChannel(
            pairing,
            warpIsOfferer ? config : {},
            warpIsOfferer ? {} : config,
          );
          try {
            // Assert: develop が話せる DTLS 1.2 に落ちて通常どおり通信できる
            await assertBidirectionalData(channels);
            expect(await transportTlsVersion(offerer)).toBe("DTLS 1.2");
            expect(await transportTlsVersion(answerer)).toBe("DTLS 1.2");
          } finally {
            await closeAll(offerer, answerer);
          }
        });
      },
    );

    describe.each(
      (["develop", "warp"] as const).map(
        (server) => [`${server} TURN server`, server] as const,
      ),
    )("relay through %s", (_label, serverSide) => {
      test.each(pairings.map((p) => [pairingLabel(p), p] as const))(
        "%s: relay-only connection",
        async (_name, pairing) => {
          const turn = await startTurnServer(serverSide);
          const relay = {
            iceTransportPolicy: "relay",
            iceServers: [
              {
                urls: `turn:127.0.0.1:${turn.port}`,
                username: "user",
                credential: "pass",
              },
            ],
          };
          try {
            // Act: 両側とも relay 候補だけで接続する
            const { offerer, answerer, channels } =
              await connectWithDataChannel(pairing, relay, relay);
            try {
              // Assert: TURN を経由してデータが双方向に届く
              await assertBidirectionalData(channels);
              const pair = offerer.iceTransports[0]!.connection.nominated;
              expect(pair?.localCandidate.type).toBe("relay");
            } finally {
              await closeAll(offerer, answerer);
            }
          } finally {
            await turn.close();
          }
        },
        30_000,
      );
    });

    // warp の DTLS 1.3 / 1.2（SPED あり / なし）は develop に対して DTLS 1.2 へ落ちる。
    // SPED は通常の DTLS への切り替えを伴う。それが UDP host 以外の経路・restart・loss でも成り立つこと。
    const warpDualConfigs = [
      [
        "SPED + DTLS 1.3/1.2",
        { sped: true, dtls: { protocolVersions: ["1.3", "1.2"] } },
      ],
      ["DTLS 1.3/1.2", { dtls: { protocolVersions: ["1.3", "1.2"] } }],
    ] as const;
    const spedPairings = [
      ["warp", "develop"],
      ["develop", "warp"],
    ] as const satisfies readonly Pairing[];
    const warpDualMatrix = warpDualConfigs.flatMap(([name, config]) =>
      spedPairings.map(
        (pairing) =>
          [`${name} ${pairingLabel(pairing)}`, pairing, config] as const,
      ),
    );
    describe.each(warpDualMatrix)("warp %s", (_label, pairing, warpConfig) => {
      const warpSped = (
        [offerSide, answerSide]: Pairing,
        extra: Record<string, unknown> = {},
      ) =>
        [
          offerSide === "warp" ? { ...warpConfig, ...extra } : extra,
          answerSide === "warp" ? { ...warpConfig, ...extra } : extra,
        ] as const;
      test("ICE-TCP only", async () => {
        const tcpOnly = {
          iceUseTcp: true,
          iceInterfaceAddresses: { udp4: "127.0.0.1", tcp4: "127.0.0.1" },
          iceFilterCandidatePair: (pair: {
            localCandidate: { transport: string };
          }) => pair.localCandidate.transport.toLowerCase() === "tcp",
        };
        // Act: TCP の経路だけで接続する
        const { offerer, answerer, channels } = await connectWithDataChannel(
          pairing,
          ...warpSped(pairing, tcpOnly),
        );
        try {
          // Assert: TCP 上で DTLS 1.2 に落ちてデータが双方向に届く
          await assertBidirectionalData(channels);
          expect(await transportTlsVersion(offerer)).toBe("DTLS 1.2");
          expect(
            offerer.iceTransports[0]!.connection.nominated?.localCandidate.transport.toLowerCase(),
          ).toBe("tcp");
        } finally {
          await closeAll(offerer, answerer);
        }
      });

      test.each(["develop", "warp"] as const)(
        "relay only through the %s TURN server",
        async (serverSide) => {
          const turn = await startTurnServer(serverSide);
          const relay = {
            iceTransportPolicy: "relay",
            iceServers: [
              {
                urls: `turn:127.0.0.1:${turn.port}`,
                username: "user",
                credential: "pass",
              },
            ],
          };
          try {
            // Act: relay 候補だけで接続する（relay は SPED を載せない）
            const { offerer, answerer, channels } =
              await connectWithDataChannel(
                pairing,
                ...warpSped(pairing, relay),
              );
            try {
              // Assert: relay 上で DTLS 1.2 に落ちてデータが双方向に届く
              await assertBidirectionalData(channels);
              expect(await transportTlsVersion(answerer)).toBe("DTLS 1.2");
            } finally {
              await closeAll(offerer, answerer);
            }
          } finally {
            await turn.close();
          }
        },
        30_000,
      );

      test.each(["offerer", "answerer"] as const)(
        "ICE restart started by the %s keeps the DTLS 1.2 session",
        async (initiator) => {
          const { offerer, answerer, channels, offererStates, answererStates } =
            await connectWithDataChannel(pairing, ...warpSped(pairing));
          try {
            const [first, second] =
              initiator === "offerer"
                ? [offerer, answerer]
                : [answerer, offerer];
            // Act: DTLS 1.2 に落ちた接続で restartIce して再ネゴシエーションする
            first.restartIce();
            await negotiate(first, second);
            await waitConnectionState(offerer, "connected");
            await waitConnectionState(answerer, "connected");
            // Assert: failed を経ずに DTLS 1.2 のままデータが流れ続ける
            const [echo] = await transfer(channels.remote, channels.local, [
              "after-restart",
            ]);
            expect(echo).toBe("after-restart");
            expect(await transportTlsVersion(offerer)).toBe("DTLS 1.2");
            expect(offererStates).not.toContain("failed");
            expect(answererStates).not.toContain("failed");
          } finally {
            await closeAll(offerer, answerer);
          }
        },
      );

      test.each(flights)(
        "first %s lost: retransmission completes the DTLS 1.2 handshake",
        async (flight) => {
          await connectWithFlightLoss(pairing, flight, ...warpSped(pairing));
        },
        30_000,
      );
    });

    async function startTurnServer(side: "develop" | "warp") {
      const { NodeTurnServer } = await loadIceServer(side);
      const server = new NodeTurnServer({
        host: "127.0.0.1",
        port: 0,
        relayAddress: "127.0.0.1",
        relayBindAddress: "127.0.0.1",
        getPassword: (username: string) =>
          username === "user" ? "pass" : undefined,
        realm: "werift.local",
      });
      await server.listen();
      return {
        port: server.address![1] as number,
        close: () => server.close(),
      };
    }
  },
);
