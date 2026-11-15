import type { AcceptFn } from "protoo-server";
import {
  type MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCRtpReceiver,
  type RTCRtpTransceiver,
  type RtpPacket,
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
          // JSEP 5.10: the browser's offer (simulcast sendonly, recvonly,
          // recvonly) gets its own transceivers: receive the layers on the
          // first and send each back on one of the others.
          const remote: RTCRtpTransceiver[] = [];
          const multiCast = {
            high: () => remote[1],
            low: () => remote[2],
          };
          this.pc.onRemoteTransceiverAdded.subscribe((transceiver) => {
            remote.push(transceiver);
            if (remote.length > 1) {
              transceiver.setDirection("sendonly");
              return;
            }
            transceiver.onTrack.subscribe((track) => {
              const sender = multiCast[track.rid as keyof typeof multiCast]?.();
              if (sender) {
                sender.sender.replaceTrack(track);
              }
            });
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
 * `a=ssrc` lines. A media packet of each layer is lost before the receiver
 * sees it; werift's own NACK asks for it and Chrome's RTX must arrive
 * restored (media SSRC and sequence number) on that layer's track.
 */
export class mediachannel_simulcast_rtx_answer {
  pc!: RTCPeerConnection;
  private readonly repaired = new Set<string>();
  private readonly onRepaired: (() => void)[] = [];
  /** `ssrc:seq` of the media packets lost on purpose. */
  private readonly dropped = new Set<string>();

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
          this.loseMediaPackets(transceiver.receiver);
          transceiver.onTrack.subscribe((track) => {
            const sender = multiCast[track.rid as keyof typeof multiCast];
            if (sender) {
              sender.sender.replaceTrack(track);
              this.watchRepair(track);
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
          accept({ rids: [...this.repaired].sort() });
        }
        break;
    }
  }

  /**
   * Lose the 50th media packet of each layer, and again every 100 packets
   * until the layer is repaired, as if it were lost on the wire: the
   * receiver never sees it, so its NACK asks Chrome for a real hole.
   */
  private loseMediaPackets(receiver: RTCRtpReceiver) {
    const ridBySsrc = new Map<number, string>();
    const countByRid = new Map<string, number>();
    const lose = (packet: RtpPacket, rid: string | undefined) => {
      if (rid === undefined || this.repaired.has(rid)) return false;
      if (packet.header.padding || packet.payload.length === 0) return false;
      const count = (countByRid.get(rid) ?? 0) + 1;
      countByRid.set(rid, count);
      if (count % 100 !== 50) return false;
      this.dropped.add(`${packet.header.ssrc}:${packet.header.sequenceNumber}`);
      return true;
    };
    const byRid = receiver.handleRtpByRid;
    const bySsrc = receiver.handleRtpBySsrc;
    // rid 付きは媒体パケットだけ。RTX SSRC は ridBySsrc に入らないので落とさない。
    receiver.handleRtpByRid = (packet, rid, extensions) => {
      ridBySsrc.set(packet.header.ssrc, rid);
      if (!lose(packet, rid)) byRid(packet, rid, extensions);
    };
    receiver.handleRtpBySsrc = (packet, extensions) => {
      if (!lose(packet, ridBySsrc.get(packet.header.ssrc))) {
        bySsrc(packet, extensions);
      }
    };
  }

  /** Mark the layer repaired when a lost packet arrives restored from RTX. */
  private watchRepair(track: MediaStreamTrack) {
    const rid = track.rid!;
    track.onReceiveRtp.subscribe((rtp, _ext, info) => {
      if (info?.type !== RtpReceivePacketType.retransmission) return;
      const key = `${rtp.header.ssrc}:${rtp.header.sequenceNumber}`;
      if (this.dropped.has(key) && !this.repaired.has(rid)) {
        this.repaired.add(rid);
        this.onRepaired.splice(0).forEach((f) => f());
      }
    });
  }
}
