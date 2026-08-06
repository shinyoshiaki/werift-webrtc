import { SessionType } from "./cipher/suites/abstract";
import { Dtls13Connection } from "./engine/v1_3/connection";
import { flight2 } from "./flight/server/flight2";
import { Flight4 } from "./flight/server/flight4";
import { Flight6 } from "./flight/server/flight6";
import { HandshakeType } from "./handshake/const";
import { SupportedVersions } from "./handshake/extensions/supportedVersions";
import { ClientHello } from "./handshake/message/client/hello";
import { debug } from "./imports/common";
import { AlertDesc, ContentType } from "./record/const";
import type { FragmentedHandshake } from "./record/message/fragment";
import { serializePlaintextRecord } from "./record/v1_3/record";
import { DtlsSocket, type Options } from "./socket";
import {
  DTLS_1_3_VERSION,
  DtlsVersion,
  ProtocolVersionError,
  supportsVersion,
} from "./version";

const log = debug("werift-dtls : packages/dtls/src/server.ts : log");

/**
 * Capture ClientHello source from UdpTransport.rinfo (set on last datagram)
 * so dual-engine reinject preserves peer for cookie address validation.
 */
function peerAddrFromTransport(transport: {
  rinfo?: { address?: string; port?: number };
}): [string, number] | { address?: string; port?: number } | undefined {
  const r = transport.rinfo;
  if (r?.address != null && r?.port != null) {
    return [r.address, r.port];
  }
  return r;
}

export class DtlsServer extends DtlsSocket {
  constructor(options: Options) {
    super(options, SessionType.SERVER);
    this.onHandleHandshakes = this.handleHandshakes;

    const versions = this.protocolVersions;
    const only13 = versions.length === 1 && versions[0] === DtlsVersion.V1_3;
    // Pure DTLS 1.3 server: engine owns the transport from the start.
    if (only13) {
      this.startEngine13();
    }

    log(this.dtls.sessionId, "start server", { versions, only13 });
  }

  private startEngine13() {
    if (!this.options.cert || !this.options.key) {
      throw new Error("DTLS 1.3 requires cert and key options");
    }
    const engine = new Dtls13Connection(
      {
        transport: this.options.transport,
        cert: this.options.cert,
        key: this.options.key,
        srtpProfiles: this.options.srtpProfiles,
        certificateRequest: this.options.certificateRequest,
        addressValidation: this.options.addressValidation,
        groups: this.options.namedGroups
          ? [...this.options.namedGroups]
          : undefined,
        mtu: this.options.mtu,
      },
      SessionType.SERVER,
    );
    this.bridgeEngine13(engine);
  }

  /**
   * Dual-mode: on ClientHello, switch to 1.3 engine when peer offers DTLS 1.3
   * and this server lists 1.3; otherwise stay on 1.2.
   */
  private tryUpgradeTo13(clientHello: ClientHello): boolean {
    if (this.engine13) return true;
    if (!supportsVersion(this.protocolVersions, DtlsVersion.V1_3)) {
      return false;
    }
    const ext = clientHello.extensions.find(
      (e) => e.type === SupportedVersions.type,
    );
    if (!ext) return false;
    try {
      const sv = SupportedVersions.fromData(ext.data, false);
      if (!sv.versions.includes(DTLS_1_3_VERSION)) return false;
    } catch {
      return false;
    }

    // Rebuild as 1.3 server and re-inject the original datagram is hard;
    // instead create engine and let the next ClientHello (retransmit) complete.
    // For dual servers that prefer 1.3, start engine13 on first matching CH by
    // constructing engine and processing via a synthetic path.
    this.startEngine13();
    return !!this.engine13;
  }

