import { SessionType } from "./cipher/suites/abstract";
import { Dtls13Connection } from "./engine/v1_3/connection";
import { Flight1 } from "./flight/client/flight1";
import { Flight3 } from "./flight/client/flight3";
import { Flight5 } from "./flight/client/flight5";
import { HandshakeType } from "./handshake/const";
import { SupportedVersions } from "./handshake/extensions/supportedVersions";
import { ServerHello } from "./handshake/message/server/hello";
import { ServerHelloVerifyRequest } from "./handshake/message/server/helloVerifyRequest";
import { debug } from "./imports/common";
import type { FragmentedHandshake } from "./record/message/fragment";
import { DtlsSocket, type Options } from "./socket";
import {
  DTLS_1_2_VERSION,
  DTLS_1_3_VERSION,
  DtlsVersion,
  DtlsVersionSelected,
  ProtocolVersionError,
  hasTlsDowngradeSentinel,
  supportsVersion,
} from "./version";

const log = debug("werift-dtls : packages/dtls/src/client.ts : log");

export class DtlsClient extends DtlsSocket {
  /**
   * True while dual [1.3,1.2] association is continuing on the DTLS 1.2 cookie
   * path after HVR — still offers 1.3 in supported_versions (not pure 1.2-only).
   */
  private dualCookiePath = false;

  constructor(options: Options) {
    super(options, SessionType.CLIENT);
    this.onHandleHandshakes = this.handleHandshakes;

    const versions = this.protocolVersions;
    const only13 = versions.length === 1 && versions[0] === DtlsVersion.V1_3;
    const dual =
      supportsVersion(versions, DtlsVersion.V1_3) &&
      supportsVersion(versions, DtlsVersion.V1_2);

    // Pure 1.3 or dual [1.3,1.2]: start 1.3 engine advertising offered versions.
    if (only13 || dual) {
      this.startEngine13(only13, versions);
    }

    log(this.dtls.sessionId, "start client", { versions, only13, dual });
  }

  private startEngine13(strict13: boolean, offered: readonly DtlsVersion[]) {
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
        carrier: this.options.handshakeCarrier,
        offeredProtocolVersions: offered,
      },
      SessionType.CLIENT,
    );

    const dualCanContinue12 =
      !strict13 && supportsVersion(this.protocolVersions, DtlsVersion.V1_2);

    this.bridgeEngine13(engine, {
      filterError: (e) =>
        dualCanContinue12 &&
        !this.dualCookiePath &&
        e instanceof DtlsVersionSelected &&
        e.version === DtlsVersion.V1_2,
    });

    if (dualCanContinue12) {
      engine.onError.subscribe((e) => {
        if (this.dualCookiePath) return;
        if (
          !(e instanceof DtlsVersionSelected) ||
          e.version !== DtlsVersion.V1_2
        ) {
          return;
        }
        log(
          "dual association: HVR → continue on 1.2 cookie path with supported_versions still offering 1.3",
          e.message,
        );
        this.dualCookiePath = true;
        this.engine13 = undefined;
        this.connected = false;
        engine.releaseForVersionFallback();
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
        // Dual extensions: 1.2 suites + supported_versions [1.3,1.2]
        this.setupExtensionsForDualCookiePath();
        void this.continueDualAfterHvr(e.helloVerifyCookie).catch((err) =>
          this.onError.execute(
            err instanceof Error ? err : new Error(String(err)),
          ),
        );
      });
    }
  }

  /**
   * Dual cookie path extensions: keep advertising DTLS 1.3 in supported_versions
   * so a 1.3-capable server that sees a MITM-stripped CH can still put the
   * DOWNGRD sentinel; pure 1.2-only peers ignore the extension.
   */
  private setupExtensionsForDualCookiePath() {
    this.extensions = [];
    this.setupExtensions();
    // Prepend supported_versions [1.3, 1.2] (preference order)
    const sv = SupportedVersions.forClient([
      DTLS_1_3_VERSION,
      DTLS_1_2_VERSION,
    ]);
    this.extensions.unshift(sv.clientExtension);
  }

  /**
   * After HVR: start the 1.2 flight stack with dual extensions still advertising
   * supported_versions [1.3, 1.2]. A fresh Flight1→HVR→Flight3 uses the normal
   * 1.2 cookie path (same CH body with cookie for Finished MAC) rather than a
   * pure 1.2-only ClientHello without supported_versions.
   *
   * The unauthenticated HVR only moves association onto the dual cookie path;
   * final version is confirmed by ServerHello + DOWNGRD sentinel check.
   */
  private async continueDualAfterHvr(_cookie?: Buffer) {
    await this.connect12();
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
        case HandshakeType.hello_verify_request_3:
          {
            const verifyReq = ServerHelloVerifyRequest.deSerialize(
              handshake.fragment,
            );
            await new Flight3(this.transport, this.dtls).exec(verifyReq);
          }
          break;
        case HandshakeType.server_hello_2:
          {
            if (this.connected) return;
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

            // Dual cookie path: 1.2 ServerHello while we still offered 1.3 —
            // enforce RFC 8446 / 9147 downgrade sentinel check.
            if (
              this.dualCookiePath ||
              supportsVersion(this.protocolVersions, DtlsVersion.V1_3)
            ) {
              try {
                const sh = ServerHello.deSerialize(handshake.fragment);
                const random32 = Buffer.concat([
                  (() => {
                    const b = Buffer.alloc(4);
                    b.writeUInt32BE(sh.random.gmt_unix_time >>> 0, 0);
                    return b;
                  })(),
                  sh.random.random_bytes,
                ]);
                // negotiated version is DTLS 1.2 wire (legacy)
                if (hasTlsDowngradeSentinel(random32)) {
                  this.onError.execute(
                    new ProtocolVersionError(
                      "illegal_parameter: ServerHello Random contains TLS downgrade sentinel while client offered DTLS 1.3",
                    ),
                  );
                  return;
                }
              } catch (e) {
                if (
                  e instanceof ProtocolVersionError ||
                  (e instanceof Error && e.name === "ProtocolVersionError")
                ) {
                  this.onError.execute(e as Error);
                  return;
                }
                // fall through to normal 1.2 handling if parse issues
              }
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
