/* eslint-disable @typescript-eslint/ban-ts-comment */
import "buffer";
import { Red } from "werift-rtp";
import { Counter, peer, sleep } from "../fixture";

describe("mediachannel_red", () => {
  const receiverTransform = (
    receiver: RTCRtpReceiver,
    expectPT: number,
    done: () => void
  ) => {
    const receiverStreams = (receiver as any).createEncodedStreams();
    const readableStream = receiverStreams.readable;
    const writableStream = receiverStreams.writable;
    const counter = new Counter(2, done);
    let count = 1;
    const transformStream = new TransformStream({
      transform: (encodedFrame, controller) => {
        const data = encodedFrame.data;
        const red = Red.deSerialize(Buffer.from(data));
        expect(red.payloads.length).toBe(count);
        if (count < 3) {
          count++;
        }
        for (const payload of red.payloads) {
          expect(payload.blockPT).toBe(expectPT);
        }
        if (count === 3) {
          counter.done();
        }
        controller.enqueue(encodedFrame);
      },
    });
    readableStream.pipeThrough(transformStream).pipeTo(writableStream);
  };

  const mediachannel_red_client_answer = "mediachannel_red_client_answer";
  it(
    mediachannel_red_client_answer,
    async () =>
      new Promise<void>(async (done) => {
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        const pc = new RTCPeerConnection({
          //@ts-ignore
          encodedInsertableStreams: true,
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(mediachannel_red_client_answer, {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };
        pc.ontrack = async (ev) => {
          const receiver = ev.receiver;
          receiverTransform(receiver, 97, () => {
            pc.close();
            done();
          });
        };

        const offer = await peer.request(mediachannel_red_client_answer, {
          type: "init",
        });
        await pc.setRemoteDescription(offer);
        await pc.setLocalDescription(await pc.createAnswer());

        peer
          .request(mediachannel_red_client_answer, {
            type: "answer",
            payload: pc.localDescription,
          })
          .catch(() => {});
      }),
    10 * 1000
  );

  const mediachannel_red_client_offer = "mediachannel_red_client_offer";
  it(
    mediachannel_red_client_offer,
    async () =>
      new Promise<void>(async (done) => {
        if (!peer.connected) await new Promise<void>((r) => peer.on("open", r));
        await sleep(100);

        await peer.request(mediachannel_red_client_offer, { type: "init" });

        const pc = new RTCPeerConnection({
          //@ts-ignore
          encodedInsertableStreams: true,
          iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
        });
        pc.ontrack = async (ev) => {
          const receiver = ev.receiver;
          receiverTransform(receiver, 111, () => {
            pc.close();
            done();
          });
        };
        pc.onicecandidate = ({ candidate }) => {
          peer
            .request(mediachannel_red_client_offer, {
              type: "candidate",
              payload: candidate,
            })
            .catch(() => {});
        };

        const transceiver = pc.addTransceiver("audio", {
          direction: "recvonly",
        });

        const { codecs } = RTCRtpSender.getCapabilities("audio")!;
        (transceiver as any).setCodecPreferences([
          codecs.find((c) => c.mimeType.includes("red")),
          ...codecs,
        ]);

        await pc.setLocalDescription(await pc.createOffer());
        const answer = await peer.request(mediachannel_red_client_offer, {
          type: "offer",
          payload: pc.localDescription,
        });
        await pc.setRemoteDescription(answer);
      }),
    10 * 1000
  );
});
