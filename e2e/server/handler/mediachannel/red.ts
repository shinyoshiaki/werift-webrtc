import type { ChildProcess } from "child_process";
import { createSocket } from "dgram";
import type { AcceptFn } from "protoo-server";
import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  randomPort,
} from "../../";
import { DtlsKeysContext } from "../../fixture";
import { spawnGstreamerPipeline, stopGstreamerProcess } from "../../gstreamer";

export class mediachannel_red_client_answer {
  pc!: RTCPeerConnection;
  process?: ChildProcess;
  udp = createSocket("udp4");

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          const port = await randomPort();
          this.udp.bind(port);

          this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
            dtls: { keys: await DtlsKeysContext.get() },
            codecs: {
              audio: [
                new RTCRtpCodecParameters({
                  mimeType: "audio/red",
                  clockRate: 48000,
                  channels: 2,
                }),
                new RTCRtpCodecParameters({
                  mimeType: "audio/opus",
                  clockRate: 48000,
                  channels: 2,
                }),
              ],
            },
          });
          const track = new MediaStreamTrack({ kind: "audio" });
          this.pc.addTrack(track);
          await this.pc.setLocalDescription(await this.pc.createOffer());
          accept(this.pc.localDescription);

          this.udp.on("message", (data) => {
            track.writeRtp(data);
          });

          this.process = spawnGstreamerPipeline([
            "audiotestsrc wave=ticks",
            "audioconvert",
            "audioresample",
            "queue",
            "opusenc",
            "rtpopuspay",
            `udpsink host=127.0.0.1 port=${port}`,
          ]);
        }
        break;
      case "candidate":
        {
          await this.pc.addIceCandidate(payload);
          accept({});
        }
        break;
      case "answer":
        {
          await this.pc.setRemoteDescription(payload);
          accept({});
        }
        break;
      case "done":
        {
          this.udp.close();
          await stopGstreamerProcess(this.process);
          this.pc.close();
          accept({});
        }
        break;
    }
  }
}

export class mediachannel_red_client_offer {
  pc!: RTCPeerConnection;
  process?: ChildProcess;
  udp = createSocket("udp4");

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
            dtls: { keys: await DtlsKeysContext.get() },
            codecs: {
              audio: [
                new RTCRtpCodecParameters({
                  mimeType: "audio/red",
                  clockRate: 48000,
                  channels: 2,
                }),
                new RTCRtpCodecParameters({
                  mimeType: "audio/opus",
                  clockRate: 48000,
                  channels: 2,
                }),
              ],
            },
          });
          accept({});
        }
        break;
      case "offer":
        {
          const port = await randomPort();
          this.udp.bind(port);

          const track = new MediaStreamTrack({ kind: "audio" });
          this.pc.addTrack(track);

          await this.pc.setRemoteDescription(payload);
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          accept(this.pc.localDescription);

          this.udp.on("message", (data) => {
            track.writeRtp(data);
          });

          this.process = spawnGstreamerPipeline([
            "audiotestsrc wave=ticks",
            "audioconvert",
            "audioresample",
            "queue",
            "opusenc",
            "rtpopuspay",
            `udpsink host=127.0.0.1 port=${port}`,
          ]);
        }
        break;
      case "candidate":
        {
          await this.pc.addIceCandidate(payload);
          accept({});
        }
        break;
      case "done":
        {
          this.udp.close();
          await stopGstreamerProcess(this.process);
          this.pc.close();
          accept({});
        }
        break;
    }
  }
}
