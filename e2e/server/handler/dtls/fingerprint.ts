import type { AcceptFn } from "protoo-server";
import { RTCPeerConnection } from "../..";
import { peerConfigWithDtls } from "../../fixture";
import { collectWeriftDtlsDiagnostics } from "./diagnostics";

function mutateSdpFingerprint(sdp: string) {
  return sdp.replace(
    /a=fingerprint:(\S+)\s+([0-9A-Fa-f:]+)/g,
    (_match, algorithm: string, value: string) => {
      const flipped = `${value[0] === "A" || value[0] === "a" ? "B" : "A"}${value.slice(1)}`;
      return `a=fingerprint:${algorithm} ${flipped}`;
    },
  );
}

export class dtls_fingerprint_answer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(
            await peerConfigWithDtls({
              protocolVersions: payload?.protocolVersions,
            }),
          );
          this.pc.createDataChannel("dc");
          await this.pc.setLocalDescription(await this.pc.createOffer());
          const sdp = payload?.mutateFingerprint
            ? mutateSdpFingerprint(this.pc.localDescription!.sdp)
            : this.pc.localDescription!.sdp;
          accept({
            description: { type: this.pc.localDescription!.type, sdp },
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
          try {
            accept(await collectWeriftDtlsDiagnostics(this.pc));
          } catch (error) {
            accept({
              connectionState: this.pc?.connectionState ?? "failed",
              dtlsState: this.pc?.dtlsTransports[0]?.state ?? "failed",
              lastError: {
                name: error instanceof Error ? error.name : "Error",
                message: error instanceof Error ? error.message : String(error),
              },
              rtpPacketsReceived: 0,
              rtcpPacketsReceived: 0,
            });
          }
        }
        break;
    }
  }
}

export class dtls_fingerprint_offer {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(
            await peerConfigWithDtls({
              protocolVersions: payload?.protocolVersions,
            }),
          );
          const description = payload?.mutateFingerprint
            ? {
                ...payload.description,
                sdp: mutateSdpFingerprint(payload.description.sdp),
              }
            : payload.description;
          await this.pc.setRemoteDescription(description);
          await this.pc.setLocalDescription(await this.pc.createAnswer());
          accept({ description: this.pc.localDescription });
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
          try {
            accept(await collectWeriftDtlsDiagnostics(this.pc));
          } catch (error) {
            accept({
              connectionState: this.pc?.connectionState ?? "failed",
              dtlsState: this.pc?.dtlsTransports[0]?.state ?? "failed",
              lastError: {
                name: error instanceof Error ? error.name : "Error",
                message: error instanceof Error ? error.message : String(error),
              },
              rtpPacketsReceived: 0,
              rtcpPacketsReceived: 0,
            });
          }
        }
        break;
    }
  }
}
