import { setTimeout } from "timers/promises";
import {
  type BundlePolicy,
  MediaStreamTrack,
  RTCPeerConnection,
  RtcpSrPacket,
  RtpHeader,
  RtpPacket,
} from "../../../src";
import {
  ringCentralOffer,
  withoutAddresslessRtcp,
  withoutSsrcAndMidExtension,
} from "../../issue/356.fixture";

/**
 * Shared Arrange of #356 at the PeerConnection level: the reported RingCentral
 * offer, and werift peers whose offer has no `a=ssrc` and no MID extension.
 */

/**
 * Arrange (PeerConnection level, #356): answer the RingCentral offer, which has
 * no `a=ssrc`, and capture the track `ontrack` announced. RTP is fed to the
 * receiving DTLS transport's `onRtp`, as SRTP decryption would, without ICE.
 */
export async function answerRingCentral() {
  const pc = new RTCPeerConnection();
  const announced: MediaStreamTrack[] = [];
  pc.ontrack = ({ track }) => announced.push(track);
  // #355 が直るまでは a=rtcp:48037 だけを除く (fixture 自体は原文のまま)。
  await pc.setRemoteDescription({
    type: "offer",
    sdp: withoutAddresslessRtcp(ringCentralOffer),
  });
  await pc.setLocalDescription(await pc.createAnswer());
  const [transceiver] = pc.getTransceivers();
  const dtls = transceiver.receiver.dtlsTransport;
  const payloads: string[] = [];
  announced[0].onReceiveRtp.subscribe((rtp) =>
    payloads.push(rtp.payload.toString()),
  );
  const rtp = (ssrc: number, payloadType: number, sequenceNumber: number) =>
    new RtpPacket(
      new RtpHeader({ ssrc, payloadType, sequenceNumber, timestamp: 160 }),
      Buffer.from(`pt${payloadType}-${sequenceNumber}`),
    );
  return { pc, announced, transceiver, dtls, payloads, rtp };
}

/**
 * Arrange (PeerConnection level, #356): pc1 sends `kinds` (one track each) to
 * pc2 over real ICE / DTLS, with SSRCs and the MID extension removed from its
 * offer, as a peer without them does. Each sent payload is `<kind><index>`.
 * `bundlePolicy: "disable"` gives every m-line its own transport.
 */
export async function connectWithoutSsrc(
  kinds: ("audio" | "video")[],
  options: { bundlePolicy?: BundlePolicy } = {},
) {
  const pc1 = new RTCPeerConnection({ bundlePolicy: options.bundlePolicy });
  const pc2 = new RTCPeerConnection();
  const sent = kinds.map((kind) => {
    const track = new MediaStreamTrack({ kind });
    const transceiver = pc1.addTransceiver(track, { direction: "sendonly" });
    return { kind, track, transceiver };
  });
  const announced: MediaStreamTrack[] = [];
  pc2.ontrack = ({ track }) => announced.push(track);

  await pc1.setLocalDescription(await pc1.createOffer());
  await pc2.setRemoteDescription({
    type: "offer",
    sdp: withoutSsrcAndMidExtension(pc1.localDescription!.sdp),
  });
  await pc2.setLocalDescription(await pc2.createAnswer());
  await pc1.setRemoteDescription(pc2.localDescription!);
  await Promise.all(
    sent.map(
      ({ transceiver }) =>
        new Promise<void>((resolve) =>
          transceiver.sender.onReady.subscribe(() => resolve()),
        ),
    ),
  );

  const received = announced.map((track) => {
    const payloads: string[] = [];
    track.onReceiveRtp.subscribe((rtp) =>
      payloads.push(rtp.payload.toString()),
    );
    return payloads;
  });
  const reportsFrom = announced.map((track) => {
    const ssrcs: number[] = [];
    track.onReceiveRtcp.subscribe((packet) => {
      if (packet instanceof RtcpSrPacket) ssrcs.push(packet.ssrc);
    });
    return ssrcs;
  });
  const sendAll = async (count: number) => {
    for (let i = 0; i < count; i++) {
      sent.forEach(({ kind, track }, index) =>
        track.writeRtp(
          new RtpPacket(new RtpHeader(), Buffer.from(`${kind}${index}`)),
        ),
      );
      await setTimeout(20);
    }
  };
  const senderSsrcs = sent.map(({ transceiver }) => transceiver.sender.ssrc);
  const close = () => Promise.all([pc1.close(), pc2.close()]);
  return {
    pc1,
    pc2,
    announced,
    received,
    reportsFrom,
    senderSsrcs,
    sendAll,
    close,
  };
}
