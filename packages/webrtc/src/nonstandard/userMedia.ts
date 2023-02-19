import { ChildProcess, exec } from "child_process";
import { createSocket } from "dgram";
import { setImmediate } from "timers/promises";
import { v4 } from "uuid";

import { randomPort, uint32Add } from "../../../common/src";
import { RtpPacket } from "../../../rtp/src";
import { MediaStreamTrack } from "../media/track";

export const getUserMedia = async (path: string, loop?: boolean) => {
  const audioPort = await randomPort();
  const videoPort = await randomPort();

  if (path.endsWith(".mp4")) {
    return new MediaPlayerMp4(audioPort, videoPort, path, loop);
  } else {
    return new MediaPlayerWebm(audioPort, videoPort, path, loop);
  }
};

export class MediaPlayerMp4 {
  private streamId = v4();
  audio = new MediaStreamTrack({ kind: "audio", streamId: this.streamId });
  video = new MediaStreamTrack({ kind: "video", streamId: this.streamId });
  private process!: ChildProcess;
  stopped = false;

  constructor(
    private videoPort: number,
    private audioPort: number,
    private path: string,
    private loop?: boolean
  ) {
    this.setupTrack(audioPort, this.audio);
    this.setupTrack(videoPort, this.video);
  }

  private setupTrack = (port: number, track: MediaStreamTrack) => {
    let payloadType = 0;

    const socket = createSocket("udp4");
    socket.bind(port);
    socket.on("message", async (buf) => {
      const rtp = RtpPacket.deSerialize(buf);
      if (!payloadType) {
        payloadType = rtp.header.payloadType;
      }

      // detect gStreamer restarted
      if (payloadType !== rtp.header.payloadType) {
        payloadType = rtp.header.payloadType;
        track.onSourceChanged.execute(rtp.header);
      }

      track.writeRtp(buf);
    });
  };

  async start() {
    let payloadType = 96;
    const run = async () => {
      if (payloadType > 100) payloadType = 96;

      const cmd = `gst-launch-1.0 filesrc location= ${this.path} ! \
qtdemux name=d ! \
queue ! h264parse ! rtph264pay config-interval=10 pt=${payloadType++} ! \
udpsink host=127.0.0.1 port=${this.videoPort} d. ! \
queue ! aacparse ! avdec_aac ! audioresample ! audioconvert ! opusenc ! rtpopuspay pt=${payloadType++} ! \
udpsink host=127.0.0.1 port=${this.audioPort}`;
      this.process = exec(cmd);

      if (this.loop) {
        await new Promise((r) => this.process.on("close", r));
        if (!this.stopped) {
          run();
        }
      }
    };
    await setImmediate();
    run();
  }

  stop() {
    this.stopped = true;
    this.process.kill("SIGINT");
  }
}

export class MediaPlayerWebm {
  private streamId = v4();
  audio = new MediaStreamTrack({ kind: "audio", streamId: this.streamId });
  video = new MediaStreamTrack({ kind: "video", streamId: this.streamId });
  private process!: ChildProcess;
  stopped = false;

  constructor(
    private videoPort: number,
    private audioPort: number,
    private path: string,
    private loop?: boolean
  ) {
    this.setupTrack(audioPort, this.audio);
    this.setupTrack(videoPort, this.video);
  }

  private setupTrack = (port: number, track: MediaStreamTrack) => {
    let payloadType = 0;
    let latestTimestamp = 0;
    let timestampDiff = 0;

    const socket = createSocket("udp4");
    socket.bind(port);
    socket.on("message", async (buf) => {
      const rtp = RtpPacket.deSerialize(buf);
      if (!payloadType) {
        payloadType = rtp.header.payloadType;
      }

      // detect gStreamer restarted
      if (payloadType !== rtp.header.payloadType) {
        payloadType = rtp.header.payloadType;
        track.onSourceChanged.execute(rtp.header);
        timestampDiff = uint32Add(rtp.header.timestamp, -latestTimestamp);
        console.log({ timestampDiff });
      }
      latestTimestamp = rtp.header.timestamp;
      rtp.header.timestamp = uint32Add(rtp.header.timestamp, -timestampDiff);
      track.writeRtp(rtp.serialize());
    });
  };

  async start() {
    let payloadType = 96;
    const run = async () => {
      if (payloadType > 100) payloadType = 96;

      const cmd = `gst-launch-1.0 filesrc location=${
        this.path
      } ! matroskademux name=d \
d.video_0 ! queue ! rtpvp8pay pt=${payloadType++} ! \
udpsink host=127.0.0.1 port=${this.videoPort} \
d.audio_0 ! queue ! rtpopuspay pt=${payloadType++} ! \
udpsink host=127.0.0.1 port=${this.audioPort}`;
      this.process = exec(cmd);
      console.log(cmd);

      if (this.loop) {
        await new Promise((r) => this.process.on("close", r));
        if (!this.stopped) {
          run();
        }
      }
    };
    await setImmediate();
    run();
  }

  stop() {
    this.stopped = true;
    this.process.kill("SIGINT");
  }
}
