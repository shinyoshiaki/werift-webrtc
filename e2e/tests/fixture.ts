import { Peer, WebSocketTransport } from "protoo-client";

const transport = new WebSocketTransport("ws://localhost:8886");
export const peer = new Peer(transport);

export async function waitVideoPlay(track: MediaStreamTrack) {
  const video = document.createElement("video");
  const media = new MediaStream();
  media.addTrack(track);
  video.srcObject = media;
  video.autoplay = true;
  video.load();
  video.width = 100;
  video.height = 100;
  const canvas = document.createElement("canvas");
  document.body.appendChild(canvas);
  const context = canvas.getContext("2d")!;
  canvas.width = video.width;
  canvas.height = video.height;
  context.drawImage(video, 0, 0, canvas.width, canvas.height);
  const snapshot = await digestMessage(
    context.getImageData(0, 0, canvas.width, canvas.height).data,
  );

  for (;;) {
    await new Promise((r) => setTimeout(r, 100));
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const data = await digestMessage(
      context.getImageData(0, 0, canvas.width, canvas.height).data,
    );

    if (snapshot !== data) break;
  }
}

async function digestMessage(data: Uint8ClampedArray) {
  const hashBuffer = await crypto.subtle.digest("SHA-1", data); // hash the message
  const hashArray = Array.from(new Uint8Array(hashBuffer)); // convert buffer to byte array
  const hashHex = hashArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join(""); // convert bytes to hex string
  return hashHex;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class Counter {
  private now = 0;
  constructor(private times: number, private finished: () => void) {}

  done() {
    if (++this.now === this.times) {
      this.finished();
    }
  }
}
