import { type RTCPeerConnection, useH264, useVP8 } from "../../../src";
import {
  ANSWER_OR_ROLLBACK,
  describeCases,
  negotiationCase,
} from "../harness/negotiationCase";
import {
  createDuplexSession,
  createMutationSession,
  expectMediaAlive,
  heldTransports,
  mungeSection,
  mutate,
  prepareMutationAnswerer,
  ssrcOf,
  waitForMutationSession,
} from "../harness/negotiationTransactionUtils";

/** The SSRC routing table of the router of `pc`. */
const ssrcTable = (pc: RTCPeerConnection) =>
  (pc as unknown as { router: { ssrcTable: Record<number, unknown> } }).router
    .ssrcTable;

/**
 * Values a renegotiation pranswer makes effective before the final answer
 * (NEGOTIATION_TRANSACTION.md "Effective values while pending"). The runner
 * checks every value against `expectedLive` (the invariants) after each
 * operation; these scenarios drive the ones the matrix does not change.
 * Video is MID "0".
 */
describeCases(
  "negotiation effective values while a renegotiation is pending",
  () => {
    negotiationCase.for(ANSWER_OR_ROLLBACK)(
      "a pranswer sends with its codec on both sides until $finish",
      { ref: "2.2-1 2.2-8 2.2-9 2.4-4 2.10-2" },
      async (c, { finish }) => {
        // Arrange: VP8 で確立した後、answerer が H264 だけを選んだ answer を用意する。
        const { a, b, aVideo, bVideo } = await c.given(
          createDuplexSession({ codecs: { video: [useVP8(), useH264()] } }),
        );
        await c.offer(a);
        bVideo.setCodecPreferences([useH264()]);
        const answer = await b.createAnswer();
        const sendCodecs = () =>
          [aVideo, bVideo].map((t) => t.sender.codec?.mimeType.toLowerCase());

        // Act: H264 の pranswer を両側に適用する。
        await c.setLocal(b, answer, { type: "pranswer" });
        await c.setRemote(a, answer, { type: "pranswer" });

        // Assert: 再交渉の pranswer 中は両側とも pranswer の H264 で送り、届く。
        expect(sendCodecs()).toEqual(["video/h264", "video/h264"]);
        await c.alive();

        // Act: 同じ内容の final answer で commit する、または両側で rollback する。
        if (finish === "answer") {
          await c.setLocal(b, answer);
          await c.setRemote(a, answer);
        } else {
          await c.rollback(a);
        }

        // Assert: answer なら H264 のまま確定し、rollback なら両側とも current の VP8 に戻る。
        if (finish === "answer") {
          expect(sendCodecs()).toEqual(["video/h264", "video/h264"]);
        } else {
          expect(sendCodecs()).toEqual(["video/vp8", "video/vp8"]);
        }

        // Assert: 確定 / 復元した codec で双方向に届く。
        await c.alive();
      },
    );

    negotiationCase(
      "SSRCs only a replaced pranswer announced stop routing at the final answer",
      { ref: "2.1-4 2.2-7 2.2-13 2.2-14 2.4-1 2.5-13 2.10-4" },
      async (c) => {
        // Arrange: answerer の video SSRC を wire 上で pranswer 用と final 用に書き換える。
        const { a, b, aVideo } = await c.given(createDuplexSession());
        await c.offer(a);
        const answer = await b.createAnswer();
        const original = Number(ssrcOf(answer.sdp, "0"));
        const withSsrc = (ssrc: number) =>
          mungeSection(answer.sdp, "0", (section) =>
            section.replaceAll(`a=ssrc:${original} `, `a=ssrc:${ssrc} `),
          );
        const receiver = aVideo.receiver;

        // Act: 別 SSRC の pranswer を offerer に適用する。
        await c.setLocal(b, answer, { type: "pranswer" });
        await c.setRemote(a, withSsrc(1111), { type: "pranswer" });

        // Assert: pranswer の SSRC が新たに route され、current の SSRC も残る。
        expect(ssrcTable(a)[1111]).toBe(receiver);
        expect(ssrcTable(a)[original]).toBe(receiver);

        // Act: 別 SSRC の replacement pranswer を適用する。
        await c.setRemote(a, withSsrc(3333), { type: "pranswer" });

        // Assert: 置き換えられた pranswer の SSRC は route から外れる。
        expect(ssrcTable(a)[3333]).toBe(receiver);
        expect(Object.keys(ssrcTable(a))).not.toContain("1111");

        // Act: さらに別 SSRC の final answer で commit する。
        await c.setLocal(b, answer);
        await c.setRemote(a, withSsrc(2222), { type: "answer" });

        // Assert: final answer の SSRC が route され、置き換えられた pranswer だけの SSRC は届かなくなる (確定済み session の SSRC は develop と同じく残る)。
        expect(ssrcTable(a)[2222]).toBe(receiver);
        expect(Object.keys(ssrcTable(a))).not.toContain("3333");
        expect(ssrcTable(a)[original]).toBe(receiver);
      },
    );

    negotiationCase(
      "a first pranswer with other SSRCs leaves the receiver's track to the final answer's SSRC",
      { ref: "2.4-T6 2.10-4" },
      async (c) => {
        // Arrange: 初回交渉で、answerer の video SSRC を wire 上で書き換えた pranswer を用意する。
        const { a, b, session, aVideo } = await c.given(
          createMutationSession("initial"),
        );
        await c.offer(a);
        await prepareMutationAnswerer(session);
        const answer = await b.createAnswer();

        // Act: 別 SSRC の pranswer を適用し、offerer の track を控える。
        await c.setLocal(b, answer, { type: "pranswer" });
        await c.setRemote(a, mutate(answer.sdp, ["ssrcChanged"]), {
          type: "pranswer",
        });
        const track = aVideo.receiver.track;

        // Act: 実際の SSRC の final answer で確定する。
        await c.setLocal(b, answer);
        await c.setRemote(a, answer);
        await waitForMutationSession(session);

        // Assert: receiver の track は同じ object のまま final answer の SSRC を受け取る。
        expect(aVideo.receiver.track).toBe(track);
        expect(aVideo.receiver.tracks).toEqual([track]);
        await expectMediaAlive(session, "first-pranswer-ssrc");
      },
    );

    negotiationCase(
      "a transport a no-BUNDLE first pranswer added stays closed after the BUNDLE answer",
      { ref: "2.2-13 2.10-9" },
      async (c) => {
        // Arrange: 初回交渉で、BUNDLE なしの pranswer で transport を分けさせる。
        const { a, b, session } = await c.given(
          createMutationSession("initial"),
        );
        await c.offer(a);
        await prepareMutationAnswerer(session);
        const answer = await b.createAnswer();
        await c.setLocal(b, answer, { type: "pranswer" });
        await c.setRemote(a, mutate(answer.sdp, ["noBundle"]), {
          type: "pranswer",
        });
        const split = heldTransports(a);

        // Act: BUNDLE の final answer で確定し、中断された checks が終わるのを待つ。
        await c.setLocal(b, answer);
        await c.setRemote(a, answer);
        const dropped = [...split].filter(
          (transport) => !heldTransports(a).has(transport),
        );
        await c.sleep(200);

        // Assert: 外した transport の ICE は failed にならず closed のまま。
        expect(dropped.length).toBeGreaterThan(0);
        expect(
          dropped.filter(
            (transport) => transport.iceTransport.state !== "closed",
          ),
        ).toEqual([]);
        c.invariants();
      },
    );
  },
);
