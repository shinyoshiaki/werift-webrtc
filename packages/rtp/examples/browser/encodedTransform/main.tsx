import "buffer";

import { Red } from "werift-rtp";

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

  const [transceiver] = sender.getTransceivers() as any;
  const { codecs } = RTCRtpSender.getCapabilities("audio");
  transceiver.setCodecPreferences([
    codecs.find((c) => c.mimeType.includes("red")),
    ...codecs,
  ]);

  await sender.setLocalDescription(await sender.createOffer());
  await new Promise<void>((r) => {
    sender.onicecandidate = ({ candidate }) => {
      if (!candidate) r();
    };
  });
  console.log(sender.localDescription.sdp);
  await receiver.setRemoteDescription(sender.localDescription);
  await receiver.setLocalDescription(await receiver.createAnswer());
  await sender.setRemoteDescription(receiver.localDescription);

  const senderTransform = (sender: RTCRtpSender) => {
    const senderStreams = (sender as any).createEncodedStreams();
    const readableStream = senderStreams.readable;
    const writableStream = senderStreams.writable;
    const transformStream = new TransformStream({
      transform: (encodedFrame, controller) => {
        const packet = Red.deSerialize(Buffer.from(encodedFrame.data));
        console.log(packet);

        controller.enqueue(encodedFrame);
      },
    });
    readableStream.pipeThrough(transformStream).pipeTo(writableStream);
  };

  senderTransform(rtpSender);
})();
