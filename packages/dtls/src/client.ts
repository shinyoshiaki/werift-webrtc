import { SessionType } from "./cipher/suites/abstract";
import { Dtls13Connection } from "./engine/v1_3/connection";
import { Flight1 } from "./flight/client/flight1";
import { Flight3 } from "./flight/client/flight3";
import { Flight5 } from "./flight/client/flight5";
import { HandshakeType } from "./handshake/const";
import { ServerHelloVerifyRequest } from "./handshake/message/server/helloVerifyRequest";
import { debug } from "./imports/common";
import type { FragmentedHandshake } from "./record/message/fragment";
import { DtlsSocket, type Options } from "./socket";
import {
  DtlsVersion,
  ProtocolVersionError,
  normalizeProtocolVersions,
  supportsVersion,
} from "./version";

const log = debug("werift-dtls : packages/dtls/src/client.ts : log");

export class DtlsClient extends DtlsSocket {
  private dualFallbackTo12 = false;

  constructor(options: Options) {
    super(options, SessionType.CLIENT);
    this.onHandleHandshakes = this.handleHandshakes;

    const versions = this.protocolVersions;
    const only13 = versions.length === 1 && versions[0] === DtlsVersion.V1_3;
    const prefer13 =
      versions[0] === DtlsVersion.V1_3 &&
      supportsVersion(versions, DtlsVersion.V1_2);

    // Pure 1.3 or 1.3-preferred dual: start on 1.3 engine.
    // Dual falls back to 1.2 if peer cannot do 1.3 (protocol_version / clear 1.2 path).
    if (only13 || prefer13) {
      this.startEngine13(only13);
    }

    log(this.dtls.sessionId, "start client", { versions, only13, prefer13 });
  }

  private isVersionFallbackError(e: Error): boolean {
    return (
      e instanceof ProtocolVersionError ||
      /protocol version/i.test(e.message) ||
      /HelloVerifyRequest/i.test(e.message) ||
      /DTLS 1\.2-only/i.test(e.message) ||
      /protocol_version/i.test(e.message)
    );
  }

  private startEngine13(strict13: boolean) {
    // Server-auth-only clients may omit cert/key; mutual auth requires both.
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
      SessionType.CLIENT,
    );

    const dualCanFallback =
      !strict13 && supportsVersion(this.protocolVersions, DtlsVersion.V1_2);

    // Transparent dual fallback: do not surface ProtocolVersionError on public onError
    this.bridgeEngine13(engine, {
      filterError: (e) =>
        dualCanFallback &&
        !this.dualFallbackTo12 &&
        this.isVersionFallbackError(e),
    });

    if (dualCanFallback) {
      engine.onError.subscribe((e) => {
        if (this.dualFallbackTo12) return;
        if (!this.isVersionFallbackError(e)) return;
        log("falling back to DTLS 1.2 after version mismatch", e.message);
        this.dualFallbackTo12 = true;
        this.engine13 = undefined;
        this.connected = false;
        // Engine soft-fail already cancelled timers; close carrier only (keep UDP)
        engine.releaseForVersionFallback();
        // Restore 1.2 receive path and fresh 1.2 context
        this.transport.socket.onData = this.udpOnMessage;
        this.dtls = new (this.dtls.constructor as any)(
          this.options,
          this.sessionType,
        );
        this.cipher = new (this.cipher.constructor as any)(
          this.sessionType,
          this.options.cert,
          this.options.key,
          this.options.signatureHash,
        );
        this.srtp = new (this.srtp.constructor as any)();
        this.setupExtensionsFor12Fallback();
        this.connect12().catch((err) => this.onError.execute(err));
      });
    }
  }

  /** Re-init extensions after dual fallback tears down the 1.3 engine. */
  private setupExtensionsFor12Fallback() {
    this.extensions = [];
    this.setupExtensions();
  }

  async connect() {
    if (this.engine13) {
      await this.engine13.connect();
      return;
    }
    await this.connect12();
  }

  private async connect12() {
    await new Flight1(this.transport, this.dtls, this.cipher).exec(
      this.extensions,
    );
  }

  private flight5?: Flight5;
  private handleHandshakes = async (assembled: FragmentedHandshake[]) => {
    if (this.engine13) return;

    log(
      this.dtls.sessionId,
      "handleHandshakes",
      assembled.map((a) => a.msg_type),
    );

    for (const handshake of assembled) {
      switch (handshake.msg_type) {
        // flight2
        case HandshakeType.hello_verify_request_3:
          {
            const verifyReq = ServerHelloVerifyRequest.deSerialize(
              handshake.fragment,
            );
            await new Flight3(this.transport, this.dtls).exec(verifyReq);
          }
          break;
        // flight 4
        case HandshakeType.server_hello_2:
          {
            if (this.connected) return;
            // If we offered only 1.3, ServerHello without 1.3 is a version error
            const only13 =
              this.protocolVersions.length === 1 &&
              this.protocolVersions[0] === DtlsVersion.V1_3;
            if (only13) {
              this.onError.execute(
                new ProtocolVersionError(
                  "DTLS 1.3-only client received non-1.3 ServerHello",
                ),
              );
              return;
            }
            this.flight5 = new Flight5(
              this.transport,
              this.dtls,
              this.cipher,
              this.srtp,
            );
            this.flight5.handleHandshake(handshake);
          }
          break;
        case HandshakeType.certificate_11:
        case HandshakeType.server_key_exchange_12:
        case HandshakeType.certificate_request_13:
          {
            await this.waitForReady(() => !!this.flight5);
            this.flight5?.handleHandshake(handshake);
          }
          break;
        case HandshakeType.server_hello_done_14:
          {
            await this.waitForReady(() => !!this.flight5);
            this.flight5?.handleHandshake(handshake);

            const targets = [
              11,
              12,
              this.options.certificateRequest && 13,
            ].filter((n): n is number => typeof n === "number");
            await this.waitForReady(() =>
              this.dtls.checkHandshakesExist(targets),
            );
            await this.flight5?.exec();
          }
          break;
        // flight 6
        case HandshakeType.finished_20:
          {
            this.dtls.flight = 7;
            this.connected = true;
            this.onConnect.execute();
            log(this.dtls.sessionId, "dtls connected");
          }
          break;
      }
    }
  };
}
