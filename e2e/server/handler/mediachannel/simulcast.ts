import type { AcceptFn } from "protoo-server";
import {
  GenericNack,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCRtpReceiver,
  RtcpTransportLayerFeedback,
  RtpReceivePacketType,
  useNACK,
  usePLI,
  useRepairedRtpStreamId,
  useSdesMid,
  useSdesRTPStreamId,
} from "../../";
import { DtlsKeysContext } from "../../fixture";

export class mediachannel_simulcast_answer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
            dtls: { keys: await DtlsKeysContext.get() },
            headerExtensions: {
              video: [useSdesRTPStreamId()],
              audio: [],
            },
          });
          const transceiver = this.pc.addTransceiver("video", {
            direction: "recvonly",
            simulcast: [
              { rid: "high", direction: "recv" },
              { rid: "low", direction: "recv" },
            ],
          });
          const multiCast = {
            high: this.pc.addTransceiver("video", { direction: "sendonly" }),
            low: this.pc.addTransceiver("video", { direction: "sendonly" }),
          };
          transceiver.onTrack.subscribe((track) => {
            const sender = multiCast[track.rid as keyof typeof multiCast];
            if (sender) {
              sender.sender.replaceTrack(track);
            }
          });
          await this.pc.setLocalDescription(await this.pc.createOffer());
          accept(this.pc.localDescription);
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
    }
  }
}

export class mediachannel_simulcast_offer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
            dtls: { keys: await DtlsKeysContext.get() },
            headerExtensions: {
              video: [useSdesRTPStreamId()],
              audio: [],
            },
          });
          const transceiver = this.pc.addTransceiver("video", {
            direction: "recvonly",
          });
          const multiCast = {
            high: this.pc.addTransceiver("video", { direction: "sendonly" }),
            low: this.pc.addTransceiver("video", { direction: "sendonly" }),
          };
          transceiver.onTrack.subscribe((track) => {
            const sender = multiCast[track.rid as keyof typeof multiCast];
            if (sender) {
              sender.sender.replaceTrack(track);
            }
          });
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
    }
  }
}

/**
 * Simulcast with RTX (RFC 4588) and `repaired-rtp-stream-id`, without
 * `a=ssrc` lines. werift NACKs a recently received packet of each layer and
 * waits for Chrome's RTX to arrive restored on that layer's track.
 */
export class mediachannel_simulcast_rtx_answer {
  pc!: RTCPeerConnection;
  private readonly repaired = new Set<string>();
  private readonly onRepaired: (() => void)[] = [];
  private nackTimers: ReturnType<typeof setInterval>[] = [];

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
            dtls: { keys: await DtlsKeysContext.get() },
            codecs: {
              video: [
                new RTCRtpCodecParameters({
                  mimeType: "video/VP8",
                  clockRate: 90000,
                  rtcpFeedback: [useNACK(), usePLI()],
                }),
                new RTCRtpCodecParameters({
                  mimeType: "video/rtx",
                  clockRate: 90000,
                }),
              ],
              audio: [],
            },
            headerExtensions: {
              video: [
                useSdesMid(),
                useSdesRTPStreamId(),
                useRepairedRtpStreamId(),
              ],
              audio: [],
            },
          });
          this.pc.connectionStateChange.subscribe((state) => {
            if (state === "closed" || state === "failed") this.stopNack();
          });
          const transceiver = this.pc.addTransceiver("video", {
            direction: "recvonly",
            simulcast: [
              { rid: "high", direction: "recv" },
              { rid: "low", direction: "recv" },
            ],
          });
          const multiCast = {
            high: this.pc.addTransceiver("video", { direction: "sendonly" }),
            low: this.pc.addTransceiver("video", { direction: "sendonly" }),
          };
          transceiver.onTrack.subscribe((track) => {
            const sender = multiCast[track.rid as keyof typeof multiCast];
            if (sender) {
              sender.sender.replaceTrack(track);
              this.requestRetransmission(transceiver.receiver, track);
            }
          });
          await this.pc.setLocalDescription(await this.pc.createOffer());
          accept(this.pc.localDescription);
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
      case "repaired":
        {
          // 両レイヤーで RTX から復元したパケットを受けるまで待つ。
          await new Promise<void>((resolve) => {
            const check = () => {
              if (this.repaired.size === 2) resolve();
              else this.onRepaired.push(check);
            };
            check();
          });
          this.stopNack();
          accept({ rids: [...this.repaired].sort() });
        }
        break;
    }
  }

  /** NACK a packet the layer already delivered until its RTX comes back. */
  private requestRetransmission(
    receiver: RTCRtpReceiver,
    track: MediaStreamTrack,
  ) {
    const rid = track.rid!;
    let latest: { ssrc: number; seq: number } | undefined;
    track.onReceiveRtp.subscribe((rtp, _ext, info) => {
      if (info?.type === RtpReceivePacketType.retransmission) {
        if (rtp.header.ssrc === latest?.ssrc && !this.repaired.has(rid)) {
          this.repaired.add(rid);
          this.onRepaired.splice(0).forEach((f) => f());
        }
        return;
      }
      latest = { ssrc: rtp.header.ssrc, seq: rtp.header.sequenceNumber };
    });
    const timer = setInterval(() => {
      if (!latest || this.repaired.has(rid)) return;
      const nack = new GenericNack({
        senderSsrc: receiver.rtcpSsrc,
        mediaSourceSsrc: latest.ssrc,
        lost: [(latest.seq - 3 + 0x10000) & 0xffff],
      });
      receiver.dtlsTransport
        .sendRtcp([new RtcpTransportLayerFeedback({ feedback: nack })])
        .catch(() => {});
    }, 200);
    this.nackTimers.push(timer);
  }

  private stopNack() {
    this.nackTimers.forEach(clearInterval);
    this.nackTimers = [];
  }
}
