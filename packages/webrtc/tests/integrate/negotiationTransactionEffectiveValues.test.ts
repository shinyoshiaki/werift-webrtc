import { useH264, useVP8 } from "../../src";
import {
  type DuplexSession,
  createDuplexSession,
  createMutationSession,
  expectMediaAlive,
  expectSessionAlive,
  heldTransports,
  mungeSection,
  mutate,
  prepareMutationAnswerer,
  sectionOf,
  sendAndExpectRtp,
  step,
  waitForMutationSession,
} from "./negotiationTransactionUtils";

const VIDEO = "0";

/**
 * Values a renegotiation pranswer makes effective before the final answer
 * (NEGOTIATION_TRANSACTION.md "Effective values while pending"). `step`
 * checks every value against `expectedLive` after each operation; these
 * scenarios drive the ones the matrix does not change.
 */
describe("negotiation effective values while a renegotiation is pending", () => {
  let session: DuplexSession;
  const offerer = () => session.a;
  const answerer = () => session.b;

  afterEach(async () => {
    await session.close();
  });

  /** Put a re-offer on both peers and return the answerer's answer SDP. */
  async function reoffer() {
    await step(session, async () =>
      offerer().pc.setLocalDescription(await offerer().pc.createOffer()),
    );
    await step(session, () =>
      answerer().pc.setRemoteDescription(offerer().pc.localDescription!),
    );
    return (await answerer().pc.createAnswer()).sdp;
  }

  test.each(["answer", "rollback"] as const)(
    "a pranswer sends with its codec on both sides until %s",
    async (outcome) => {
      // Arrange: VP8 で確立した後、answerer が H264 だけを選んだ answer を用意する。
      session = await createDuplexSession({
        codecs: { video: [useVP8(), useH264()] },
      });
      await step(session, async () =>
        offerer().pc.setLocalDescription(await offerer().pc.createOffer()),
      );
      await step(session, () =>
        answerer().pc.setRemoteDescription(offerer().pc.localDescription!),
      );
      answerer().video.setCodecPreferences([useH264()]);
      const answer = (await answerer().pc.createAnswer()).sdp;
      const sendCodecs = () =>
        [offerer(), answerer()].map((peer) =>
          peer.video.sender.codec?.mimeType.toLowerCase(),
        );

      // Act: H264 の pranswer を両側に適用する。
      await step(session, () =>
        answerer().pc.setLocalDescription({ type: "pranswer", sdp: answer }),
      );
      await step(session, () =>
        offerer().pc.setRemoteDescription({ type: "pranswer", sdp: answer }),
      );
      // Assert: 再交渉の pranswer 中は両側とも pranswer の H264 で送り、届く。
      expect(sendCodecs()).toEqual(["video/h264", "video/h264"]);
      await expectSessionAlive(session, `codec-pranswer-${outcome}`);

      if (outcome === "answer") {
        // Act: 同じ内容の final answer で commit する。
        await step(session, () =>
          answerer().pc.setLocalDescription({ type: "answer", sdp: answer }),
        );
        await step(session, () =>
          offerer().pc.setRemoteDescription({ type: "answer", sdp: answer }),
        );
        // Assert: H264 のまま確定する。
        expect(sendCodecs()).toEqual(["video/h264", "video/h264"]);
      } else {
        // Act: 両側で rollback する。
        await step(session, () =>
          offerer().pc.setLocalDescription({ type: "rollback" }),
        );
        await step(session, () =>
          answerer().pc.setRemoteDescription({ type: "rollback" }),
        );
        // Assert: 両側とも current の VP8 に戻る。
        expect(sendCodecs()).toEqual(["video/vp8", "video/vp8"]);
      }
      // Assert: 確定 / 復元した codec で双方向に届く。
      await expectSessionAlive(session, `codec-${outcome}`);
    },
  );

  test.each(["answer", "rollback"] as const)(
    "an inactive pranswer stops sending until a sendrecv %s",
    async (outcome) => {
      // Arrange: 確立済み session で、video を inactive にした pranswer を用意する。
      session = await createDuplexSession();
      const answer = await reoffer();
      const inactive = mungeSection(answer, VIDEO, (section) =>
        section.replace("a=sendrecv", "a=inactive"),
      );

      // Act: inactive の pranswer を両側に適用する。
      await step(session, () =>
        answerer().pc.setLocalDescription({ type: "pranswer", sdp: inactive }),
      );
      await step(session, () =>
        offerer().pc.setRemoteDescription({ type: "pranswer", sdp: inactive }),
      );
      // Assert: currentDirection は pranswer の inactive になり、両側とも送らない。
      expect(offerer().video.currentDirection).toBe("inactive");
      expect(answerer().video.currentDirection).toBe("inactive");
      await expect(
        sendAndExpectRtp(
          offerer().out,
          answerer().video.receiver.track,
          "inactive-a-to-b",
        ),
      ).rejects.toThrow("RTP was not received");
      await expect(
        sendAndExpectRtp(
          answerer().out,
          offerer().video.receiver.track,
          "inactive-b-to-a",
        ),
      ).rejects.toThrow("RTP was not received");

      if (outcome === "answer") {
        // Act: sendrecv の final answer で commit する。
        await step(session, () =>
          answerer().pc.setLocalDescription({ type: "answer", sdp: answer }),
        );
        await step(session, () =>
          offerer().pc.setRemoteDescription({ type: "answer", sdp: answer }),
        );
      } else {
        // Act: 両側で rollback し、current の sendrecv に戻す。
        await step(session, () =>
          offerer().pc.setLocalDescription({ type: "rollback" }),
        );
        await step(session, () =>
          answerer().pc.setRemoteDescription({ type: "rollback" }),
        );
      }
      // Assert: 送信が再開し、双方向に届く。
      expect(offerer().video.currentDirection).toBe("sendrecv");
      expect(answerer().video.currentDirection).toBe("sendrecv");
      await expectSessionAlive(session, `inactive-${outcome}`);
    },
  );

  test("SSRCs only a replaced pranswer announced stop routing at the final answer", async () => {
    // Arrange: answerer の video SSRC を wire 上で pranswer 用と final 用に書き換える。
    session = await createDuplexSession();
    const answer = await reoffer();
    const original = Number(
      /^a=ssrc:(\d+) /m.exec(sectionOf(answer, VIDEO))![1],
    );
    const withSsrc = (ssrc: number) =>
      mungeSection(answer, VIDEO, (section) =>
        section.replaceAll(`a=ssrc:${original} `, `a=ssrc:${ssrc} `),
      );
    const router = () =>
      (
        offerer().pc as unknown as {
          router: { ssrcTable: Record<number, unknown> };
        }
      ).router;
    const receiver = offerer().video.receiver;

    // Act: 別 SSRC の pranswer を offerer に適用する。
    await step(session, () =>
      answerer().pc.setLocalDescription({ type: "pranswer", sdp: answer }),
    );
    await step(session, () =>
      offerer().pc.setRemoteDescription({
        type: "pranswer",
        sdp: withSsrc(1111),
      }),
    );
    // Assert: pranswer の SSRC が新たに route され、current の SSRC も残る。
    expect(router().ssrcTable[1111]).toBe(receiver);
    expect(router().ssrcTable[original]).toBe(receiver);

    // Act: 別 SSRC の replacement pranswer を適用する。
    await step(session, () =>
      offerer().pc.setRemoteDescription({
        type: "pranswer",
        sdp: withSsrc(3333),
      }),
    );
    // Assert: 置き換えられた pranswer の SSRC は route から外れる。
    expect(router().ssrcTable[3333]).toBe(receiver);
    expect(router().ssrcTable[1111]).toBeUndefined();

    // Act: さらに別 SSRC の final answer で commit する。
    await step(session, () =>
      answerer().pc.setLocalDescription({ type: "answer", sdp: answer }),
    );
    await step(session, () =>
      offerer().pc.setRemoteDescription({
        type: "answer",
        sdp: withSsrc(2222),
      }),
    );
    // Assert: final answer の SSRC が route され、置き換えられた pranswer だけの
    // SSRC は届かなくなる (確定済み session の SSRC は develop と同じく残る)。
    expect(router().ssrcTable[2222]).toBe(receiver);
    expect(router().ssrcTable[3333]).toBeUndefined();
    expect(router().ssrcTable[original]).toBe(receiver);
  });

  test("a first pranswer with other SSRCs leaves the receiver's track to the final answer's SSRC", async () => {
    // Arrange: 初回交渉で、answerer の video SSRC を wire 上で書き換えた pranswer を用意する。
    session = await createMutationSession("initial");
    await step(session, async () =>
      offerer().pc.setLocalDescription(await offerer().pc.createOffer()),
    );
    await step(session, () =>
      answerer().pc.setRemoteDescription(offerer().pc.localDescription!),
    );
    await prepareMutationAnswerer(session);
    const answer = (await answerer().pc.createAnswer()).sdp;

    // Act: 別 SSRC の pranswer を適用し、offerer の track を控える。
    await step(session, () =>
      answerer().pc.setLocalDescription({ type: "pranswer", sdp: answer }),
    );
    await step(session, () =>
      offerer().pc.setRemoteDescription({
        type: "pranswer",
        sdp: mutate(answer, ["ssrcChanged"]),
      }),
    );
    const track = offerer().video.receiver.track;
    // Act: 実際の SSRC の final answer で確定する。
    await step(session, () =>
      answerer().pc.setLocalDescription({ type: "answer", sdp: answer }),
    );
    await step(session, () =>
      offerer().pc.setRemoteDescription({ type: "answer", sdp: answer }),
    );
    await waitForMutationSession(session);

    // Assert: receiver の track は同じ object のまま final answer の SSRC を受け取る。
    expect(offerer().video.receiver.track).toBe(track);
    expect(offerer().video.receiver.tracks).toEqual([track]);
    await expectMediaAlive(session, "first-pranswer-ssrc");
  });

  test("a transport a no-BUNDLE first pranswer added stays closed after the BUNDLE answer", async () => {
    // Arrange: 初回交渉で、BUNDLE なしの pranswer で transport を分けさせる。
    session = await createMutationSession("initial");
    await step(session, async () =>
      offerer().pc.setLocalDescription(await offerer().pc.createOffer()),
    );
    await step(session, () =>
      answerer().pc.setRemoteDescription(offerer().pc.localDescription!),
    );
    await prepareMutationAnswerer(session);
    const answer = (await answerer().pc.createAnswer()).sdp;
    await step(session, () =>
      answerer().pc.setLocalDescription({ type: "pranswer", sdp: answer }),
    );
    await step(session, () =>
      offerer().pc.setRemoteDescription({
        type: "pranswer",
        sdp: mutate(answer, ["noBundle"]),
      }),
    );
    const split = heldTransports(offerer().pc);

    // Act: BUNDLE の final answer で確定し、中断された checks が終わるのを待つ。
    await step(session, () =>
      answerer().pc.setLocalDescription({ type: "answer", sdp: answer }),
    );
    await step(session, () =>
      offerer().pc.setRemoteDescription({ type: "answer", sdp: answer }),
    );
    const dropped = [...split].filter(
      (transport) => !heldTransports(offerer().pc).has(transport),
    );
    await new Promise((resolve) => setTimeout(resolve, 200));

    // Assert: 外した transport の ICE は failed にならず closed のまま。
    expect(dropped.length).toBeGreaterThan(0);
    for (const transport of dropped) {
      expect(transport.iceTransport.state).toBe("closed");
    }
    await step(session, () => undefined);
  });
});
