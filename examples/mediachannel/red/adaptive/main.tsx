/* eslint-disable @typescript-eslint/ban-ts-comment */
import React, { FC, useRef } from "react";
import ReactDOM from "react-dom";
import "buffer";
import { Red } from "werift-rtp";
import { getAudioStream, uint32Add } from "./util";

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

    setInterval(async () => {
      const stats = await peer.getStats();
      const arr = [...(stats as any).values()];
      const remoteInbound = arr.find((a) =>
        a.id.includes("RTCRemoteInboundRtpAudioStream")
      );
      if (remoteInbound) {
        const { fractionLost } = remoteInbound;
        console.log(fractionLost);
        redSender.distance = Math.floor(fractionLost * 10);
        console.log(redSender.distance);
      }
    }, 1000);

    const { stream } = await getAudioStream(await file.arrayBuffer(), 1);
    const [track] = stream.getTracks();
    const sender = peer.addTrack(track);
    senderTransform(sender);

    await peer.setRemoteDescription(offer);
    const answer = await peer.createAnswer();
    await peer.setLocalDescription(answer);
  };

  return (
    <div>
      <div style={{ display: "flex" }}>
        <input type="file" onChange={(e) => onFile(e.target.files[0])} />
        <div>
          <audio controls ref={remoteRef} autoPlay />
        </div>
      </div>
    </div>
  );
};

ReactDOM.render(<App />, document.getElementById("root"));

class RedSender {
  cache: { buffer: Buffer; timestamp: number }[] = [];
  cacheSize = 10;
  distance = 1;

  push(payload: { buffer: Buffer; timestamp: number }) {
    this.cache.push(payload);
    if (this.cache.length > this.cacheSize) {
      this.cache.shift();
    }
  }

  build() {
    const redundantPayloads = this.cache.slice(-(this.distance + 1));
    const presentPayload = redundantPayloads.pop();
    const red = new Red();
    redundantPayloads.forEach((redundant) => {
      red.payloads.push({
        bin: redundant.buffer,
        blockPT: 97,
        timestampOffset: uint32Add(
          presentPayload.timestamp,
          -redundant.timestamp
        ),
      });
    });
    red.payloads.push({ bin: presentPayload.buffer, blockPT: 97 });
    return red;
  }
}
const redSender = new RedSender();

const senderTransform = (sender: RTCRtpSender) => {
  const senderStreams = (sender as any).createEncodedStreams();
  const readableStream = senderStreams.readable;
  const writableStream = senderStreams.writable;
  const transformStream = new TransformStream({
    transform: (encodedFrame, controller) => {
      const packet = Red.deSerialize(Buffer.from(encodedFrame.data));
      const newPayload = packet.payloads.at(-1);
      redSender.push({
        buffer: newPayload.bin,
        timestamp: encodedFrame.timestamp,
      });
      const red = redSender.build().serialize();

      encodedFrame.data = red.buffer.slice(
        red.byteOffset,
        red.byteOffset + red.byteLength
      );
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
      // console.log("receive", red);
      controller.enqueue(encodedFrame);
    },
  });
  readableStream.pipeThrough(transformStream).pipeTo(writableStream);
};
