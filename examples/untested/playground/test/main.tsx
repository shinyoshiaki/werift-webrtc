import "buffer";
import { Red } from "werift-rtp/src";

/* eslint-disable @typescript-eslint/ban-ts-comment */
(async () => {
  const caller = new RTCPeerConnection();
  const callee = new RTCPeerConnection({
    //@ts-ignore
    encodedInsertableStreams: true,
  });

  const receiverTransform = (receiver: RTCRtpReceiver) => {
    const receiverStreams = (receiver as any).createEncodedStreams();
    const readableStream = receiverStreams.readable;
    const writableStream = receiverStreams.writable;
    const transformStream = new TransformStream({
      transform: (encodedFrame, controller) => {
        const data = encodedFrame.data;
        const red = Red.deSerialize(Buffer.from(data));
        console.log(red);
        controller.enqueue(encodedFrame);
      },
    });
    readableStream.pipeThrough(transformStream).pipeTo(writableStream);
  };
  callee.ontrack = (ev) => {
    receiverTransform(ev.receiver);
  };

  const [track] = (
    await navigator.mediaDevices.getUserMedia({ audio: true })
  ).getTracks();
  caller.addTrack(track);
  {
    const [transceiver] = caller.getTransceivers() as any;
    const { codecs } = RTCRtpSender.getCapabilities("audio");
    transceiver.setCodecPreferences([
      codecs.find((c) => c.mimeType.includes("red")),
      ...codecs,
    ]);
  }

  caller.setLocalDescription(await caller.createOffer());
  await new Promise<void>((r) => {
    caller.onicecandidate = (ev) => {
      if (ev.candidate == undefined) r();
    };
  });
  await callee.setRemoteDescription(caller.localDescription);
  // {
  //   const [transceiver] = callee.getTransceivers() as any;
  //   const { codecs } = RTCRtpSender.getCapabilities("audio");
  //   transceiver.setCodecPreferences([
  //     ...codecs.filter((c) => !c.mimeType.includes("red")),
  //   ]);
  // }
  await callee.setLocalDescription(await callee.createAnswer());

  await caller.setRemoteDescription(callee.localDescription);

  console.log(caller.localDescription.sdp, callee.localDescription.sdp);
})();
