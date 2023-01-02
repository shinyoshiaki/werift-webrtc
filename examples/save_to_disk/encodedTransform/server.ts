import {
  RTCPeerConnection,
  RtpPacket,
  RtpSourceStream,
  WebmStream,
  DepacketizerInput,
  DepacketizerOutput,
  WebmStreamOutput,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { ReadableStreamDefaultReadResult, TransformStream } from "stream/web";
import { appendFile, open } from "fs/promises";

const server = new Server({ port: 8888 });
console.log("start");

server.on("connection", async (socket) => {
  const pc = new RTCPeerConnection({});
  pc.addTransceiver("video", { direction: "recvonly" });

  await pc.setLocalDescription(await pc.createOffer());
  const sdp = JSON.stringify(pc.localDescription);
  socket.send(sdp);

  socket.on("message", (data: any) => {
    pc.setRemoteDescription(JSON.parse(data));
  });
});

const mediaServer = new Server({ port: 8889 });
mediaServer.on("connection", (socket) => {
  socket.on("message", (data: Buffer) => {
    const rtp = RtpPacket.deSerialize(data);
    source.push(rtp);
  });
});

const webm = new WebmStream(
  [
    {
      width: 640,
      height: 480,
      kind: "video",
      codec: "VP8",
      clockRate: 90000,
      trackNumber: 1,
    },
  ],
  { duration: 1000 * 60 * 60 * 24 }
);

const transform = new TransformStream<DepacketizerInput, DepacketizerOutput>({
  transform: (input, output) => {
    if (input.rtp) {
      const frame = {
        data: input.rtp.payload,
        isKeyframe: input.rtp.header.marker,
        timestamp: input.rtp.header.timestamp,
      };
      output.enqueue({ frame });
    } else {
      output.enqueue({ eol: true });
    }
  },
});

setTimeout(() => {
  console.log("stop");
  source.stop();
}, 15_000);

const source = new RtpSourceStream();
source.readable.pipeThrough(transform).pipeTo(webm.videoStream);

const path = "./encoded.webm";
const reader = webm.webmStream.getReader();
const readChunk = async ({
  value,
  done,
}: ReadableStreamDefaultReadResult<WebmStreamOutput>) => {
  if (done) return;
  if (value.saveToFile) {
    await appendFile(path, value.saveToFile);
  } else if (value.eol) {
    const { durationElement } = value.eol;
    const handler = await open(path, "r+");
    await handler.write(durationElement, 0, durationElement.length, 83);
    await handler.close();
  }
  reader.read().then(readChunk);
};
reader.read().then(readChunk);
