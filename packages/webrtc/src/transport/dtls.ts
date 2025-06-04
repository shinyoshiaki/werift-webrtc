import { Certificate, PrivateKey } from "@fidm/x509";

import { setTimeout } from "timers/promises";
import { v4 } from "uuid";
import { Event, type Transport } from "../imports/common.js";

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
} from "../imports/dtls.js";
import type { IceConnection } from "../imports/ice.js";
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
} from "../imports/rtp.js";
import {
  type RTCCertificateStats,
  type RTCIceCandidatePairStats,
  type RTCIceCandidateStats,
  type RTCStats,
  type RTCTransportStats,
  generateStatsId,
  getStatsTimestamp,
} from "../media/stats.js";
import type { PeerConfig } from "../peerConnection.js";
import { fingerprint, isDtls } from "../utils.js";
import type { RTCIceTransport } from "./ice.js";

const log = debug("werift:packages/webrtc/src/transport/dtls.ts");

export interface DtlsTransportStats {
  bytesSent: number;
  bytesReceived: number;
  packetsSent: number;
  packetsReceived: number;
}

export class RTCDtlsTransport implements DtlsTransportStats {
  id = v4();
  state: DtlsState = "new";
  role: DtlsRole = "auto";
  srtpStarted = false;
  transportSequenceNumber = 0;

  // Statistics tracking
  public bytesSent = 0;
  public bytesReceived = 0;
  public packetsSent = 0;
  public packetsReceived = 0;

  dataReceiver: (buf: Buffer) => void = () => {};
  dtls?: DtlsSocket;
  srtp!: SrtpSession;
  srtcp!: SrtcpSession;

  readonly onStateChange = new Event<[DtlsState]>();
  readonly onRtcp = new Event<[RtcpPacket]>();
  readonly onRtp = new Event<[RtpPacket]>();

  static localCertificate?: RTCCertificate;
  static localCertificatePromise?: Promise<RTCCertificate>;
  private remoteParameters?: RTCDtlsParameters;

  constructor(
    readonly config: PeerConfig,
    readonly iceTransport: RTCIceTransport,
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

      // Track received data statistics
      this.bytesReceived += data.length;
      this.packetsReceived++;

      if (isRtcp(data)) {
        const dec = this.srtcp.decrypt(data);
        const rtcpPackets = RtcpPacketConverter.deSerialize(dec);
        for (const rtcp of rtcpPackets) {
          try {
            this.onRtcp.execute(rtcp);
          } catch (error) {
            log("RTCP error", error);
          }
        }
      } else {
        const dec = this.srtp.decrypt(data);
        const rtp = RtpPacket.deSerialize(dec);
        try {
          this.onRtp.execute(rtp);
        } catch (error) {
          log("RTP error", error);
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

      // Track statistics
      this.bytesSent += enc.length;
      this.packetsSent++;

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

    // Track statistics
    this.bytesSent += enc.length;
    this.packetsSent++;

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
    await this.iceTransport.stop();
  }

  async getStats(): Promise<RTCStats[]> {
    const timestamp = getStatsTimestamp();
    const stats: RTCStats[] = [];

    const transportId = generateStatsId("transport", this.id);

    // Transport stats
    const transportStats: RTCTransportStats = {
      type: "transport",
      id: transportId,
      timestamp,
      bytesSent: this.bytesSent,
      bytesReceived: this.bytesReceived,
      packetsSent: this.packetsSent,
      packetsReceived: this.packetsReceived,
      dtlsState: this.state,
      iceState: this.iceTransport.state,
      selectedCandidatePairId: this.iceTransport.connection.nominated
        ? generateStatsId(
            "candidate-pair",
            this.iceTransport.connection.nominated.localCandidate.foundation,
            this.iceTransport.connection.nominated.remoteCandidate.foundation,
          )
        : undefined,
      localCertificateId: this.localCertificate
        ? generateStatsId("certificate", "local")
        : undefined,
      remoteCertificateId: this.remoteParameters
        ? generateStatsId("certificate", "remote")
        : undefined,
      dtlsRole: this.role === "auto" ? undefined : this.role,
    };
    stats.push(transportStats);

    // Certificate stats
    if (this.localCertificate) {
      const fingerprints = this.localCertificate.getFingerprints();
      if (fingerprints.length > 0) {
        const certStats: RTCCertificateStats = {
          type: "certificate",
          id: generateStatsId("certificate", "local"),
          timestamp,
          fingerprint: fingerprints[0].value,
          fingerprintAlgorithm: fingerprints[0].algorithm,
          base64Certificate: Buffer.from(
            this.localCertificate.certPem,
          ).toString("base64"),
        };
        stats.push(certStats);
      }
    }

    if (
      this.remoteParameters &&
      this.remoteParameters.fingerprints.length > 0
    ) {
      const certStats: RTCCertificateStats = {
        type: "certificate",
        id: generateStatsId("certificate", "remote"),
        timestamp,
        fingerprint: this.remoteParameters.fingerprints[0].value,
        fingerprintAlgorithm: this.remoteParameters.fingerprints[0].algorithm,
        base64Certificate: "", // Remote certificate content not available
      };
      stats.push(certStats);
    }

    // Get ICE stats
    const iceStats = await this.iceTransport.getStats();
    stats.push(...iceStats);

    return stats;
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
