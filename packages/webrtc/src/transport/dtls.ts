import { Certificate, PrivateKey } from "@fidm/x509";
import debug from "debug";
import Event from "rx.mini";
import {
  DtlsClient,
  DtlsServer,
  DtlsSocket,
  Transport,
} from "../../../dtls/src";
import {
  HashAlgorithm,
  NamedCurveAlgorithm,
  SignatureAlgorithm,
  SignatureHash,
} from "../../../dtls/src/cipher/const";
import { CipherContext } from "../../../dtls/src/context/cipher";
import { Connection } from "../../../ice/src";
import {
  RtcpPacket,
  RtcpPacketConverter,
  RtpHeader,
  RtpPacket,
  SrtcpSession,
  SrtpSession,
} from "../../../rtp/src";
import { sleep } from "../helper";
import { RtpRouter } from "../media/router";
import { fingerprint, isDtls, isMedia, isRtcp } from "../utils";
import { RTCIceTransport } from "./ice";

const log = debug("werift/webrtc/transport/dtls");

export class RTCDtlsTransport {
  state: DtlsState = "new";
  role: DtlsRole = "auto";
  srtpStarted = false;
  transportSequenceNumber = 0;

  dataReceiver?: (buf: Buffer) => void;
  dtls?: DtlsSocket;
  srtp!: SrtpSession;
  srtcp!: SrtcpSession;

  readonly onStateChange = new Event<[DtlsState]>();

  private localCertificate?: RTCCertificate = this.certificates[0];

  constructor(
    readonly iceTransport: RTCIceTransport,
    readonly router: RtpRouter,
    readonly certificates: RTCCertificate[],
    private readonly srtpProfiles: number[] = []
  ) {}

  get localParameters() {
    return new RTCDtlsParameters(
      this.localCertificate ? this.localCertificate.getFingerprints() : []
    );
  }

  async setupCertificate() {
    if (!this.localCertificate) {
      const {
        certPem,
        keyPem,
        signatureHash,
      } = await CipherContext.createSelfSignedCertificateWithKey(
        {
          signature: SignatureAlgorithm.ecdsa,
          hash: HashAlgorithm.sha256,
        },
        NamedCurveAlgorithm.secp256r1
      );
      this.localCertificate = new RTCCertificate(
        keyPem,
        certPem,
        signatureHash
      );
    }
  }

  async start(remoteParameters: RTCDtlsParameters) {
    if (this.state !== "new") throw new Error();
    if (remoteParameters.fingerprints.length === 0) throw new Error();

    if (this.iceTransport.role === "controlling") {
      this.role = "server";
    } else {
      this.role = "client";
    }

    this.setState("connecting");

    await new Promise<void>(async (r) => {
      if (this.role === "server") {
        this.dtls = new DtlsServer({
          cert: this.localCertificate?.certPem,
          key: this.localCertificate?.privateKey,
          signatureHash: this.localCertificate?.signatureHash,
          transport: createIceTransport(this.iceTransport.connection),
          srtpProfiles: this.srtpProfiles,
          extendedMasterSecret: true,
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
        if (this.dataReceiver) this.dataReceiver(buf);
      });
      this.dtls.onClose.once(() => {
        this.setState("closed");
      });
      this.dtls.onConnect.once(r);

      if (this.dtls instanceof DtlsClient) {
        await sleep(100);
        this.dtls.connect();
      }
    });

    if (this.srtpProfiles.length > 0) {
      this.startSrtp();
    }
    this.setState("connected");
    log("dtls connected");
  }

  startSrtp() {
    if (!this.dtls) throw new Error();

    if (this.srtpStarted) return;
    this.srtpStarted = true;

    const {
      localKey,
      localSalt,
      remoteKey,
      remoteSalt,
    } = this.dtls.extractSessionKeys();
    if (!this.dtls.srtp.srtpProfile) throw new Error("need srtpProfile");
    const config = {
      keys: {
        localMasterKey: localKey,
        localMasterSalt: localSalt,
        remoteMasterKey: remoteKey,
        remoteMasterSalt: remoteSalt,
      },
      profile: this.dtls.srtp.srtpProfile,
    };
    this.srtp = new SrtpSession(config);
    this.srtcp = new SrtcpSession(config);

    this.iceTransport.connection.onData.subscribe((data) => {
      if (!isMedia(data)) return;
      if (isRtcp(data)) {
        const dec = this.srtcp.decrypt(data);
        const rtcps = RtcpPacketConverter.deSerialize(dec);
        rtcps.forEach((rtcp) => this.router.routeRtcp(rtcp));
      } else {
        const dec = this.srtp.decrypt(data);
        const rtp = RtpPacket.deSerialize(dec);
        this.router.routeRtp(rtp);
      }
    });
  }

  readonly sendData = async (data: Buffer) => {
    if (!this.dtls) throw new Error("dtls not established");
    await this.dtls.send(data);
  };

  sendRtp(payload: Buffer, header: RtpHeader) {
    const enc = this.srtp.encrypt(payload, header);
    this.iceTransport.connection.send(enc);
    return enc.length;
  }

  async sendRtcp(packets: RtcpPacket[]) {
    const payload = Buffer.concat(packets.map((packet) => packet.serialize()));
    const enc = this.srtcp.encrypt(payload);
    try {
      await this.iceTransport.connection.send(enc);
    } catch (error) {
      throw new Error("ice");
    }
  }

  private setState(state: DtlsState) {
    if (state != this.state) {
      this.state = state;
      this.onStateChange.execute(state);
    }
  }

  stop() {
    this.setState("closed");
  }
}

export const DtlsStates = [
  "new",
  "connecting",
  "connected",
  "closed",
  "failed",
] as const;
export type DtlsState = typeof DtlsStates[number];

export type DtlsRole = "auto" | "server" | "client";

export class RTCCertificate {
  publicKey: string;
  privateKey: string;

  constructor(
    privateKeyPem: string,
    public certPem: string,
    public signatureHash: SignatureHash
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
          "sha256"
        )
      ),
    ];
  }
}

export class RTCDtlsFingerprint {
  constructor(public algorithm: string, public value: string) {}
}

export class RTCDtlsParameters {
  constructor(
    public fingerprints: RTCDtlsFingerprint[] = [],
    public role: "auto" | "client" | "server" | undefined = "auto"
  ) {}
}

class IceTransport implements Transport {
  constructor(private ice: Connection) {
    ice.onData.subscribe((buf) => {
      if (isDtls(buf)) {
        if (this.onData) this.onData(buf);
      }
    });
  }
  onData?: (buf: Buffer) => void;

  readonly send = this.ice.send;

  close() {
    this.ice.close();
  }
}

const createIceTransport = (ice: Connection) => new IceTransport(ice);
