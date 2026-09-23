import { vi } from "vitest";
import { SCTP_STATE } from "../../../sctp/src";
import { awaitMessage, exchangeOfferAnswer } from "../utils";
import {
  nextTurn,
  observeUnhandledRejections,
  prepareDelayedCookieAck,
  prepareWarpClose,
} from "./warpLifecycleArrange";

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
    "COOKIE_ACK の遅延完了は取消・終了済み association を復活させない (%s)",
    async (action) => {
      // Arrange: 実接続の passive SCTP で COOKIE_ACK の送信完了を保留する。
      const fixture = prepareDelayedCookieAck();
      const { server, client, channels } = fixture;
      try {
        // Act: COOKIE_ACK が wire に出てから、必要なケースだけ許可を取り消す。
        await exchangeOfferAnswer(server, client);
        const association = await fixture.entered;
        expect(association.hadEstablished).toBe(false);
        if (action === "revoke") {
          client.setConfiguration({ warp: { allowEarlyServerData: false } });
          expect(association.state).toBe("closed");
        } else if (action === "close") {
          // Act: 通常終了でも送信待機中の association を閉じる。
          await client.close();
        }
        fixture.release();
        await fixture.completed;
        await nextTurn();

        if (action !== "continue") {
          // Assert: 古い送信処理で CLOSED を上書きせず、再試行には新規実体を使う。
          expect(association.state).toBe("closed");
          expect(association.associationState).toBe(SCTP_STATE.CLOSED);
          expect(association.hadEstablished).toBe(false);
          if (action === "revoke") {
            await vi.waitFor(() => {
              expect(client.sctp!.sctp).not.toBe(association);
            });
            expect(client.connectionState).not.toBe("connected");
          } else {
            expect(client.connectionState).toBe("closed");
            expect(channels[1].readyState).toBe("closed");
          }
        } else {
          // Assert: 取消なしの対照ケースでは negotiated channel が双方で開く。
          await vi.waitFor(() => {
            expect(channels.map((channel) => channel.readyState)).toEqual([
              "open",
              "open",
            ]);
          });
          expect(client.sctp!.sctp).toBe(association);
          expect(association.state).toBe("connected");
          const received = awaitMessage(channels[1]);
          // Act/Assert: 遅延後も通常の DataChannel メッセージを実配送できる。
          channels[0].send("cookie-ack-completed");
          expect(await received).toBe("cookie-ack-completed");
        }
      } finally {
        fixture.restore();
        await Promise.allSettled([server.close(), client.close()]);
      }
    },
    15_000,
  );
});
