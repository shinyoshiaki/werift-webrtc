/* eslint-disable @typescript-eslint/ban-ts-comment */
import React, { FC, useRef } from "react";
import ReactDOM from "react-dom";
import {
  Red,
  buffer2ArrayBuffer,
  RedEncoder,
} from "../../../../packages/rtp/src";
import { getAudioStream } from "./util";

const peer = new RTCPeerConnection({
  //@ts-ignore
  encodedInsertableStreams: true,
  iceServers: [],
});

const App: FC = () => {
  const remoteRef = useRef<HTMLAudioElement>();

  const onFile = async (file: File) => {
    const socket = new WebSocket("ws://127.0.0.1:8888");
    await new Promise((r) => (socket.onopen = r));
    console.log("open websocket");

    const offer = await new Promise<any>(
      (r) => (socket.onmessage = (ev) => r(JSON.parse(ev.data)))
    );
    console.log("offer", offer.sdp);

    peer.onicecandidate = ({ candidate }) => {
      if (!candidate) {
        const sdp = JSON.stringify(peer.localDescription);
        console.log("answer", peer.localDescription.sdp);
        socket.send(sdp);
      }
    };
    peer.ontrack = (e) => {
      remoteRef.current.srcObject = e.streams[0];
      receiverTransform(e.receiver);
    };

    const { stream } = await getAudioStream(await file.arrayBuffer(), 1);
    const [track] = stream.getTracks();
    const sender = peer.addTrack(track);
    senderTransform(sender);

    const [transceiver] = peer.getTransceivers() as any;
    const { codecs } = RTCRtpSender.getCapabilities("audio");
    transceiver.setCodecPreferences([
      codecs.find((c) => c.mimeType.includes("red")),
      ...codecs,
    ]);

    await peer.setRemoteDescription(offer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
  };

  return (
    <div>
      <input type="file" onChange={(e) => onFile(e.target.files[0])} />
      <div>
        <audio controls ref={remoteRef} autoPlay />
      </div>
    </div>
  );
};

ReactDOM.render(<App />, document.getElementById("root"));

const redEncoder = new RedEncoder(3);

const senderTransform = (sender: RTCRtpSender) => {
  const senderStreams = (sender as any).createEncodedStreams();
  const readableStream = senderStreams.readable;
  const writableStream = senderStreams.writable;
  const transformStream = new TransformStream({
    transform: (encodedFrame, controller) => {
      const packet = Red.deSerialize(encodedFrame.data);
      const newBlock = packet.blocks.at(-1);
      redEncoder.push({
        block: newBlock.block,
        blockPT: newBlock.blockPT,
        timestamp: encodedFrame.timestamp,
      });
      const red = redEncoder.build().serialize();
      encodedFrame.data = buffer2ArrayBuffer(red);
      controller.enqueue(encodedFrame);
    },
  });
  readableStream.pipeThrough(transformStream).pipeTo(writableStream);
};

const receiverTransform = (receiver: RTCRtpReceiver) => {
  const receiverStreams = (receiver as any).createEncodedStreams();
  const readableStream = receiverStreams.readable;
  const writableStream = receiverStreams.writable;
  const transformStream = new TransformStream({
    transform: (encodedFrame, controller) => {
      const data = encodedFrame.data;
      const red = Red.deSerialize(Buffer.from(data));
      console.log("receive", red);
      controller.enqueue(encodedFrame);
    },
  });
  readableStream.pipeThrough(transformStream).pipeTo(writableStream);
};