  private flight6?: Flight6;
  private handleHandshakes = async (assembled: FragmentedHandshake[]) => {
    if (this.engine13) return;

    log(
      this.dtls.sessionId,
      "handleHandshakes",
      assembled.map((a) => a.msg_type),
    );

    for (const handshake of assembled) {
      switch (handshake.msg_type) {
        // flight1,3
        case HandshakeType.client_hello_1:
          {
            if (this.connected) {
              this.renegotiation();
            }
            const clientHello = ClientHello.deSerialize(handshake.fragment);

            // Dual [1.3, 1.2]: upgrade when peer offers 1.3
            if (
              supportsVersion(this.protocolVersions, DtlsVersion.V1_3) &&
              supportsVersion(this.protocolVersions, DtlsVersion.V1_2)
            ) {
              const ext = clientHello.extensions.find(
                (e) => e.type === SupportedVersions.type,
              );
              if (ext) {
                try {
                  const sv = SupportedVersions.fromData(ext.data, false);
                  if (sv.versions.includes(DTLS_1_3_VERSION)) {
                    // Peer wants 1.3: switch engines and re-inject this ClientHello
                    // as a full epoch-0 plaintext record (no retransmit wait).
                    // Preserve ClientHello source address so dtls-cookie binding
                    // uses the same peerKey at mint and verify (not "unknown").
                    const peerAddr = peerAddrFromTransport(
                      this.options.transport as {
                        rinfo?: { address?: string; port?: number };
                      },
                    );
                    this.startEngine13();
                    const eng = this.engine13 as Dtls13Connection | undefined;
                    if (eng) {
                      const fragBytes = handshake.serialize();
                      const pkt = serializePlaintextRecord(
                        ContentType.handshake,
                        0,
                        0,
                        fragBytes,
                      );
                      eng.handshakeCarrier.inject(pkt, peerAddr);
                    }
                    log(
                      "upgraded server to DTLS 1.3 engine, reinjected ClientHello",
                      { peer: peerAddr },
                    );
                    return;
                  }
                } catch {
                  /* fall through to 1.2 */
                }
              }
            }

            // 1.3-only is handled by engine13; if we are here with only 1.3 config
            // without engine, reject 1.2-looking hellos without 1.3 version.
            if (
              this.protocolVersions.length === 1 &&
              this.protocolVersions[0] === DtlsVersion.V1_3
            ) {
              this.onError.execute(
                new ProtocolVersionError(
                  "DTLS 1.3-only server rejected ClientHello without DTLS 1.3",
                ),
              );
              return;
            }

            // 1.3-only peer? If we are 1.2-only and CH only has 1.3 ciphers,
            // send protocol_version alert so the client fails without timeout.
            if (
              !supportsVersion(this.protocolVersions, DtlsVersion.V1_3) &&
              clientHello.cipherSuites.every((c) => c === 0x1301)
            ) {
              await this.sendPlaintextAlert(AlertDesc.ProtocolVersion);
              this.onError.execute(
                new ProtocolVersionError(
                  "DTLS 1.2-only server: peer offered only DTLS 1.3 cipher suites",
                ),
              );
              return;
            }

            if (clientHello.cookie.length === 0) {
              log(this.dtls.sessionId, "send flight2");
              flight2(
                this.transport,
                this.dtls,
                this.cipher,
                this.srtp,
              )(clientHello);
            } else if (
              this.dtls.cookie &&
              clientHello.cookie.equals(this.dtls.cookie)
            ) {
              log(this.dtls.sessionId, "send flight4");
              await new Flight4(
                this.transport,
                this.dtls,
                this.cipher,
                this.srtp,
              ).exec(handshake, this.options.certificateRequest);
            } else {
              log("wrong state", {
                dtlsCookie: this.dtls.cookie?.toString("hex").slice(10),
                helloCookie: clientHello.cookie.toString("hex").slice(10),
              });
            }
          }
          break;
        // flight 5
        case HandshakeType.certificate_11:
        case HandshakeType.certificate_verify_15:
        case HandshakeType.client_key_exchange_16:
          {
            if (this.connected) return;
            this.flight6 = new Flight6(this.transport, this.dtls, this.cipher);
            this.flight6.handleHandshake(handshake);
          }
          break;
        case HandshakeType.finished_20:
          {
            await this.waitForReady(() => !!this.flight6);
            this.flight6?.handleHandshake(handshake);

            const requiredHandshakes = [
              16,
              this.options.certificateRequest && 11,
              this.options.certificateRequest && 15,
            ].filter((type): type is number => typeof type === "number");
            await this.waitForReady(() =>
              this.dtls.checkHandshakesExist(requiredHandshakes),
            );
            await this.flight6?.exec();

            this.connected = true;
            this.onConnect.execute();
            log(this.dtls.sessionId, "dtls connected");
          }
          break;
      }
    }
  };
}
