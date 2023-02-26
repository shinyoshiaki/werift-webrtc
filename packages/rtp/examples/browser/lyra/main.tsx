import { decodeWithLyra, encodeWithLyra, isLyraReady } from "lyra-codec";
import * as sdpTransform from "sdp-transform";

(async () => {
  const sender = new RTCPeerConnection({
    encodedInsertableStreams: true,
  } as any);
  const receiver = new RTCPeerConnection({
    encodedInsertableStreams: true,
  } as any);

  const [track] = (
    await navigator.mediaDevices.getUserMedia({ audio: true })
  ).getTracks();

  const rtpSender = sender.addTrack(track);

  const senderTransform = (sender: RTCRtpSender) => {
    const senderStreams = (sender as any).createEncodedStreams();
    const readableStream = senderStreams.readable;
    const writableStream = senderStreams.writable;
    const transformStream = new TransformStream({
      transform: (chunk, controller) => {
        const samples = new Int16Array(chunk.data);
        const buffer = Float32Array.from(samples).map((x) => x / 0x8000);

        const encoded = encodeWithLyra(buffer, 16000);
        chunk.data = encoded.buffer;
        controller.enqueue(chunk);
      },
    });
    readableStream.pipeThrough(transformStream).pipeTo(writableStream);
  };
  senderTransform(rtpSender);

  const offer = await sender.createOffer();
  const offerSdp = sdpTransform.parse(offer.sdp ?? "");
  {
    const media = offerSdp.media[0];
    const defaultRtp = media.rtp;
    const [lastPt] = defaultRtp.map((r) => r.payload).reverse();
    const l16Pt = lastPt + 1;
    media.rtp = [{ payload: l16Pt, codec: "L16", rate: 16000 }, ...defaultRtp];
    media.fmtp.push({ payload: l16Pt, config: "ptime=20" });
    media.payloads = `${l16Pt} ${media.payloads}`;
  }
  const mungingOffer = sdpTransform.write(offerSdp);
  console.log(mungingOffer);
  await sender.setLocalDescription({ sdp: mungingOffer, type: "offer" });
  await new Promise<void>((r) => {
    sender.onicecandidate = ({ candidate }) => {
      if (!candidate) r();
    };
  });
  console.log(sender.localDescription.sdp);
  await receiver.setRemoteDescription(sender.localDescription);

  const answer = await receiver.createAnswer();
  const answerSdp = sdpTransform.parse(answer.sdp ?? "");
  {
    const media = answerSdp.media[0];
    const defaultRtp = media.rtp;
    const [lastPt] = defaultRtp.map((r) => r.payload).reverse();
    const l16Pt = lastPt + 1;
    media.rtp = [{ payload: l16Pt, codec: "L16", rate: 16000 }, ...defaultRtp];
    media.fmtp.push({ payload: l16Pt, config: "ptime=20" });
    media.payloads = `${l16Pt} ${media.payloads}`;
  }
  const mungingAnswer = sdpTransform.write(answerSdp);
  console.log(mungingAnswer);
  await receiver.setLocalDescription({ type: "answer", sdp: mungingAnswer });

  await sender.setRemoteDescription(receiver.localDescription);
})();
