import { Certificate, PrivateKey } from "@fidm/x509";

import { setTimeout } from "timers/promises";
import { v4 } from "uuid";
import { Event, type Transport } from "../imports/common";

import type { AddressInfo } from "net";
import {
  CipherContext,
  DtlsClient,
  DtlsServer,
  type DtlsSocket,
  HashAlgorithm,
  NamedCurveAlgorithm,
  SignatureAlgorithm,
  type SignatureHash,
} from "../imports/dtls";
import type { IceConnection } from "../imports/ice";
import {
  type RtcpPacket,
  RtcpPacketConverter,
  type RtpHeader,
  RtpPacket,
  SrtcpSession,
  type SrtpProfile,
  SrtpSession,
  debug,
  isMedia,
  isRtcp,
  keyLength,
  saltLength,
} from "../imports/rtp";
import type { RtpRouter } from "../media/router";
import type { PeerConfig } from "../peerConnection";
import { fingerprint, isDtls } from "../utils";
import type { RTCIceTransport } from "./ice";

const log = debug("werift:packages/webrtc/src/transport/dtls.ts");

export class RTCDtlsTransport {
  id = v4();
  state: DtlsState = "new";
  role: DtlsRole = "auto";
  srtpStarted = false;
  transportSequenceNumber = 0;

  dataReceiver: (buf: Buffer) => void = () => {};
  dtls?: DtlsSocket;
  srtp!: SrtpSession;
  srtcp!: SrtcpSession;

  readonly onStateChange = new Event<[DtlsState]>();

  static localCertificate?: RTCCertificate;
  static localCertificatePromise?: Promise<RTCCertificate>;
  private remoteParameters?: RTCDtlsParameters;

  constructor(
    readonly config: PeerConfig,
    readonly iceTransport: RTCIceTransport,
    readonly router: RtpRouter,
    public localCertificate?: RTCCertificate,
    private readonly srtpProfiles: SrtpProfile[] = [],
  ) {
    this.localCertificate ??= RTCDtlsTransport.localCertificate;
  }

  get localParameters() {
    return new RTCDtlsParameters(
      this.localCertificate ? this.localCertificate.getFingerprints() : [],
      this.role,
    );
  }

  static async SetupCertificate() {
    if (this.localCertificate) {
      return this.localCertificate;
    }

    if (this.localCertificatePromise) {
      return this.localCertificatePromise;
    }

    this.localCertificatePromise = (async () => {
      const { certPem, keyPem, signatureHash } =
        await CipherContext.createSelfSignedCertificateWithKey(
          {
            signature: SignatureAlgorithm.ecdsa_3,
            hash: HashAlgorithm.sha256_4,
          },
          NamedCurveAlgorithm.secp256r1_23,
        );
      this.localCertificate = new RTCCertificate(
        keyPem,
        certPem,
        signatureHash,
      );
      return this.localCertificate;
    })();

    return this.localCertificatePromise;
  }

  setRemoteParams(remoteParameters: RTCDtlsParameters) {
    this.remoteParameters = remoteParameters;
  }

  async start() {
    if (this.state !== "new") {
      throw new Error("state must be new");
    }
    if (this.remoteParameters?.fingerprints.length === 0) {
      throw new Error("remote fingerprint not exist");
    }

    if (this.role === "auto") {
      if (this.iceTransport.role === "controlling") {
        this.role = "server";
      } else {
        this.role = "client";
      }
    }

    this.setState("connecting");

    await new Promise<void>(async (r, f) => {
      if (this.role === "server") {
        this.dtls = new DtlsServer({
          cert: this.localCertificate?.certPem,
          key: this.localCertificate?.privateKey,
          signatureHash: this.localCertificate?.signatureHash,
          transport: createIceTransport(this.iceTransport.connection),
          srtpProfiles: this.srtpProfiles,
          extendedMasterSecret: true,
          // certificateRequest: true,
        });
      } else {
        this.dtls = new DtlsClient({
          cert: this.localCertificate?.certPem,
          key: this.localCertificate?.privateKey,
          signatureHash: this.localCertificate?.signatureHash,
          transport: createIceTransport(this.iceTransport.connection),
          srtpProfiles: this.srtpProfiles,
          extendedMasterSecret: true,
        });
      }
      this.dtls.onData.subscribe((buf) => {
        if (
          this.config.debug.inboundPacketLoss &&
          this.config.debug.inboundPacketLoss / 100 < Math.random()
        ) {
          return;
        }
        this.dataReceiver(buf);
      });
      this.dtls.onClose.subscribe(() => {
        this.setState("closed");
      });
      this.dtls.onConnect.once(r);
      this.dtls.onError.once((error) => {
        this.setState("failed");
        log("dtls failed", error);
        f(error);
      });

      if (this.dtls instanceof DtlsClient) {
        await setTimeout(100);
        this.dtls.connect().catch((error) => {
          this.setState("failed");
          log("dtls connect failed", error);
          f(error);
        });
      }
    });

    if (this.srtpProfiles.length > 0) {
      this.startSrtp();
    }
    this.dtls!.onConnect.subscribe(() => {
      this.updateSrtpSession();
      this.setState("connected");
    });
    this.setState("connected");

    log("dtls connected");
  }

