import { describe, expect, test } from "vitest";

import {
  MediaStreamTrack,
  type RTCPeerConnection,
  type RTCRtpSender,
} from "../../src";
import { createPendingRemoteOffer } from "./harness/negotiationTransactionUtils";

/**
 * Acceptance test of ticket edee68ec (#817): a transceiver a remote offer
 * created and the application took with `addTrack()` used to be removed and
 * stopped by the rollback once its track was detached; now it stays (the same
 * object, not stopped, without MID) and sends again after the next
 * negotiation. Two real werift peers over local ICE / DTLS / SRTP.
 */
/** 実際の ICE / DTLS 接続を張るので、vitest 既定の 5 秒より長く待つ。 */
const TIMEOUT = { timeout: 15_000 };

describe("acceptance: rollback keeps the transceiver addTrack() took, also after its track was detached", () => {
  test.each<{
    detach: string;
    run: (answerer: RTCPeerConnection, sender: RTCRtpSender) => unknown;
  }>([
    {
      detach: "replaceTrack(null)",
      run: (_answerer, sender) => sender.replaceTrack(null),
    },
    {
      detach: "removeTrack(sender)",
      run: (answerer, sender) => answerer.removeTrack(sender),
    },
  ])(
    "($detach) 1章・5章: addTrack → track を外す → rollback で同じ transceiver が残り、再交渉で送信できる",
    TIMEOUT,
    async ({ run }) => {
      const { answerer, remoteCreated, rollback, expectMediaFlows, close } =
        await createPendingRemoteOffer();

      try {
        // Act: remote offer が作った transceiver を addTrack で使い、track を外す。
        const sender = answerer.addTrack(
          new MediaStreamTrack({ kind: "audio" }),
        );
        await run(answerer, sender);

        // Assert: addTrack は remote offer の transceiver を再利用し、track は外れている (前提)。
        expect(sender).toBe(remoteCreated.sender);
        expect(sender.track).toBeNull();

        // Act: remote offer を rollback する。
        await rollback();

        // Assert: 同じ object のまま、停止せず、MID なしで残る (修正前は除去・停止された)。
        expect(answerer.getTransceivers()).toEqual([remoteCreated]);
        expect(remoteCreated.stopped).toBe(false);
        expect(remoteCreated.mid).toBeNull();

        // Act / Assert: 残った transceiver に track を付け直して交渉すると、相手に RTP が届く。
        // (removeTrack は direction も recvonly にする (W3C) ので、送信に戻す。)
        remoteCreated.direction = "sendrecv";
        await sender.replaceTrack(new MediaStreamTrack({ kind: "audio" }));
        await expectMediaFlows(sender);
      } finally {
        await close();
      }
    },
  );

  test(
    "(addTrack なし) 5章: アプリが使わなかった remote offer の transceiver は、従来どおり rollback で除去される",
    TIMEOUT,
    async () => {
      const { answerer, remoteCreated, rollback, close } =
        await createPendingRemoteOffer();

      try {
        // Act: transceiver に何もせず rollback する。
        await rollback();

        // Assert: W3C の rollback 手順どおり除去され、停止する。
        expect(answerer.getTransceivers()).toEqual([]);
        expect(remoteCreated.stopped).toBe(true);
      } finally {
        await close();
      }
    },
  );

  test(
    "(保留中に新規作成) 2章 関連修正: 再利用できる transceiver がなく addTrack が新しく作っても、rollback は例外なく戻せる",
    TIMEOUT,
    async () => {
      const { answerer, remoteCreated, rollback, expectMediaFlows, close } =
        await createPendingRemoteOffer();

      try {
        // Act: remote offer の audio とは別の kind の track を addTrack する (新しい transceiver を作る)。
        const sender = answerer.addTrack(
          new MediaStreamTrack({ kind: "video" }),
        );
        const created = answerer
          .getTransceivers()
          .find((t) => t.sender === sender)!;

        // Assert: remote offer の transceiver とは別に作られ、作成時から DTLS transport を持つ (前提)。
        expect(created).not.toBe(remoteCreated);
        expect(created.dtlsTransport).toBeDefined();

        // Act / Assert: rollback が例外を出さず (修正前は TypeError)、アプリが作った transceiver は残る。
        await expect(rollback()).resolves.toBeUndefined();
        expect(answerer.getTransceivers()).toEqual([created]);

        // Act / Assert: そのまま交渉すると、相手に RTP が届く。
        await expectMediaFlows(sender);
      } finally {
        await close();
      }
    },
  );
});
