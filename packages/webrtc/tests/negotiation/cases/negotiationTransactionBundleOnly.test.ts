import { expect } from "vitest";

import { MediaStreamTrack, type RTCPeerConnection } from "../../../src";
import { describeCases, negotiationCase } from "../harness/negotiationCase";
import {
  candidateLayout,
  createDuplexSession,
  createPeerPair,
  toBundleOnlyOffer,
  waitForCommittedNomination,
  waitForConnection,
} from "../harness/negotiationTransactionUtils";

/** The m-line section of `mid` in `sdp`. */
const sectionOf = (sdp: string, mid: string) =>
  sdp
    .split(/(?=^m=)/m)
    .slice(1)
    .find((section) => new RegExp(`^a=mid:${mid}\\r?$`, "m").test(section))!;

/** Shape of an m-line of an answer: port, `c=`, direction and `a=bundle-only`. */
const answerShape = (sdp: string, mid: string) => {
  const section = sectionOf(sdp, mid);
  return {
    port: Number(section.match(/^m=\S+ (\d+)/)![1]),
    connection: section.match(/^c=([^\r\n]+)/m)?.[1],
    bundleOnly: /^a=bundle-only\r?$/m.test(section),
    inactive: /^a=inactive\r?$/m.test(section),
  };
};

/**
 * `pc` offers (createOffer + setLocalDescription unchanged) and the other peer
 * receives the offer as a bundle-only offerer writes it (`toBundleOnlyOffer`).
 * Returns the delivered SDP.
 */
const offerBundleOnly = async (
  c: Parameters<Parameters<typeof negotiationCase>[2]>[0],
  pc: RTCPeerConnection,
  remote: RTCPeerConnection,
  options: { iceRestart?: boolean; mids?: (sdp: string) => string[] } = {},
) => {
  await c.setLocal(
    pc,
    await pc.createOffer({ iceRestart: options.iceRestart }),
  );
  const sdp = pc.localDescription!.sdp;
  const delivered = toBundleOnlyOffer(sdp, options.mids?.(sdp));
  await c.setRemote(remote, delivered, { type: "offer" });
  return delivered;
};

/**
 * Firefox 157 offers the non-tagged m-lines of BUNDLE as port 0 +
 * `a=bundle-only` (RFC 8843 §6) in a re-offer that adds an m-line, in an ICE
 * restart offer and in a `max-bundle` first offer (ticket 21a27c92). werift
 * accepts such an m-line into BUNDLE (RFC 8843 §7.3.3) and answers it like
 * any bundled non-tagged m-line (port 9 + `c=IN IP4 0.0.0.0`, no
 * `a=bundle-only`, as Chrome and Firefox answer). A rejected m-line keeps
 * port 0 and carries `c=` (RFC 8866 §5.7), which Firefox requires.
 */
