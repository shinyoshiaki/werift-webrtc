import type { AcceptFn } from "protoo-server";
import { RTCPeerConnection } from "../../";
import { peerConfig } from "../../fixture";

/**
 * werift offers a data channel to Chrome; the browser drives the DTLS alert
 * scenario (#811):
 * - `close`: werift calls pc.close(), which sends close_notify to Chrome.
 * - `waitClosed`: resolves with werift's states once Chrome closed its side
 *   (close_notify from Chrome closes werift's DTLS transport).
 * - `waitFailed`: resolves once werift's connectionState is failed (Chrome
 *   sent an answer with a wrong fingerprint; werift rejects Chrome's
 *   certificate with a fatal bad_certificate alert).
 */
export class dtls_alert {
  pc!: RTCPeerConnection;

  async exec(type: string, payload: any, accept: AcceptFn) {
    switch (type) {
      case "init":
        {
          this.pc = new RTCPeerConnection(await peerConfig);
          this.pc.createDataChannel("dc");
          await this.pc.setLocalDescription(await this.pc.createOffer());
          accept(this.pc.localDescription);
        }
        break;
      case "candidate":
        {
          await this.pc.addIceCandidate(payload).catch(() => {});
          accept({});
        }
        break;
      case "answer":
        {
          await this.pc.setRemoteDescription(payload);
          accept({});
        }
        break;
      case "close":
        {
          await this.pc.close();
          accept({});
        }
        break;
      case "waitClosed":
        {
          const dtls = this.pc.sctp!.transport;
          await waitFor(() => dtls.state === "closed");
          accept({
            dtlsState: dtls.state,
            sctpState: this.pc.sctp!.state,
          });
          await this.pc.close();
        }
        break;
      case "waitFailed":
        {
          await waitFor(() => this.pc.connectionState === "failed");
          accept({
            connectionState: this.pc.connectionState,
            dtlsState: this.pc.sctp!.transport.state,
          });
          await this.pc.close();
        }
        break;
      case "done":
        {
          await this.pc?.close();
          accept({});
        }
        break;
    }
  }
}

async function waitFor(condition: () => boolean, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error("timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
