import { vi } from "vitest";
import { SCTP_STATE } from "../../../sctp/src";
import { awaitMessage, exchangeOfferAnswer } from "../utils";
import {
  addSameAddressCandidate,
  currentMediaSource,
  nextTurn,
  observeUnhandledRejections,
  prepareContinuousRtp,
  prepareDelayedCookieAck,
  prepareHeldCookieAckAtInitiator,
  prepareWarpClose,
} from "./warpArrange";

describe("WARP asynchronous shutdown", () => {
  test.each([false, true])(
    "write-ready 前の close は未処理 rejection を残さない (SCTP=%s)",
    async (hasSctp) => {
      // Arrange: early opt-in の server を、相手が ICE を開始する前に閉じる。
      const { server, client, answer } = await prepareWarpClose(hasSctp);
      const unhandled = observeUnhandledRejections();
      try {
        // Act: 実 DTLS を開始し、write-ready が未成立の間に close する。
        await server.setRemoteDescription(answer);
        await vi.waitFor(() => {
          expect(server.dtlsTransports[0].state).toBe("connecting");
        });
        expect(server.dtlsTransports[0].role).toBe("server");
        expect(server.dtlsTransports[0].isEarlyServerWriteAllowed()).toBe(
          false,
        );
        await server.close();
        await nextTurn();

        // Assert: media-only / SCTP の両方で終了状態と rejection 処理を保つ。
        expect(server.connectionState).toBe("closed");
        expect(unhandled.errors).toEqual([]);
      } finally {
        await Promise.allSettled([server.close(), client.close()]);
        await nextTurn();
        unhandled.dispose();
      }
    },
    10_000,
  );

  test.each(["continue", "revoke", "close"] as const)(
    "応答側 (DTLS client) の COOKIE_ACK 遅延完了は取消・終了と整合する (%s)",
    async (action) => {
      // Arrange: 実接続の passive SCTP で COOKIE_ACK の送信完了を保留する。
      const fixture = prepareDelayedCookieAck();
      const { server, client, channels } = fixture;
      try {
        // Act: COOKIE_ACK が wire に出てから、必要なケースだけ許可を取り消す。
        await exchangeOfferAnswer(server, client);
        const association = await fixture.entered;
        // Assert: RFC 4960 5.1 (D) どおり、COOKIE_ACK を渡した時点で確立済み。
        expect(association.associationState).toBe(SCTP_STATE.ESTABLISHED);
        expect(association.startCommitted).toBe(true);
        expect(client.dtlsTransports[0].role).toBe("client");
        if (action === "revoke") {
          // Act: DTLS client は early 送信権限を使わないため、取消しは何もしない。
          client.setConfiguration({ warp: { allowEarlyServerData: false } });
          // Assert: 送信済み association はそのまま残る。
          expect(association.state).not.toBe("closed");
        } else if (action === "close") {
          // Act: 通常終了でも送信待機中の association を閉じる。
          await client.close();
        }
        fixture.release();
        await fixture.completed;
        await nextTurn();

        if (action === "close") {
          // Assert: 遅れて完了した送信処理が CLOSED を上書きせず、終了状態を保つ。
          expect(association.state).toBe("closed");
          expect(association.associationState).toBe(SCTP_STATE.CLOSED);
          expect(client.connectionState).toBe("closed");
          expect(channels[1].readyState).toBe("closed");
          return;
        }

        // Assert: 取消の有無によらず同じ association で双方の channel が開く。
        await vi.waitFor(() => {
          expect(channels.map((channel) => channel.readyState)).toEqual([
            "open",
            "open",
          ]);
        });
        expect(client.sctp!.sctp).toBe(association);
        expect(association.state).toBe("connected");
        expect(server.sctp!.sctp.state).toBe("connected");

        // Act: 遅延完了後に server → client へ送信する。
        const toClient = awaitMessage(channels[1]);
        channels[0].send(`to-client-${action}`);
        // Assert: client 側で受信できる。
        expect(await toClient).toBe(`to-client-${action}`);

        // Act: 逆方向 client → server へ送信する。
        const toServer = awaitMessage(channels[0]);
        channels[1].send(`to-server-${action}`);
        // Assert: server 側で受信でき、双方向配送が成立する。
        expect(await toServer).toBe(`to-server-${action}`);
      } finally {
        fixture.restore();
        await Promise.allSettled([server.close(), client.close()]);
      }
    },
    15_000,
  );
});

