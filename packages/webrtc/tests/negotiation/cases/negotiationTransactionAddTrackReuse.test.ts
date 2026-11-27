import { expect } from "vitest";

import { MediaStream, MediaStreamTrack } from "../../../src";
import {
  ANSWER_OR_ROLLBACK,
  describeCases,
  negotiationCase,
} from "../harness/negotiationCase";
import {
  addTrackTransceiver,
  createPairingPeers,
  createReservedSendSlot,
  expectRtpOutsideReservedSlot,
} from "../harness/negotiationTransactionUtils";

/**
 * Ticket b4f13786: `addTrack()` reuses a trackless transceiver only if its
 * `currentDirection` has never been `sendrecv` / `sendonly` (W3C addTrack,
 * "never been used to send"; Chrome's `has_ever_been_used_to_send_`), so a
 * track never goes out on an m-line (MID / MSID) the application negotiated
 * to send for another stream.
 */
describeCases("addTrack() reuse of a transceiver used to send", () => {
  for (const direction of ["sendrecv", "sendonly"] as const) {
    negotiationCase(
      `addTrack() does not reuse a trackless ${direction} transceiver negotiated by a remote answer`,
      { ref: "b4f13786 5-1 5-4 5-6" },
      async (c) => {
        // Arrange: a は trackless の予約スロットを交渉済み (remote answer で currentDirection が送信方向)。
        const { a, b, reserved, bReserved } = await c.given(
          createReservedSendSlot(direction),
        );
        expect(reserved.currentDirection).toBe("sendonly");

        // Act: 別の stream の track を addTrack する。
        const own = new MediaStream({ id: "own" });
        const { track, transceiver } = addTrackTransceiver(a, "audio", own);

        // Assert: 予約スロットは再利用されず、addTrack が新しい transceiver を作る。
        expect(transceiver).not.toBe(reserved);
        expect(transceiver.createdBy).toBe("addTrack");
        expect(reserved.sender.track).toBe(null);

        // Act: 交渉する。
        await c.negotiate(a);

        // Assert: RTP は新しい MID と own の MSID で届き、予約スロットには流れない。
        expect(transceiver.mid).not.toBe(reserved.mid);
        await expectRtpOutsideReservedSlot(b, bReserved, track, "own", "new");

        // Act: 再交渉する。
        await c.negotiate(a);

        // Assert: 再交渉の後も同じ経路で届く。
        await expectRtpOutsideReservedSlot(b, bReserved, track, "own", "again");
      },
    );
  }

  negotiationCase(
    "addTrack() takes another eligible transceiver instead of one negotiated to send",
    { ref: "b4f13786 5-1" },
    async (c) => {
      // Arrange: a は sendrecv の予約スロットに加え、recvonly の transceiver を交渉済み。
      const { a, b } = await c.given(createPairingPeers("standard"));
      const reserved = a.addTransceiver("audio");
      const recvonly = a.addTransceiver("audio", { direction: "recvonly" });
      await c.negotiate(a);

      // Act: addTrack する。
      const { transceiver } = addTrackTransceiver(a, "audio");

      // Assert: 送信方向で交渉したことのない recvonly のものを再利用し、sendrecv に上げる。
      expect(transceiver).not.toBe(reserved);
      expect(transceiver).toBe(recvonly);
      expect(recvonly.direction).toBe("sendrecv");
      expect(a.getTransceivers().length).toBe(2);
      await c.negotiate(a);
      expect(b.getTransceivers().length).toBe(2);
    },
  );

  negotiationCase(
    "addTrack() does not reuse a trackless remote transceiver a local answer negotiated sendrecv",
    { ref: "b4f13786 5-4" },
    async (c) => {
      // Arrange: a が音声を送る offer を b が受け、remote 由来の transceiver を sendrecv にして trackless で answer する。
      const { a, b } = await c.given(createPairingPeers("standard"));
      addTrackTransceiver(a, "audio");
      await c.offer(a);
      const [remote] = b.getTransceivers();
      remote.direction = "sendrecv";
      await c.answer(b);
      expect(remote.currentDirection).toBe("sendrecv");

      // Act: b が addTrack する。
      const { transceiver } = addTrackTransceiver(b, "audio");

      // Assert: local answer で送信方向になったものは再利用せず、新しい transceiver を作る。
      expect(transceiver).not.toBe(remote);
      expect(transceiver.createdBy).toBe("addTrack");
      await c.negotiate(b);
    },
  );

  negotiationCase.for([
    { change: "its own recvonly re-offer", via: "self", to: "recvonly" },
    { change: "its own inactive re-offer", via: "self", to: "inactive" },
    { change: "the peer's sendonly re-offer", via: "peer", to: "sendonly" },
    { change: "the peer's inactive re-offer", via: "peer", to: "inactive" },
  ] as const)(
    "addTrack() does not reuse a transceiver negotiated to send after $change",
    { ref: "b4f13786 5-2" },
    async (c, { via, to }) => {
      // Arrange: a の予約スロットを sendrecv で交渉済み。
      const { a, b, reserved, bReserved } = await c.given(
        createReservedSendSlot("sendrecv"),
      );

      // Act: a 自身の direction か、b の再 offer で送信しない方向へ再交渉する。
      if (via === "self") {
        reserved.direction = to as "recvonly";
        await c.negotiate(a);
      } else {
        bReserved.direction = to;
        await c.negotiate(b);
      }

      // Assert: currentDirection は送信しない方向になる。
      expect(reserved.currentDirection).toMatch(/^(recvonly|inactive)$/);

      // Act: addTrack する。
      const { track, transceiver } = addTrackTransceiver(
        a,
        "audio",
        new MediaStream({ id: "own" }),
      );

      // Assert: 一度送信方向になった予約スロットは再利用されず、新しい m-line で own の MSID として届く。
      expect(transceiver).not.toBe(reserved);
      expect(transceiver.createdBy).toBe("addTrack");
      await c.negotiate(a);
      await expectRtpOutsideReservedSlot(b, bReserved, track, "own", "own");
    },
  );

  negotiationCase.for([
    { detach: "replaceTrack(null)" },
    { detach: "removeTrack()" },
  ] as const)(
    "addTrack() does not reuse a transceiver negotiated to send whose track $detach took off",
    { ref: "b4f13786 5-2" },
    async (c, { detach }) => {
      // Arrange: a の予約スロットを sendrecv で交渉済み。
      const { a, b, reserved, bReserved } = await c.given(
        createReservedSendSlot("sendrecv"),
      );

      // Act: replaceTrack(track) で載せた track を、replaceTrack(null) か removeTrack() で外す。
      await reserved.sender.replaceTrack(
        new MediaStreamTrack({ kind: "audio" }),
      );
      if (detach === "removeTrack()") a.removeTrack(reserved.sender);
      else await reserved.sender.replaceTrack(null);

      // Act: addTrack する。
      const { track, transceiver } = addTrackTransceiver(
        a,
        "audio",
        new MediaStream({ id: "own" }),
      );

      // Assert: 予約スロットは再利用されず、新しい m-line で own の MSID として届く。
      expect(transceiver).not.toBe(reserved);
      expect(transceiver.createdBy).toBe("addTrack");
      await c.negotiate(a);
      await expectRtpOutsideReservedSlot(b, bReserved, track, "own", "own");
    },
  );

  negotiationCase(
    "addTrack() reuses a recvonly transceiver a remote offer created",
    { ref: "b4f13786 5-3" },
    async (c) => {
      // Arrange: a が音声を送り、b には remote offer 由来の recvonly transceiver がある。
      const { a, b } = await c.given(createPairingPeers("standard"));
      const { transceiver: aAudio } = addTrackTransceiver(a, "audio");
      await c.negotiate(a);
      const [remote] = b.getTransceivers();
      expect(remote.currentDirection).toBe("recvonly");

      // Act: b が addTrack する。
      const { track, transceiver } = addTrackTransceiver(b, "audio");

      // Assert: 送信方向で交渉したことがないので再利用し、sendrecv に上げる。
      expect(transceiver).toBe(remote);
      expect(remote.direction).toBe("sendrecv");

      // Act: b から交渉する。
      await c.negotiate(b);

      // Assert: 同じ m-line で b から a へ RTP が届く。
      expect(b.getTransceivers()).toEqual([remote]);
      await c.waitFor(() => a.connectionState === "connected");
      await c.rtp(track, aAudio.receiver.track);
    },
  );

  for (const direction of ["recvonly", "inactive"] as const) {
    negotiationCase(
      `addTrack() reuses a negotiated ${direction} addTransceiver() transceiver`,
      { ref: "b4f13786 5-3" },
      async (c) => {
        // Arrange: a は trackless の addTransceiver(kind, { direction }) を交渉済み。
        const { a } = await c.given(createPairingPeers("standard"));
        const own = a.addTransceiver("audio", { direction });
        await c.negotiate(a);

        // Act: addTrack する。
        const { transceiver } = addTrackTransceiver(a, "audio");

        // Assert: 送信方向で交渉したことがないので再利用し、送信を含む方向に上げる。
        expect(transceiver).toBe(own);
        expect(own.direction).toBe(
          direction === "recvonly" ? "sendrecv" : "sendonly",
        );
        await c.negotiate(a);
      },
    );
  }

  negotiationCase(
    "addTrack() reuses an addTransceiver() transceiver before its first negotiation",
    { ref: "b4f13786 5-3" },
    async (c) => {
      // Arrange: a は未交渉の trackless な addTransceiver(kind) を持つ。
      const { a } = await c.given(createPairingPeers("standard"));
      const own = a.addTransceiver("audio");

      // Act: addTrack する。
      const { transceiver } = addTrackTransceiver(a, "audio");

      // Assert: 未交渉なので再利用する。
      expect(transceiver).toBe(own);
      await c.negotiate(a);
    },
  );

  negotiationCase.for(ANSWER_OR_ROLLBACK)(
    "addTrack() does not reuse a transceiver a remote pranswer negotiated to send, after the $finish",
    { ref: "b4f13786 5-5" },
    async (c, { finish }) => {
      // Arrange: a の trackless な addTransceiver(kind) の offer に b が pranswer する。
      const { a, b } = await c.given(createPairingPeers("standard"));
      const reserved = a.addTransceiver("audio");
      await c.offer(a);
      await c.pranswer(b);
      expect(reserved.currentDirection).toBe("sendonly");

      // Act: final answer か rollback で交渉を終え、addTrack する。
      if (finish === "answer") await c.answer(b);
      else await c.rollback(a);
      const { transceiver } = addTrackTransceiver(a, "audio");

      // Assert: pranswer で送信方向になったので、rollback で戻した後も再利用しない。
      expect(transceiver).not.toBe(reserved);
      expect(transceiver.createdBy).toBe("addTrack");
      await c.negotiate(a);
    },
  );

  negotiationCase.for(ANSWER_OR_ROLLBACK)(
    "addTrack() does not reuse a transceiver a local pranswer negotiated to send, after the $finish",
    { ref: "b4f13786 5-5" },
    async (c, { finish }) => {
      // Arrange: b は remote offer 由来の recvonly transceiver を交渉済み。a の再 offer に、それを sendrecv にして trackless で pranswer する。
      const { a, b } = await c.given(createPairingPeers("standard"));
      addTrackTransceiver(a, "audio");
      await c.negotiate(a);
      const [remote] = b.getTransceivers();
      await c.offer(a);
      remote.direction = "sendrecv";
      await c.pranswer(b);
      expect(remote.currentDirection).toBe("sendrecv");

      // Act: final answer か rollback で交渉を終え、b が addTrack する。
      if (finish === "answer") await c.answer(b);
      else await c.rollback(b);
      const { transceiver } = addTrackTransceiver(b, "audio");

      // Assert: pranswer で送信方向になったので、rollback で recvonly に戻った後も再利用しない。
      expect(remote.currentDirection).toBe(
        finish === "answer" ? "sendrecv" : "recvonly",
      );
      expect(transceiver).not.toBe(remote);
      expect(transceiver.createdBy).toBe("addTrack");
      await c.negotiate(b);
    },
  );

  negotiationCase(
    "addTrack() does not reuse a transceiver added during a transaction that a pranswer negotiated to send before the rollback",
    { ref: "b4f13786 5-5" },
    async (c) => {
      // Arrange: 交渉済みの a が再 offer 中に trackless な transceiver を足し、置き換えの offer に b が pranswer する。
      const { a, b } = await c.given(createPairingPeers("standard"));
      addTrackTransceiver(a, "audio");
      await c.negotiate(a);
      await c.offer(a);
      const added = a.addTransceiver("audio");
      await c.offer(a);
      await c.pranswer(b);
      expect(added.currentDirection).toBe("sendonly");

      // Act: rollback する (added は作成時の状態に戻る)。
      await c.rollback(a);

      // Assert: added は MID も方向も持たない状態に戻る。
      expect(added.mid).toBe(null);
      expect(added.currentDirection).toBe(null);

      // Act: addTrack する。
      const { transceiver } = addTrackTransceiver(a, "audio");

      // Assert: pranswer で送信方向になった added は再利用しない。
      expect(transceiver).not.toBe(added);
      expect(transceiver.createdBy).toBe("addTrack");
      await c.negotiate(a);
    },
  );
});
