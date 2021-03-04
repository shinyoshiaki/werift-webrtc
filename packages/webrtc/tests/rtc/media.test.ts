import { RTCPeerConnection, useSdesMid } from "../../src";
import { isMedia } from "../../src/utils";
import { RtpHeader, RtpPacket } from "../../../rtp/src";

describe("media", () => {
  test("test_sendonly_recvonly", async (done) => {
    const sendonly = new RTCPeerConnection();
    const transceiver = sendonly.addTransceiver("video", "sendonly");
    transceiver.sender.onReady.subscribe(() => {
      const rtpPacket = new RtpPacket(
        new RtpHeader(),
        Buffer.from("test")
      ).serialize();
      expect(isMedia(rtpPacket)).toBe(true);
      transceiver.sendRtp(rtpPacket);
    });

    const recvonly = new RTCPeerConnection();
    recvonly.onTransceiver.subscribe((transceiver) => {
      transceiver.onTrack.subscribe((track) => {
        track.onRtp.subscribe((rtp) => {
          expect(rtp.payload).toEqual(Buffer.from("test"));
          done();
        });
      });
    });

    await sendonly.setLocalDescription(await sendonly.createOffer());
    await recvonly.setRemoteDescription(sendonly.localDescription!);
    await recvonly.setLocalDescription(await recvonly.createAnswer());
    await sendonly.setRemoteDescription(recvonly.localDescription!);
  });

  test("test_sendrecv_sendrecv", async (done) => {
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();

    (async () => {
      await Promise.all([
        new Promise<void>((r) => {
          const transceiver = pc1.addTransceiver("video", "sendrecv");
          transceiver.onTrack.subscribe((track) => {
            track.onRtp.subscribe((rtp) => {
              expect(rtp.payload).toEqual(Buffer.from("pc2"));
              r();
            });
          });
          transceiver.sender.onReady.subscribe(() => {
            const rtpPacket = new RtpPacket(
              new RtpHeader(),
              Buffer.from("pc1")
            ).serialize();
            expect(isMedia(rtpPacket)).toBe(true);
            transceiver.sendRtp(rtpPacket);
          });
        }),
        new Promise<void>((r) => {
          const transceiver = pc2.addTransceiver("video", "sendrecv");
          transceiver.sender.onReady.subscribe(() => {
            const rtpPacket = new RtpPacket(
              new RtpHeader(),
              Buffer.from("pc2")
            ).serialize();
            expect(isMedia(rtpPacket)).toBe(true);
            transceiver.sendRtp(rtpPacket);
          });

          transceiver.onTrack.subscribe((track) => {
            track.onRtp.subscribe((rtp) => {
              expect(rtp.payload).toEqual(Buffer.from("pc1"));
              r();
            });
          });
        }),
      ]);
      done();
    })();

    await pc1.setLocalDescription(await pc1.createOffer());
    await pc2.setRemoteDescription(pc1.localDescription!);
    await pc2.setLocalDescription(await pc2.createAnswer());
    await pc1.setRemoteDescription(pc2.localDescription!);
  });

  test("rtp_extension", async () => {
    const pc1 = new RTCPeerConnection({
      headerExtensions: { video: [useSdesMid()] },
    });
    pc1.addTransceiver("video", "sendrecv");
    const pc2 = new RTCPeerConnection({
      headerExtensions: { video: [useSdesMid()] },
    });

    await pc1.setLocalDescription(await pc1.createOffer());
    //@ts-expect-error
    const pc1Local = pc1._localDescription!;
    expect(pc1Local.media[0].rtp.headerExtensions[0].uri).toBe(
      useSdesMid().uri
    );
    await pc2.setRemoteDescription(pc1.localDescription!);
    await pc2.setLocalDescription(await pc2.createAnswer());
    //@ts-expect-error
    const pc2Local = pc2._localDescription!;
    expect(pc2Local.media[0].rtp.headerExtensions[0].uri).toBe(
      useSdesMid().uri
    );
    await pc1.setRemoteDescription(pc2.localDescription!);
  });
});
