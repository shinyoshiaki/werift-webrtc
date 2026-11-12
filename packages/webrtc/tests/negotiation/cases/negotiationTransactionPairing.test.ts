import { expect } from "vitest";

import {
  MediaStreamTrack,
  type RTCPeerConnection,
  useH264,
} from "../../../src";
import { countNegotiationNeeded, flushEvents } from "../../issue/705.helpers";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import {
  addTrackTransceiver,
  createPairingPeers,
} from "../harness/negotiationTransactionUtils";

const connected = (...pcs: RTCPeerConnection[]) =>
  pcs.every((pc) => pc.connectionState === "connected");

/**
 * #816: which local transceiver a remote offer's m-section is paired with
 * (`transceiverPairing`, `matchRemoteTransceiver` in
 * src/negotiation/transceiverPairing.ts). Under `"standard"` (default, RFC 8829
 * 5.10) only a transceiver `addTrack()` created pairs with an m-section
 * whose MID it does not have; under `"legacy"` any unassociated one of the
 * same kind does. Every case runs in both modes (`paired`: whether the local
 * `addTransceiver()` transceiver is taken by the remote offer).
 */
for (const { mode, paired } of [
  { mode: "standard", paired: false },
  { mode: "legacy", paired: true },
] as const) {
  describeCases(`transceiver pairing (transceiverPairing=${mode})`, () => {
    negotiationCase(
      "#816: addTransceiver() before a remote offer keeps its direction and MID, and is offered after the answer",
      { ref: "#816 5-1 5-5" },
      async (c) => {
        // Arrange: b の app が sendrecv の audio を addTransceiver() で作る。
        const { a, b } = await c.given(createPairingPeers(mode));
        a.addTransceiver("audio");
        const own = b.addTransceiver("audio", { direction: "sendrecv" });
        const needed = countNegotiationNeeded(b);
        await flushEvents();
        const neededBefore = needed.count;

        // Act: a の audio offer を b に適用する。
        await c.offer(a);

        // Assert: standard では remote offer 用の transceiver を作り、own は MID null / sendrecv のまま。legacy では own に関連付ける。
        expect(b.getTransceivers().length).toBe(paired ? 1 : 2);
        expect(own.mid).toBe(paired ? "0" : null);
        expect(own.direction).toBe("sendrecv");

        // Act: answer で確定する。
        await c.answer(b);
        await flushEvents();

        // Assert: standard では関連付かなかった own のために negotiationneeded が発火する。
        expect(needed.count > neededBefore).toBe(!paired);
        if (paired) return;

        // Act: b が自分の offer を作る。
        await c.negotiate(b);

        // Assert: own は末尾 (index 1) の新しい m-line になり、MID は重複しない。
        expect(own.mLineIndex).toBe(1);
        expect(own.mid).toBe("1");
        expect(own.currentDirection).toBe("sendonly");
        expect(b.getTransceivers().map((t) => t.mid)).toEqual(["1", "0"]);
      },
    );

    negotiationCase(
      "addTransceiver(track) and addTransceiver(kind) + replaceTrack() are paired only under legacy",
      { ref: "#816 5-2" },
      async (c) => {
        // Arrange: b は track 付きの addTransceiver() と、後から replaceTrack() した addTransceiver() を持つ。
        const { a, b } = await c.given(createPairingPeers(mode));
        a.addTransceiver("audio");
        a.addTransceiver("video");
        const withTrack = b.addTransceiver(
          new MediaStreamTrack({ kind: "audio" }),
          { direction: "sendonly" },
        );
        const replaced = b.addTransceiver("video", { direction: "sendonly" });
        await replaced.sender.replaceTrack(
          new MediaStreamTrack({ kind: "video" }),
        );

        // Act: audio + video の remote offer を適用する。
        await c.offer(a);

        // Assert: track の有無によらず addTransceiver() 起源は standard では関連付かず、方向も変わらない。
        expect(withTrack.mid).toBe(paired ? "0" : null);
        expect(replaced.mid).toBe(paired ? "1" : null);
        expect(withTrack.direction).toBe("sendonly");
        expect(replaced.direction).toBe("sendonly");
        expect(b.getTransceivers().length).toBe(paired ? 2 : 4);
        await c.answer(b);
      },
    );

    negotiationCase(
      "an addTransceiver(recvonly) reused by addTrack() keeps its origin",
      { ref: "#816 5-3" },
      async (c) => {
        // Arrange: recvonly の addTransceiver() を addTrack() が再利用する (sendrecv になる)。
        const { a, b } = await c.given(createPairingPeers(mode));
        a.addTransceiver("video");
        const own = b.addTransceiver("video", { direction: "recvonly" });
        const reused = addTrackTransceiver(b, "video");
        expect(reused.transceiver).toBe(own);
        expect(own.direction).toBe("sendrecv");

        // Act: video の remote offer を適用する。
        await c.offer(a);

        // Assert: 生成元は addTransceiver のままなので standard では関連付かない。
        expect(own.mid).toBe(paired ? "0" : null);
        expect(b.getTransceivers().length).toBe(paired ? 1 : 2);
        await c.answer(b);
      },
    );

    negotiationCase(
      "a transceiver addTrack() created is paired in both modes and negotiates sendrecv",
      { ref: "#816 5-4" },
      async (c) => {
        // Arrange: a は sendrecv video、b は addTrack() で video を送る。
        const { a, b } = await c.given(createPairingPeers(mode));
        const aOut = new MediaStreamTrack({ kind: "video" });
        const aVideo = a.addTransceiver(aOut, { direction: "sendrecv" });
        const { track: bOut, transceiver: bVideo } = addTrackTransceiver(
          b,
          "video",
        );

        // Act: offer / answer で確定する。
        await c.negotiate(a);

        // Assert: addTrack() の transceiver が offer の m-line と関連付き、両方向の RTP が流れる。
        expect(b.getTransceivers()).toEqual([bVideo]);
        expect(bVideo.mid).toBe("0");
        expect(bVideo.currentDirection).toBe("sendrecv");
        expect(aVideo.currentDirection).toBe("sendrecv");
        await c.waitFor(() => connected(a, b));
        await c.rtp(aOut, bVideo.receiver.track);
        await c.rtp(bOut, aVideo.receiver.track);
      },
    );

    for (const offered of ["sendonly", "inactive"] as const) {
      negotiationCase(
        `a ${offered} m-section is not paired with an addTrack() transceiver under standard`,
        { ref: "#816 5-4" },
        async (c) => {
          // Arrange: a は ${offered} の video、b は addTrack() で video を持つ。
          const { a, b } = await c.given(createPairingPeers(mode));
          a.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
            direction: offered,
          });
          const { transceiver: bVideo } = addTrackTransceiver(b, "video");

          // Act: remote offer を適用する。
          await c.offer(a);

          // Assert: standard (RFC 9429 5.10) では ${offered} の m-line に既存の送信用 transceiver を使わず、新しいものを作る。legacy では対応付ける。
          expect(bVideo.mid).toBe(paired ? "0" : null);
          expect(b.getTransceivers().length).toBe(paired ? 1 : 2);

          // Act: answer で確定する。
          await c.answer(b);
          await flushEvents();

          // Assert: bVideo は関連付かないまま、後続の交渉で送信用に新しい m-line になる。
          if (paired) return;
          expect(bVideo.mid).toBe(null);
          await c.negotiate(b);
          expect(bVideo.mid).toBe("1");
          expect(bVideo.currentDirection).toBe("sendonly");
        },
      );
    }

    negotiationCase(
      "several m-sections pair each transceiver at most once and only by its origin",
      { ref: "#816 5-6" },
      async (c) => {
        // Arrange: a は audio + video 2 本、b は addTrack() の video と audio、addTransceiver() の video を持つ。
        const { a, b } = await c.given(createPairingPeers(mode));
        a.addTransceiver("audio");
        a.addTransceiver("video");
        a.addTransceiver("video");
        const { transceiver: bVideo } = addTrackTransceiver(b, "video");
        const { transceiver: bAudio } = addTrackTransceiver(b, "audio");
        const own = b.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
          direction: "sendonly",
        });

        // Act: remote offer を適用し、answer で確定する。
        await c.offer(a);
        await c.answer(b);

        // Assert: addTrack() の transceiver は両モードで関連付く。own は legacy だけ 2 本目の video に関連付き、standard では remote offer 用に新しい transceiver を作る。
        expect(bAudio.mid).toBe("0");
        const mids = b
          .getTransceivers()
          .map((t) => t.mid)
          .filter((mid) => mid != null);
        expect(new Set(mids).size).toBe(mids.length);
        expect([...mids].sort()).toEqual(["0", "1", "2"]);
        expect(bVideo.mid).toBe("1");
        expect(own.mid).toBe(paired ? "2" : null);
        expect(own.direction).toBe("sendonly");
        expect(b.getTransceivers().length).toBe(paired ? 3 : 4);

        // Act: 同じ MID の re-offer を適用する。
        await c.negotiate(a);

        // Assert: re-offer は MID で同じ transceiver に関連付き、増えない。
        expect(bAudio.mid).toBe("0");
        expect(b.getTransceivers().length).toBe(paired ? 3 : 4);
      },
    );

    negotiationCase(
      "glare: the polite peer's implicit rollback keeps its sendonly addTransceiver(), and plan and apply pair the same transceiver",
      { ref: "#816 5-7 2.4" },
      async (c) => {
        // Arrange: 両側が sendonly の video を addTransceiver() し、同時に offer する (どちらの pending offer も MID "0")。
        // b の transceiver は H264 だけを codec preference にする (codec の解決に使われたら answer が H264 だけになる)。
        const { a, b } = await c.given(createPairingPeers(mode));
        const aOut = new MediaStreamTrack({ kind: "video" });
        const bOut = new MediaStreamTrack({ kind: "video" });
        const aVideo = a.addTransceiver(aOut, { direction: "sendonly" });
        const bVideo = b.addTransceiver(bOut, { direction: "sendonly" });
        bVideo.setCodecPreferences([useH264()]);
        await c.offer(a, { hold: true });
        await c.offer(b, { hold: true });
        expect(bVideo.mid).toBe("0");

        // Act: polite な b が a の offer を受け取る (暗黙の rollback)。
        await c.setRemote(b, a.localDescription);
        const answer = await b.createAnswer();

        // Assert: standard では b の sendonly はそのままで MID を失い、offer には新しい transceiver が答える。
        // codec は answer する transceiver (preference なし) で解決され、VP8 が先頭に残る。
        expect(bVideo.direction).toBe("sendonly");
        expect(bVideo.mid).toBe(paired ? "0" : null);
        expect(b.getTransceivers().length).toBe(paired ? 1 : 2);
        const formats = answer.sdp.match(/^m=video \d+ \S+ (.+)$/m)![1];
        const vp8 = answer.sdp.match(/^a=rtpmap:(\d+) VP8\/90000/m)?.[1];
        expect(formats.split(" ").includes(vp8!)).toBe(!paired);

        // Act: answer を確定し、b が自分の video を offer する。
        await c.setLocal(b, answer);
        await c.setRemote(a, b.localDescription);
        if (!paired) await c.negotiate(b);

        // Assert: standard では両方向とも sendonly の transceiver から RTP が流れる。
        expect(bVideo.direction).toBe("sendonly");
        expect(aVideo.direction).toBe("sendonly");
        if (paired) return;
        expect(bVideo.currentDirection).toBe("sendonly");
        expect(aVideo.currentDirection).toBe("sendonly");
        const bReceiver = b
          .getTransceivers()
          .find((t) => t.mid === aVideo.mid)!;
        const aReceiver = a
          .getTransceivers()
          .find((t) => t.mid === bVideo.mid)!;
        await c.waitFor(() => connected(a, b));
        await c.rtp(aOut, bReceiver.receiver.track);
        await c.rtp(bOut, aReceiver.receiver.track);
      },
    );

    negotiationCase(
      "a remote transceiver addTrack() reused is promoted by the rollback and paired by the next offer",
      { ref: "#816 5-8 2.3" },
      async (c) => {
        // Arrange: a の video offer で b に remote transceiver ができ、b の app が addTrack() でそれを再利用する。
        const { a, b } = await c.given(createPairingPeers(mode));
        const aOut = new MediaStreamTrack({ kind: "video" });
        const aVideo = a.addTransceiver(aOut, { direction: "sendrecv" });
        await c.offer(a);
        const [remote] = b.getTransceivers();
        const { track: bOut, transceiver: reused } = addTrackTransceiver(
          b,
          "video",
        );
        expect(reused).toBe(remote);

        // Act: b が remote offer を rollback する。
        await c.setRemote(b, "rollback");

        // Assert: track を持つ transceiver は MID を外して残る。
        expect(b.getTransceivers()).toEqual([remote]);
        expect(remote.mid).toBe(null);

        // Act: a の offer を適用し直し、answer で確定する。
        await c.setRemote(b, a.localDescription);
        await c.answer(b);

        // Assert: 両モードで同じ transceiver が再び関連付き、両方向の RTP が流れる。
        expect(b.getTransceivers()).toEqual([remote]);
        expect(remote.mid).toBe("0");
        expect(remote.currentDirection).toBe("sendrecv");
        await c.waitFor(() => connected(a, b));
        await c.rtp(aOut, remote.receiver.track);
        await c.rtp(bOut, aVideo.receiver.track);
      },
    );

    negotiationCase(
      "a replacement remote offer keeps the transceiver it created when an addTransceiver() is unassociated",
      {
        ref: "#816 2.4; origin: model property scene (replacement remote offer)",
      },
      async (c) => {
        // Arrange: a は addTransceiver() の video を持ち、b の video offer を受け取る。
        const { a, b } = await c.given(createPairingPeers(mode));
        const own = a.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
          direction: "sendrecv",
        });
        const { track: bOut } = addTrackTransceiver(b, "video");
        await c.offer(b);
        const before = [...a.getTransceivers()];

        // Act: b が同じ MID の offer を作り直し、a に再適用して answer する。
        await c.offer(b);
        await c.answer(a);

        // Assert: replacement offer は MID で同じ transceiver に関連付き、transceiver は増えない。
        expect(a.getTransceivers()).toEqual(before);
        const receiving = a.getTransceivers().find((t) => t.mid === "0")!;
        expect(receiving === own).toBe(paired);
        await c.waitFor(() => connected(a, b));
        await c.rtp(bOut, receiving.receiver.track);
      },
    );
  });
}