describe("WARP SCTP start cancellation at the initiator", () => {
  test.each([
    { trigger: "revoke", heldAck: "deliver" },
    { trigger: "attempt-cancel", heldAck: "deliver" },
    { trigger: "attempt-cancel", heldAck: "drop" },
  ] as const)(
    "開始側 (DTLS server) は COOKIE_ECHO 送信後の取消しで association を作り直さない ($trigger, COOKIE_ACK=$heldAck)",
    async ({ trigger, heldAck }) => {
      // Arrange: 開始側が COOKIE_ACK を処理する手前で保留する。応答側は確立済み。
      const fixture = prepareHeldCookieAckAtInitiator();
      const { server, client, channels } = fixture;
      const closedAssociations: unknown[] = [];
      try {
        await exchangeOfferAnswer(server, client);
        const association = await fixture.entered;
        const responder = client.sctp!.sctp;
        expect(server.dtlsTransports[0].role).toBe("server");
        expect(association.associationState).toBe(SCTP_STATE.COOKIE_ECHOED);
        expect(association.startCommitted).toBe(true);
        expect(responder.hadEstablished).toBe(true);
        server.sctp!.sctp.stateChanged.closed.subscribe(() => {
          closedAssociations.push(association);
        });

        // Act: 早期送信の許可取消し、または試行取消しの通知を開始側で発生させる。
        if (trigger === "revoke") {
          server.setConfiguration({ warp: { allowEarlyServerData: false } });
        } else {
          server.dtlsTransports[0].onEarlyApplicationAttemptCancelled.execute();
        }
        await nextTurn();

        // Assert: 相手が状態を持つため、開始側の association は閉じも置換もされない。
        expect(association.state).not.toBe("closed");
        expect(server.sctp!.sctp).toBe(association);
        expect(closedAssociations).toEqual([]);

        // Act: 保留していた COOKIE_ACK を配送する。drop は取消しで受信途中の
        // 応答が捨てられた場合を表し、開始側の即時再送だけが回復手段になる。
        if (heldAck === "deliver") fixture.release();

        // Assert: 両側とも取消し前と同じ association のまま確立し、channel が開く。
        // drop でも T1 (3 秒) を待たずに回復する。
        await vi.waitFor(
          () => {
            expect(channels.map((channel) => channel.readyState)).toEqual([
              "open",
              "open",
            ]);
          },
          { timeout: 1_500 },
        );
        expect(server.sctp!.sctp).toBe(association);
        expect(client.sctp!.sctp).toBe(responder);
        expect(association.hadEstablished).toBe(true);

        // Act: server → client へ送信する。
        const toClient = awaitMessage(channels[1]);
        channels[0].send(`to-client-${trigger}-${heldAck}`);
        // Assert: client 側で受信できる。
        expect(await toClient).toBe(`to-client-${trigger}-${heldAck}`);

        // Act: client → server へ送信する。
        const toServer = awaitMessage(channels[0]);
        channels[1].send(`to-server-${trigger}-${heldAck}`);
        // Assert: server 側でも受信でき、双方向配送が成立する。
        expect(await toServer).toBe(`to-server-${trigger}-${heldAck}`);
      } finally {
        fixture.restore();
        await Promise.allSettled([server.close(), client.close()]);
      }
    },
    15_000,
  );
});

describe("WARP ICE restart media continuity", () => {
  test("restart 後の同一アドレス候補登録から再接続完了まで旧経路の RTP を配送し続ける", async () => {
    // Arrange: sender → receiver の RTP が継続的に流れている接続。
    const fixture = await prepareContinuousRtp();
    const { sender, receiver } = fixture;
    try {
      await fixture.receivedMore(5);
      const oldSource = currentMediaSource(receiver);

      // Act: receiver だけが ICE restart し、sender は旧選択 pair で送り続ける。
      const restartOffer = await receiver.createOffer({ iceRestart: true });
      await receiver.setLocalDescription(restartOffer);
      // Act: 旧経路と同じアドレスの新世代候補を登録し、未認証 pair を作る。
      const pendingPair = await addSameAddressCandidate(
        receiver,
        oldSource.address,
      );

      // Assert: 新世代 pair は存在するが、旧経路の RTP は配送され続ける。
      expect(pendingPair).toBeDefined();
      await fixture.receivedMore(5);

      // Act: restart の offer/answer を完了させ、新世代 pair で再接続する。
      await sender.setRemoteDescription(receiver.localDescription!);
      const answer = await sender.createAnswer();
      await sender.setLocalDescription(answer);
      await receiver.setRemoteDescription(sender.localDescription!);
      await vi.waitFor(
        () => {
          const connection = receiver.dtlsTransports[0].iceTransport.connection;
          expect(connection.nominated).toBeDefined();
        },
        { timeout: 5_000 },
      );

      // Assert: 再接続完了後も RTP が途切れず配送される。
      await fixture.receivedMore(5);
    } finally {
      fixture.stop();
      await Promise.allSettled([sender.close(), receiver.close()]);
    }
  }, 20_000);
});
