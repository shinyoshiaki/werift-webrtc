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
import type { DtlsInternalOptions } from "./socket";
import {
  DtlsVersion,
  ProtocolVersionError,
  peerVersionsFromSupportedVersionsWire,
  selectVersion,
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
  /** Public constructor — accepts stable {@link Options} only. */
  constructor(options: Options) {
    super(options, SessionType.SERVER);
    this.onHandleHandshakes = this.handleHandshakes;

    const versions = this.protocolVersions;
    const only13 = versions.length === 1 && versions[0] === DtlsVersion.V1_3;
    const dual =
      supportsVersion(versions, DtlsVersion.V1_3) &&
      supportsVersion(versions, DtlsVersion.V1_2);
    // Pure DTLS 1.3 server: engine owns the transport from the start.
    // Dual [1.3,1.2] (only dual order after normalize) starts on 1.2 association path and
    // dispatches to 1.3 only after selectVersion chooses V1_3.
    if (only13) {
      this.startEngine13();
    }

    log(this.dtls.sessionId, "start server", {
      versions,
      only13,
      dual,
      prefer13: versions[0] === DtlsVersion.V1_3,
    });
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
        // handshakeCarrier is DtlsInternalOptions only (not stable Public API)
        carrier: (this.options as DtlsInternalOptions).handshakeCarrier,
        // Engine only speaks 1.3 once selected; preference used at association
        offeredProtocolVersions: [DtlsVersion.V1_3],
      },
      SessionType.SERVER,
    );
    this.bridgeEngine13(engine);
  }

  /**
   * Association-layer version selection from ClientHello supported_versions
   * and local protocolVersions preference order.
   */
  private selectVersionFromClientHello(
    clientHello: ClientHello,
  ): DtlsVersion | undefined {
    const ext = clientHello.extensions.find(
      (e) => e.type === SupportedVersions.type,
    );
    let peerSupported: DtlsVersion[];
    if (!ext) {
      // Extension absent only → legacy DTLS 1.2
      peerSupported = peerVersionsFromSupportedVersionsWire(undefined);
    } else {
      try {
        const sv = SupportedVersions.fromData(ext.data, false);
        // Empty / unknown-only → [] → no overlap (protocol_version), not 1.2
        peerSupported = peerVersionsFromSupportedVersionsWire(sv.versions);
      } catch {
        // Malformed supported_versions (odd length, trailing bytes, empty list)
        return undefined;
      }
    }
    try {
      return selectVersion(this.protocolVersions, peerSupported);
    } catch {
      return undefined;
    }
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

            // Dual / multi-version: association-layer selectVersion
            // (local protocolVersions order ∩ peer supported_versions).
            // Does not use HelloVerifyRequest or error-string heuristics.
            if (
              supportsVersion(this.protocolVersions, DtlsVersion.V1_3) &&
              supportsVersion(this.protocolVersions, DtlsVersion.V1_2)
            ) {
              const selected = this.selectVersionFromClientHello(clientHello);
              if (selected === DtlsVersion.V1_3) {
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
                  eng.injectDatagram(pkt, peerAddr);
                }
                log("association selected DTLS 1.3, reinjected ClientHello", {
                  peer: peerAddr,
                  preference: this.protocolVersions,
                });
                return;
              }
              // selected === V1_2 → stay on DTLS 1.2 path (flight2/4).
              // ServerHello will include DOWNGRD sentinel when dual-capable.
              if (selected === undefined) {
                // No overlap with dual server — alert + association fatal teardown
                await this.sendPlaintextAlert(AlertDesc.ProtocolVersion);
                this.reportLegacy12Fatal(
                  new ProtocolVersionError(
                    "no overlapping DTLS protocol version with peer",
                  ),
                );
                return;
              }
              log("association selected DTLS 1.2 (local preference order)", {
                preference: this.protocolVersions,
              });
            }

            // 1.3-only is handled by engine13; if we are here with only 1.3 config
            // without engine, reject 1.2-looking hellos without 1.3 version.
            if (
              this.protocolVersions.length === 1 &&
              this.protocolVersions[0] === DtlsVersion.V1_3
            ) {
              this.reportLegacy12Fatal(
                new ProtocolVersionError(
                  "DTLS 1.3-only server rejected ClientHello without DTLS 1.3",
                ),
              );
              return;
            }

            // 1.2-only server vs 1.3-only peer: protocol_version alert
            if (
              !supportsVersion(this.protocolVersions, DtlsVersion.V1_3) &&
              clientHello.cipherSuites.every((c) => c === 0x1301)
            ) {
              await this.sendPlaintextAlert(AlertDesc.ProtocolVersion);
              this.reportLegacy12Fatal(
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
              // Cookie return-routability succeeded: pin TX peer so spoofed
              // datagrams that overwrite UdpTransport.rinfo cannot redirect
              // Flight4 retransmit or later application data (association TX
              // ownership; client already pins at connect()).
              this.pinSendPeerFromTransportRinfo("set-if-empty");
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
            // Safety net: pin from last authenticated HS peer if Flight4 pin
            // was skipped (should not overwrite an existing pin after spoof).
            this.pinSendPeerFromTransportRinfo("set-if-empty");
            // Flight4 retransmit sleep (nextFlight=6) may still be pending even
            // after flight=6; cancel before onConnect for lifecycle completeness.
            this.cancelLegacy12FlightTimers();
            this.onConnect.execute();
            log(this.dtls.sessionId, "dtls connected");
          }
          break;
      }
    }
  };
}
