import { RTCIceTransport } from "./ice";
import { addDays } from "date-fns";
import { pki } from "node-forge";
import { randomBytes, createHash } from "crypto";
import { Subject } from "rxjs";
import { RTCSctpTransport } from "./sctp/sctp";

export enum State {
  NEW = 0,
  CONNECTING = 1,
  CONNECTED = 2,
  CLOSED = 3,
  FAILED = 4,
}

export class RTCDtlsTransport {
  stateChange = new Subject<State>();
  state = State.NEW;
  private localCertificate: RTCCertificate;
  private role = "auto";
  private dataReceiver?: RTCSctpTransport;

  constructor(
    public transport: RTCIceTransport,
    certificates: RTCCertificate[]
  ) {
    const certificate = certificates[0];
    this.localCertificate = certificate;
  }

  getLocalParameters() {
    // todo fix
    return new RTCDtlsParameters(
      this.localCertificate ? this.localCertificate.getFingerprints() : []
    );
  }

  async start(remoteParameters: RTCDtlsParameters) {
    if (this.state !== State.NEW) throw new Error();
    if (remoteParameters.fingerprints.length === 0) {
      // throw new Error();
    }

    if (this.transport.role === "controlling") {
      this.role = "server";
    } else {
      this.role = "client";
    }

    this.setState(State.CONNECTING);

    const options = {};
  }

  async sendData(data: Buffer) {
    await this.writeSSL();
  }

  private async writeSSL() {}

  private setState(state: State) {
    if (state != this.state) {
      this.state = state;
      this.stateChange.next(state);
    }
  }

  registerDataReceiver(receiver: RTCSctpTransport) {
    if (this.dataReceiver) throw new Error();
    this.dataReceiver = receiver;
  }
}

export class RTCCertificate {
  constructor(private keys: pki.rsa.KeyPair, private cert: pki.Certificate) {}

  get expires() {
    return this.cert.validity.notAfter;
  }

  getFingerprints(): RTCDtlsFingerprint[] {
    return [
      new RTCDtlsFingerprint(
        "sha-256",
        certificateDigest(pki.publicKeyToPem(this.cert.publicKey))
      ),
    ];
  }
}

function certificateDigest(x509: string) {
  const hash = createHash("sha256")
    .update(Buffer.from(x509))
    .digest("hex");

  const upper = (s: string) => s.toUpperCase();
  const colon = (s: string) => s.match(/(.{2})/g)!.join(":");

  return colon(upper(hash));
}

export class RTCDtlsFingerprint {
  constructor(public algorithm: string, public value: unknown) {}
}

export class RTCDtlsParameters {
  constructor(
    public fingerprints: RTCDtlsFingerprint[] = [],
    public role: "auto" | "client" | undefined = "auto"
  ) {}
}
