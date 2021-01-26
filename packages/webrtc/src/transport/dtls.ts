import { Certificate, PrivateKey } from "@fidm/x509";
import Event from "rx.mini";
import {
  DtlsClient,
  DtlsServer,
  DtlsSocket,
  Transport,
} from "../../../dtls/src";
import { Connection } from "../../../ice/src";
import {
  RtcpPacket,
  RtcpPacketConverter,
  RtpHeader,
  RtpPacket,
  SrtcpSession,
  SrtpSession,
} from "../../../rtp/src";
import { defaultCertificate, defaultPrivateKey } from "../const";
import { sleep } from "../helper";
import { RtpRouter } from "../media/router";
import { fingerprint, isDtls, isMedia, isRtcp } from "../utils";
import { RTCIceTransport } from "./ice";

export enum DtlsState {
  NEW = 0,
  CONNECTING = 1,
  CONNECTED = 2,
  CLOSED = 3,
  FAILED = 4,
}

type DtlsRole = "auto" | "server" | "client";

export class RTCDtlsTransport {
  readonly stateChanged = new Event<[DtlsState]>();
  dtls!: DtlsSocket;
  state = DtlsState.NEW;
  role: DtlsRole = "auto";
  dataReceiver?: (buf: Buffer) => void;
  srtp!: SrtpSession;
  srtcp!: SrtcpSession;

  transportSequenceNumber = 0;

  private localCertificate: RTCCertificate;

  constructor(
    readonly iceTransport: RTCIceTransport,
    readonly router: RtpRouter,
    readonly certificates: RTCCertificate[],
    private readonly srtpProfiles: number[] = []
  ) {
    const certificate = certificates[0];
    this.localCertificate = certificate;
  }

  get localParameters() {
    return new RTCDtlsParameters(
      this.localCertificate ? this.localCertificate.getFingerprints() : []
    );
  }

  async start(remoteParameters: RTCDtlsParameters) {
    if (this.state !== DtlsState.NEW) throw new Error();
    if (remoteParameters.fingerprints.length === 0) throw new Error();

    if (this.iceTransport.role === "controlling") {
      this.role = "server";
    } else {
      this.role = "client";
    }

    this.setState(DtlsState.CONNECTING);

    await new Promise<void>(async (r) => {
      if (this.role === "server") {
        this.dtls = new DtlsServer({
          cert: this.localCertificate.cert,
          key: this.localCertificate.privateKey,
          transport: createIceTransport(this.iceTransport.connection),
          srtpProfiles: this.srtpProfiles,
        });
      } else {
        this.dtls = new DtlsClient({
          cert: this.localCertificate.cert,
          key: this.localCertificate.privateKey,
          transport: createIceTransport(this.iceTransport.connection),
          srtpProfiles: this.srtpProfiles,
        });
      }
      this.dtls.onData = (buf) => {
        if (this.dataReceiver) this.dataReceiver(buf);
      };
      this.dtls.onConnect = r;
      this.dtls.onClose = () => {
        this.setState(DtlsState.CLOSED);
      };

      //@ts-ignore
      if (this.dtls.connect) {
        await sleep(100);
        //@ts-ignore
        this.dtls.connect();
      }
    });

    if (this.srtpProfiles.length > 0) {
      this.startSrtp();
    }
    this.setState(DtlsState.CONNECTED);
  }

  srtpStarted = false;
  startSrtp() {
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

  sendData(data: Buffer) {
    this.dtls.send(data);
  }

  sendRtp(payload: Buffer, header: RtpHeader) {
    const enc = this.srtp.encrypt(payload, header);
    this.iceTransport.connection.send(enc);
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
      this.stateChanged.execute(state);
    }
  }

  stop() {
    this.setState(DtlsState.CLOSED);
  }
}

export class RTCCertificate {
  publicKey: string;
  privateKey: string;
  cert: string;
  constructor(privateKeyPem: string, certPem: string) {
    const cert = Certificate.fromPEM(Buffer.from(certPem));
    this.publicKey = cert.publicKey.toPEM();
    this.privateKey = PrivateKey.fromPEM(Buffer.from(privateKeyPem)).toPEM();
    this.cert = certPem;
  }

  getFingerprints(): RTCDtlsFingerprint[] {
    return [
      new RTCDtlsFingerprint(
        "sha-256",
        fingerprint(Certificate.fromPEM(Buffer.from(this.cert)).raw, "sha256")
      ),
    ];
  }

  static unsafe_useDefaultCertificate() {
    return new RTCCertificate(defaultPrivateKey, defaultCertificate);
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

  send(buf: Buffer) {
    this.ice.send(buf);
  }

  close() {
    this.ice.close();
  }
}

const createIceTransport = (ice: Connection) => new IceTransport(ice);
