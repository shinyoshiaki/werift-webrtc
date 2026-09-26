import type { AcceptFn } from "protoo-server";
import {
  type MLineReuse,
  MediaStreamTrack,
  RTCPeerConnection,
  type RTCRtpTransceiver,
  useOPUS,
} from "../../";
import { peerConfig } from "../../fixture";

/** transceiver の remote track で RTP を 1 パケット受信するまで待つ */
function waitRtp(transceiver: RTCRtpTransceiver, timeoutMs = 10_000) {
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    const subscribe = (track: MediaStreamTrack) =>
      track.onReceiveRtp.once(() => {
        clearTimeout(timer);
        resolve(true);
      });
    transceiver.receiver.tracks.forEach(subscribe);
    transceiver.onTrack.subscribe(subscribe);
  });
}

/**
 * Issue #705: werift offerer が removeTrack + stop → port 0 交渉 → 同じ index を
 * 新 MID で再利用する。Chromium は各 transceiver に camera を載せて送り返す。
 */
class mediachannel_reuse_offer_base {
  pc!: RTCPeerConnection;

  constructor(private readonly mLineReuse: MLineReuse) {}

  private async offer(accept: AcceptFn) {
    await this.pc.setLocalDescription(await this.pc.createOffer());
    accept(this.pc.localDescription);
  }

  private transceiverAt(index: number) {
    return this.pc.getTransceivers().find((t) => t.mLineIndex === index)!;
  }

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc?.close();
          this.pc = new RTCPeerConnection({
            ...(await peerConfig),
            mLineReuse: this.mLineReuse,
          });
          this.pc.addTransceiver(new MediaStreamTrack({ kind: "video" }));
          this.pc.addTransceiver(new MediaStreamTrack({ kind: "video" }));
          await this.offer(accept);
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
      case "removeAndStop":
        {
          const transceiver = this.transceiverAt(payload);
          this.pc.removeTrack(transceiver.sender);
          transceiver.stop();
          await this.offer(accept);
        }
        break;
      case "add":
        {
          this.pc.addTransceiver(new MediaStreamTrack({ kind: "video" }));
          await this.offer(accept);
        }
        break;
      case "check":
        {
          const transceiver = this.transceiverAt(payload);
          const received = await waitRtp(transceiver);
          accept({
            received,
            mid: transceiver.mid,
            transceivers: this.pc.getTransceivers().length,
          });
        }
        break;
      case "done":
        {
          this.pc.close();
          accept({});
        }
        break;
    }
  }
}

export class mediachannel_reuse_compatible extends mediachannel_reuse_offer_base {
  constructor() {
    super("compatible");
  }
}

export class mediachannel_reuse_aggressive extends mediachannel_reuse_offer_base {
  constructor() {
    super("aggressive");
  }
}

/**
 * Issue #705: 音声専用 werift が Chromium の audio + video offer に答え、
 * video を port 0 で拒否したまま audio を受信する。
 */
export class mediachannel_reject_unsupported_video {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc?.close();
          this.pc = new RTCPeerConnection({
            ...(await peerConfig),
            codecs: { audio: [useOPUS()], video: [] },
          });
          this.pc.onIceCandidate.subscribe(() => {});
          accept({});
        }
        break;
      case "offer":
        {
          await this.pc.setRemoteDescription(payload);
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          accept(this.pc.localDescription);
        }
        break;
      case "candidate":
        {
          await this.pc.addIceCandidate(payload);
          accept({});
        }
        break;
      case "check":
        {
          const audio = this.pc
            .getTransceivers()
            .find((t) => t.kind === "audio" && !t.stopped)!;
          const received = await waitRtp(audio);
          accept({
            received,
            videoRejected: this.pc
              .getTransceivers()
              .filter((t) => t.kind === "video")
              .every((t) => t.rejected),
          });
        }
        break;
      case "done":
        {
          this.pc.close();
          accept({});
        }
        break;
    }
  }
}
