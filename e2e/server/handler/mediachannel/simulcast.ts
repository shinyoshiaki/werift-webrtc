import { AcceptFn } from "protoo-server";
import { useSdesRTPStreamId, RTCPeerConnection } from "../../";

export class mediachannel_simulcast_answer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection({
            iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
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
