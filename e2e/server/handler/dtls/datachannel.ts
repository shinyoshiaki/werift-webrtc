import type { AcceptFn } from "protoo-server";
import { RTCPeerConnection } from "../..";
import { peerConfigWithDtls } from "../../fixture";
import {
  attachMediaCounters,
  collectWeriftDtlsDiagnostics,
  holdIceNomination,
} from "./diagnostics";

export class dtls_datachannel_answer {
  pc!: RTCPeerConnection;
  private counters = attachMediaCountersPlaceholder();

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(
            await peerConfigWithDtls({
              protocolVersions: payload?.protocolVersions,
            }),
          );
          const dc = this.pc.createDataChannel("dc");
          this.counters = attachMediaCounters(this.pc);
          dc.onMessage.subscribe((msg) => {
            dc.send(msg + "pong");
          });
          await this.pc.setLocalDescription(await this.pc.createOffer());
          this.counters.attachTransport();
          accept({
            description: this.pc.localDescription,
            sped: this.pc.localDescription?.sdp.includes("goog-sped-v1"),
          });
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
      case "stats":
        {
          accept(
            await collectWeriftDtlsDiagnostics(this.pc, this.counters.counters),
          );
        }
        break;
    }
  }
}

export class dtls_datachannel_offer {
  pc!: RTCPeerConnection;
  private counters = attachMediaCountersPlaceholder();
  private nominationHold?: { release(): void };

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(
            await peerConfigWithDtls({
              protocolVersions: payload?.protocolVersions,
              sendBeforeNomination: payload?.sendBeforeNomination,
            }),
          );
          this.counters = attachMediaCounters(this.pc);
          this.pc.onDataChannel.subscribe((dc) => {
            dc.onMessage.subscribe((msg) => {
              dc.send(msg + "pong");
            });
          });
          await this.pc.setRemoteDescription(payload.description);
          // sendBeforeNomination: hold werift's nomination so its data can
          // only reach Chromium through the opt-in (valid pair, no selection).
          this.nominationHold?.release();
          this.nominationHold = payload?.holdNomination
            ? holdIceNomination(this.pc)
            : undefined;
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          this.counters.attachTransport();
          accept({
            description: this.pc.localDescription,
            sped: this.pc.localDescription?.sdp.includes("goog-sped-v1"),
          });
        }
        break;
      case "candidate":
        {
          await this.pc.addIceCandidate(payload);
          accept({});
        }
        break;
      case "stats":
        {
          accept(
            await collectWeriftDtlsDiagnostics(this.pc, this.counters.counters),
          );
        }
        break;
    }
  }
}

function attachMediaCountersPlaceholder() {
  return {
    counters: { rtpPacketsReceived: 0, rtcpPacketsReceived: 0 },
    attachTransport: () => {},
  };
}
