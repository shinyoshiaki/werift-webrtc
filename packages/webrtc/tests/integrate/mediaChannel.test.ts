import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
  deserializeAudioLevelIndication,
  isMedia,
  serializeAudioLevelIndication,
  useSdesMid,
} from "../../src";
import { createConnectedSendrecvVideoPeers } from "../fixture";

describe("media", () => {
  test("test_sendonly_recvonly", async () =>
    new Promise<void>(async (done) => {
      const sendonly = new RTCPeerConnection();
      const track = new MediaStreamTrack({ kind: "video" });
      sendonly.addTransceiver(track, { direction: "sendonly" });
      sendonly.connectionStateChange
        .watch((v) => v === "connected")
        .then(() => {
          const rtpPacket = new RtpPacket(
            new RtpHeader(),
            Buffer.from("test"),
          ).serialize();
          expect(isMedia(rtpPacket)).toBe(true);
          track.writeRtp(rtpPacket);
        });

      const recvonly = new RTCPeerConnection();
      recvonly.onRemoteTransceiverAdded.subscribe((transceiver) => {
        transceiver.onTrack.subscribe((track) => {
          track.onReceiveRtp.subscribe(async (rtp) => {
            expect(rtp.payload).toEqual(Buffer.from("test"));
            await Promise.all([sendonly.close(), recvonly.close()]);
            done();
          });
        });
      });

      await sendonly.setLocalDescription(await sendonly.createOffer());
      await recvonly.setRemoteDescription(sendonly.localDescription!);
      await recvonly.setLocalDescription(await recvonly.createAnswer());
      await sendonly.setRemoteDescription(recvonly.localDescription!);
    }));

  test("test_sendrecv_sendrecv", async () =>
    new Promise<void>(async (done) => {
      const pc1 = new RTCPeerConnection();
      const pc2 = new RTCPeerConnection();

      (async () => {
        await Promise.all([
          new Promise<void>((r) => {
            const track = new MediaStreamTrack({ kind: "video" });
            const transceiver = pc1.addTransceiver(track);
            transceiver.onTrack.subscribe((track) => {
              track.onReceiveRtp.subscribe((rtp) => {
                expect(rtp.payload).toEqual(Buffer.from("pc2"));
                r();
              });
            });
            transceiver.sender.onReady.subscribe(() => {
              const rtpPacket = new RtpPacket(
                new RtpHeader(),
                Buffer.from("pc1"),
              ).serialize();
              expect(isMedia(rtpPacket)).toBe(true);
              track.writeRtp(rtpPacket);
            });
          }),
          new Promise<void>((r) => {
            const track = new MediaStreamTrack({ kind: "video" });
            const transceiver = pc2.addTransceiver(track);
            transceiver.sender.onReady.subscribe(() => {
              const rtpPacket = new RtpPacket(
                new RtpHeader(),
                Buffer.from("pc2"),
              ).serialize();
              expect(isMedia(rtpPacket)).toBe(true);
              track.writeRtp(rtpPacket);
            });

            transceiver.onTrack.subscribe((track) => {
              track.onReceiveRtp.subscribe((rtp) => {
                expect(rtp.payload).toEqual(Buffer.from("pc1"));
                r();
              });
            });
          }),
        ]);
        await Promise.all([pc1.close(), pc2.close()]);
        done();
      })();

      await pc1.setLocalDescription(await pc1.createOffer());
      await pc2.setRemoteDescription(pc1.localDescription!);
      await pc2.setLocalDescription(await pc2.createAnswer());
      await pc1.setRemoteDescription(pc2.localDescription!);
    }));

  test("rtp_extension", async () => {
    const pc1 = new RTCPeerConnection({
      headerExtensions: { video: [useSdesMid()] },
    });
    pc1.addTransceiver("video");
    const pc2 = new RTCPeerConnection({
      headerExtensions: { video: [useSdesMid()] },
    });

    await pc1.setLocalDescription(await pc1.createOffer());
    const pc1Local = pc1._localDescription!;
    expect(pc1Local.media[0].rtp.headerExtensions[0].uri).toBe(
      useSdesMid().uri,
    );
    await pc2.setRemoteDescription(pc1.localDescription!);
    await pc2.setLocalDescription(await pc2.createAnswer());
    const pc2Local = pc2._localDescription!;
    expect(pc2Local.media[0].rtp.headerExtensions[0].uri).toBe(
      useSdesMid().uri,
    );
    await pc1.setRemoteDescription(pc2.localDescription!);
  });

  test("test_sendonly_recvonly_audioLevel", async () =>
    new Promise<void>(async (done) => {
      const sendonly = new RTCPeerConnection();
      const track = new MediaStreamTrack({ kind: "audio" });
      sendonly.addTransceiver(track, { direction: "sendonly" });
      sendonly.connectionStateChange
        .watch((v) => v === "connected")
        .then(() => {
          const rtpPacket = new RtpPacket(
            new RtpHeader({
              extensions: [
                { id: 10, payload: serializeAudioLevelIndication(25) },
              ],
            }),
            Buffer.from("test"),
          ).serialize();
          expect(isMedia(rtpPacket)).toBe(true);
          track.writeRtp(rtpPacket);
        });

      const recvonly = new RTCPeerConnection();
      recvonly.onRemoteTransceiverAdded.subscribe((transceiver) => {
        transceiver.onTrack.subscribe((track) => {
          track.onReceiveRtp.subscribe(async (rtp) => {
            expect(rtp.header.extensions[0].id).toBe(10);
            expect(
              deserializeAudioLevelIndication(rtp.header.extensions[0].payload)
                .level,
            ).toEqual(25);
            expect(rtp.payload).toEqual(Buffer.from("test"));
            await Promise.all([sendonly.close(), recvonly.close()]);
            done();
          });
        });
      });

      await sendonly.setLocalDescription(await sendonly.createOffer());
      await recvonly.setRemoteDescription(sendonly.localDescription!);
      await recvonly.setLocalDescription(await recvonly.createAnswer());
      await sendonly.setRemoteDescription(recvonly.localDescription!);
    }));

  test("PLI reaches the remote sender in a sendrecv video session", async () => {
    // Arrange
    const { pc1, pc2, transceiver1, transceiver2 } =
      await createConnectedSendrecvVideoPeers();
    const pliReceived = transceiver1.sender.onPictureLossIndication.asPromise();
    const receiverRtcp: number[] = [];
    transceiver1.receiver.onRtcp.subscribe((rtcp) =>
      receiverRtcp.push(rtcp.type),
    );

    // Act: pc2 が pc1 の送信 SSRC に PLI を送る (sender SSRC は pc2 自身の送信 SSRC)
    await transceiver2.receiver.sendRtcpPLI(transceiver1.sender.ssrc);
    await pliReceived;

    // Assert: PLI は pc1 の sender に届き、同じ transceiver の receiver には誤配送されない
    expect(receiverRtcp).not.toContain(206);

    await Promise.all([pc1.close(), pc2.close()]);
  });
});
