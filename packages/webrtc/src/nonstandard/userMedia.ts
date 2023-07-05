import { ChildProcess, exec } from "child_process";
import { createSocket } from "dgram";
import { setImmediate } from "timers/promises";
import { v4 } from "uuid";

import { randomPort } from "../../../common/src";
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

abstract class MediaPlayer {
  protected streamId = v4();
  audio = new MediaStreamTrack({ kind: "audio", streamId: this.streamId });
  video = new MediaStreamTrack({ kind: "video", streamId: this.streamId });
  protected process!: ChildProcess;
  stopped = false;

  constructor(
    protected videoPort: number,
    protected audioPort: number,
    protected path: string,
    protected loop?: boolean
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

  stop() {
    this.stopped = true;
    this.process.kill("SIGINT");
  }
}

export class MediaPlayerMp4 extends MediaPlayer {
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
}

export class MediaPlayerWebm extends MediaPlayer {
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
}
