import {
  RTCPeerConnection,
  MediaStreamTrack,
  RTCRtpCodecParameters,
  RtpPacket,
  ConnectionState,
  RtcpPacket,
  RTCIceCandidate,
} from "../../packages/webrtc/src";
import { Subject, ReplaySubject, Observable } from "rxjs";
import { BasicPeerConnection } from "ring-client-api/lib/streaming/peer-connection";

export class CustomPeerConnection implements BasicPeerConnection {
  private pc;
  onAudioRtp = new Subject<RtpPacket>();
  onAudioRtcp = new Subject<RtcpPacket>();
  onVideoRtp = new Subject<RtpPacket>();
  onVideoRtcp = new Subject<RtcpPacket>();
  onIceCandidate = new Observable<RTCIceCandidate>();
  onConnectionState = new ReplaySubject<ConnectionState>(1);
  returnAudioTrack = new MediaStreamTrack({ kind: "audio" });

  constructor() {
    const pc = (this.pc = new RTCPeerConnection({
        codecs: {
          video: [
            new RTCRtpCodecParameters({
              mimeType: "video/H264",
              clockRate: 90000,
              rtcpFeedback: [
                { type: "transport-cc" },
                { type: "ccm", parameter: "fir" },
                { type: "nack" },
                { type: "nack", parameter: "pli" },
                { type: "goog-remb" },
              ],
              parameters:
                "packetization-mode=1;profile-level-id=640029;level-asymmetry-allowed=1",
            }),
          ],
        },
        iceTransportPolicy: "all",
        bundlePolicy: "disable",
      })),
      audioTransceiver = pc.addTransceiver(this.returnAudioTrack, {
        direction: "sendrecv",
      }),
      videoTransceiver = pc.addTransceiver("video", {
        direction: "recvonly",
      });

    audioTransceiver.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((rtp) => {
        this.onAudioRtp.next(rtp);
      });

      track.onReceiveRtcp.subscribe((rtcp) => {
        this.onAudioRtcp.next(rtcp);
      });
    });

    videoTransceiver.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((rtp) => {
        this.onVideoRtp.next(rtp);
      });

      track.onReceiveRtcp.subscribe((rtcp) => {
        this.onVideoRtcp.next(rtcp);
      });

      track.onReceiveRtp.once(() => {
        setInterval(
          () => videoTransceiver.receiver.sendRtcpPLI(track.ssrc!),
          2000
        );
      });
    });
    this.pc.onIceCandidate.subscribe((iceCandidate) => {
      this.onIceCandidate.pipe(iceCandidate);
    });

    pc.iceConnectionStateChange.subscribe(() => {
      if (pc.iceConnectionState === "closed") {
        this.onConnectionState.next("closed");
      }
    });
    pc.connectionStateChange.subscribe(() => {
      this.onConnectionState.next(pc.connectionState);
    });
  }

  async createOffer() {
    const offer = await this.pc.createOffer();
    await this.pc.setLocalDescription(offer);

    return offer;
  }

  async createAnswer(offer: { type: "offer"; sdp: string }) {
    await this.pc.setRemoteDescription(offer);
    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    return answer;
  }

  async acceptAnswer(answer: { type: "answer"; sdp: string }) {
    console.log("answer", answer.sdp);
    await this.pc.setRemoteDescription(answer);
  }

  addIceCandidate(candidate: RTCIceCandidate) {
    console.log("candidate", candidate);
    return this.pc.addIceCandidate(candidate);
  }

  close() {
    this.pc.close().catch(() => {});
  }
}