  updateSrtpSession() {
    if (!this.dtls) throw new Error();

    const profile = this.dtls.srtp.srtpProfile;
    if (!profile) {
      throw new Error("need srtpProfile");
    }
    log("selected SRTP Profile", profile);

    const { localKey, localSalt, remoteKey, remoteSalt } =
      this.dtls.extractSessionKeys(keyLength(profile), saltLength(profile));

    const config = {
      keys: {
        localMasterKey: localKey,
        localMasterSalt: localSalt,
        remoteMasterKey: remoteKey,
        remoteMasterSalt: remoteSalt,
      },
      profile,
    };
    this.srtp = new SrtpSession(config);
    this.srtcp = new SrtcpSession(config);
  }

  startSrtp() {
    if (this.srtpStarted) return;
    this.srtpStarted = true;

    this.updateSrtpSession();

    this.iceTransport.connection.onData.subscribe((data) => {
      if (
        this.config.debug.inboundPacketLoss &&
        this.config.debug.inboundPacketLoss / 100 < Math.random()
      ) {
        return;
      }

      if (!isMedia(data)) return;
      if (isRtcp(data)) {
        const dec = this.srtcp.decrypt(data);
        const rtcps = RtcpPacketConverter.deSerialize(dec);
        rtcps.forEach((rtcp) => this.router.routeRtcp(rtcp));
      } else {
        const dec = this.srtp.decrypt(data);
        const rtp = RtpPacket.deSerialize(dec);
        try {
          this.router.routeRtp(rtp);
        } catch (error) {
          log("router error", error);
        }
      }
    });
  }

  readonly sendData = async (data: Buffer) => {
    if (
      this.config.debug.outboundPacketLoss &&
      this.config.debug.outboundPacketLoss / 100 < Math.random()
    ) {
      return;
    }

    if (!this.dtls) {
      throw new Error("dtls not established");
    }
    await this.dtls.send(data);
  };

  async sendRtp(payload: Buffer, header: RtpHeader): Promise<number> {
    try {
      const enc = this.srtp.encrypt(payload, header);

      if (
        this.config.debug.outboundPacketLoss &&
        this.config.debug.outboundPacketLoss / 100 < Math.random()
      ) {
        return enc.length;
      }

      await this.iceTransport.connection.send(enc).catch(() => {});
      return enc.length;
    } catch (error) {
      log("failed to send", error);
      return 0;
    }
  }

  async sendRtcp(packets: RtcpPacket[]) {
    const payload = Buffer.concat(packets.map((packet) => packet.serialize()));
    const enc = this.srtcp.encrypt(payload);

    if (
      this.config.debug.outboundPacketLoss &&
      this.config.debug.outboundPacketLoss / 100 < Math.random()
    ) {
      return enc.length;
    }

    await this.iceTransport.connection.send(enc).catch(() => {});
  }

  private setState(state: DtlsState) {
    if (state != this.state) {
      this.state = state;
      this.onStateChange.execute(state);
    }
  }

  async stop() {
    this.setState("closed");
    // todo impl send alert
  }
}

export const DtlsStates = [
  "new",
  "connecting",
  "connected",
  "closed",
  "failed",
] as const;
export type DtlsState = (typeof DtlsStates)[number];

export type DtlsRole = "auto" | "server" | "client";

export class RTCCertificate {
  publicKey: string;
  privateKey: string;

  constructor(
    privateKeyPem: string,
    public certPem: string,
    public signatureHash: SignatureHash,
  ) {
    const cert = Certificate.fromPEM(Buffer.from(certPem));
    this.publicKey = cert.publicKey.toPEM();
    this.privateKey = PrivateKey.fromPEM(Buffer.from(privateKeyPem)).toPEM();
  }

  getFingerprints(): RTCDtlsFingerprint[] {
    return [
      new RTCDtlsFingerprint(
        "sha-256",
        fingerprint(
          Certificate.fromPEM(Buffer.from(this.certPem)).raw,
          "sha256",
        ),
      ),
    ];
  }
}

export type DtlsKeys = {
  certPem: string;
  keyPem: string;
  signatureHash: SignatureHash;
};

export class RTCDtlsFingerprint {
  constructor(
    public algorithm: string,
    public value: string,
  ) {}
}

export class RTCDtlsParameters {
  constructor(
    public fingerprints: RTCDtlsFingerprint[] = [],
    public role: "auto" | "client" | "server",
  ) {}
}

class IceTransport implements Transport {
  constructor(private ice: IceConnection) {
    ice.onData.subscribe((buf) => {
      if (isDtls(buf)) {
        if (this.onData) {
          this.onData(buf);
        }
      }
    });
  }
  onData: (buf: Buffer) => void = () => {};

  get address() {
    return {} as AddressInfo;
  }

  type: string = "ice";

  readonly send = (data: Buffer) => {
    return this.ice.send(data);
  };

  async close() {
    this.ice.close();
  }
}

const createIceTransport = (ice: IceConnection) => new IceTransport(ice);