describeCases("negotiation: bundle-only offers (ticket 21a27c92)", () => {
  negotiationCase(
    "[bundle-only-1] a re-offer that adds a bundle-only video is accepted into BUNDLE",
    { ref: "ticket 21a27c92 §5.6; RFC 8843 §7.3.3" },
    async (c) => {
      // Arrange: video + DataChannel の BUNDLE で接続し、a に video を追加する。
      const { a, b } = await c.given(createDuplexSession());
      const out = new MediaStreamTrack({ kind: "video" });
      const added = a.addTransceiver(out, { direction: "sendonly" });

      // Act: 追加した m-line だけを bundle-only にした offer を b に渡し、answer する。
      const offer = await offerBundleOnly(c, a, b, {
        mids: () => [added.mid!],
      });
      await c.answer(b);

      // Assert: 届いた offer では追加分が port 0 + bundle-only だった。
      expect(answerShape(offer, added.mid!)).toMatchObject({
        port: 0,
        bundleOnly: true,
      });
      // Assert: answer は追加分を group に入れ、port 9 + c=0.0.0.0 で受け入れ、bundle-only を付けない。
      const answer = b.localDescription!.sdp;
      const layout = candidateLayout(answer);
      expect(layout.bundle[0]).toContain(added.mid!);
      expect(answerShape(answer, added.mid!)).toEqual({
        port: 9,
        connection: "IN IP4 0.0.0.0",
        bundleOnly: false,
        inactive: false,
      });
      // Assert: b の remoteDescription は受け取った SDP のまま (port 0 + bundle-only)。
      expect(answerShape(b.remoteDescription!.sdp, added.mid!)).toMatchObject({
        port: 0,
        bundleOnly: true,
      });
      // Assert: 追加した video の RTP が tag の transport で届く。
      const remote = b.getTransceivers().find((t) => t.mid === added.mid)!;
      expect(remote.currentDirection).toBe("recvonly");
      expect(remote.dtlsTransport).toBe(b.getTransceivers()[0].dtlsTransport);
      await c.rtp(out, remote.receiver.track);
      await c.alive();
    },
  );

  negotiationCase(
    "[bundle-only-2] an ICE restart offer whose accepted non-tagged m-lines are bundle-only keeps them",
    { ref: "ticket 21a27c92 §5.3-6; RFC 8843 §7.5.1" },
    async (c) => {
      // Arrange: video + DataChannel の BUNDLE で接続し、b の transceiver と ufrag を控える。
      const { a, b } = await c.given(createDuplexSession());
      const before = b
        .getTransceivers()
        .map((t) => [t.mid, t.currentDirection]);
      const tagUfrag = candidateLayout(b.remoteDescription!.sdp);

      // Act: 非tag をすべて bundle-only にした ICE restart offer を b に渡し、answer する。
      const offer = await offerBundleOnly(c, a, b, { iceRestart: true });
      await c.answer(b);

      // Assert: 非tag は届いた offer で bundle-only だった。
      const offered = candidateLayout(offer);
      const [tag, ...members] = offered.bundle[0];
      expect(members.length).toBeGreaterThan(0);
      for (const mid of members) {
        expect(answerShape(offer, mid)).toMatchObject({
          port: 0,
          bundleOnly: true,
        });
      }
      // Assert: answer の group は offer と同じで、非tag は port 9 + c= で受け入れる。
      const answer = b.localDescription!.sdp;
      expect(candidateLayout(answer).bundle).toEqual([[tag, ...members]]);
      for (const mid of members) {
        expect(answerShape(answer, mid)).toMatchObject({
          port: 9,
          connection: "IN IP4 0.0.0.0",
          bundleOnly: false,
        });
      }
      // Assert: tag の ufrag は新しい generation になり、transceiver は止まらない。
      expect(offered.media[tag].ufrag).not.toBe(tagUfrag.media[tag].ufrag);
      expect(
        b.getTransceivers().map((t) => [t.mid, t.currentDirection]),
      ).toEqual(before);
      expect(b.getTransceivers().every((t) => !t.stopped)).toBe(true);
      // Assert: 新しい generation で RTP と DataChannel が往復する。
      await Promise.all([
        waitForCommittedNomination(a),
        waitForCommittedNomination(b),
      ]);
      await c.alive();
    },
  );

  negotiationCase(
    "[bundle-only-3] a max-bundle first offer with bundle-only non-tagged m-lines is answered",
    { ref: "ticket 21a27c92 §5.6; RFC 8843 §6" },
    async (c) => {
      // Arrange: max-bundle の a が video 2 本 + DataChannel を持つ。
      const { a, b } = await c.given(
        createPeerPair({ bundlePolicy: "max-bundle" }, {}),
      );
      const aOut = new MediaStreamTrack({ kind: "video" });
      const bOut = new MediaStreamTrack({ kind: "video" });
      a.addTransceiver(aOut, { direction: "sendrecv" });
      const second = new MediaStreamTrack({ kind: "video" });
      a.addTransceiver(second, { direction: "sendonly" });
      const aChannel = a.createDataChannel("bundle-only");
      const bChannel = b.onDataChannel.asPromise().then(([channel]) => channel);

      // Act: tag 以外をすべて bundle-only にした初回 offer に b が answer する。
      const offer = await offerBundleOnly(c, a, b);
      const [bVideo, bSecond] = b.getTransceivers();
      bVideo.direction = "sendrecv";
      await bVideo.sender.replaceTrack(bOut);
      await c.answer(b);
      await Promise.all([waitForConnection(a), waitForConnection(b)]);

      // Assert: 非tag は届いた offer で bundle-only、answer では group に入り port 9 + c=。
      const [tag, ...members] = candidateLayout(offer).bundle[0];
      expect(members).toHaveLength(2);
      const answer = b.localDescription!.sdp;
      expect(candidateLayout(answer).bundle).toEqual([[tag, ...members]]);
      for (const mid of members) {
        expect(answerShape(offer, mid).bundleOnly).toBe(true);
        expect(answerShape(answer, mid)).toMatchObject({
          port: 9,
          connection: "IN IP4 0.0.0.0",
          bundleOnly: false,
        });
      }
      // Assert: 全 video と DataChannel が 1 つの transport で往復する。
      expect(b.dtlsTransports).toHaveLength(1);
      await c.rtp(aOut, bVideo.receiver.track);
      await c.rtp(bOut, a.getTransceivers()[0].receiver.track);
      await c.rtp(second, bSecond.receiver.track);
      await c.data(aChannel, await bChannel);
    },
  );

  negotiationCase.for([
    {
      when: "the answerer uses bundlePolicy disable",
      answerer: { bundlePolicy: "disable" },
      leaveOut: false,
    },
    {
      when: "the bundle-only MID is in no BUNDLE group",
      answerer: {},
      leaveOut: true,
    },
  ] as const)(
    "[bundle-only-4] a bundle-only m-line is rejected with c= when $when",
    { ref: "ticket 21a27c92 §5.3-7; JSEP §5.10; RFC 8866 §5.7" },
    async (c, { answerer, leaveOut }) => {
      // Arrange: answerer の設定で video + DataChannel を交渉して接続し、a に video を追加する。
      const { a: a2, b: b2 } = await c.given(createPeerPair({}, answerer));
      a2.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
        direction: "sendrecv",
      });
      a2.createDataChannel("bundle-only");
      await c.negotiate(a2);
      await Promise.all([waitForConnection(a2), waitForConnection(b2)]);
      const added = a2.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
        direction: "sendonly",
      });

      // Act: 追加分を bundle-only にした offer (leaveOut: group からも外す) に answer する。
      await c.setLocal(a2, await a2.createOffer());
      let delivered = toBundleOnlyOffer(a2.localDescription!.sdp, [added.mid!]);
      if (leaveOut) {
        delivered = delivered.replace(
          /^a=group:BUNDLE ([^\r\n]+)/m,
          (_, items: string) =>
            `a=group:BUNDLE ${items
              .split(" ")
              .filter((mid) => mid !== added.mid)
              .join(" ")}`,
        );
      }
      await c.setRemote(b2, delivered, { type: "offer" });
      await c.answer(b2);

      // Assert: 追加分は拒否 (port 0 + inactive) され、c= を持ち、group に入らない。
      const answer = b2.localDescription!.sdp;
      expect(answerShape(answer, added.mid!)).toEqual({
        port: 0,
        connection: "IN IP4 0.0.0.0",
        bundleOnly: false,
        inactive: true,
      });
      for (const group of candidateLayout(answer).bundle) {
        expect(group).not.toContain(added.mid);
      }
      // Assert: 拒否された offerer の transceiver は止まる。
      expect(added.stopped).toBe(true);
    },
  );

  negotiationCase(
    "[bundle-only-5] rolling back a bundle-only re-offer restores the session",
    { ref: "ticket 21a27c92 §5.4 rollback" },
    async (c) => {
      // Arrange: video + DataChannel の BUNDLE で接続し、a に video を追加する。
      const { a, b } = await c.given(createDuplexSession());
      const before = b.getTransceivers().map((t) => t.mid);
      a.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
        direction: "sendonly",
      });

      // Act: 追加分を bundle-only にした offer を b に渡してから、両側を rollback する。
      await offerBundleOnly(c, a, b);
      await c.rollback(a);

      // Assert: b は stable に戻り、関連付けた transceiver の MID が外れる。
      expect(b.signalingState).toBe("stable");
      expect(
        b
          .getTransceivers()
          .map((t) => t.mid)
          .filter((mid) => mid != undefined),
      ).toEqual(before);
      await c.alive();
    },
  );
});
