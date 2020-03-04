import { RTCIceTransport } from "./ice";
import { ec } from "elliptic";
import { addDays } from "date-fns";
import { pki } from "node-forge";
import { randomBytes } from "crypto";

export class RTCDtlsTransport {
  private localCertificate: RTCCertificate;

  constructor(
    public transport: RTCIceTransport,
    certificates: RTCCertificate[]
  ) {
    const certificate = certificates[0];
    this.localCertificate = certificate;
  }

  getLocalParameters() {
    return new RTCDtlsParameters(this.localCertificate.getFingerprints());
  }
}

export class RTCCertificate {
  constructor(private keys: pki.rsa.KeyPair, private cert: pki.Certificate) {}

  get expires() {
    return this.cert.validity.notAfter;
  }

  getFingerprints(): RTCDtlsFingerprint[] {
    return [];
    // [new RTCDtlsFingerprint("sha-256",this.cert.)]
  }

  static generateCertificate() {
    return new RTCCertificate(...generateCertificate());
  }
}

function generateCertificate(): [pki.rsa.KeyPair, pki.Certificate] {
  const keys = pki.rsa.generateKeyPair(2048);
  const cert = pki.createCertificate();
  const attrs = [
    { name: "commonName", value: randomBytes(16).toString("ascii") }
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.publicKey = keys.publicKey;
  cert.serialNumber = randomBytes(20).toString("hex");
  cert.validity.notBefore = addDays(new Date(), -1);
  cert.validity.notAfter = addDays(new Date(), 30);
  cert.sign(keys.privateKey);

  return [keys, cert];
}

export class RTCDtlsFingerprint {
  constructor(public algorithm: string, public value: string) {}
}

export class RTCDtlsParameters {
  constructor(
    public fingerprints: RTCDtlsFingerprint[] = [],
    public role: "auto" | "client" | undefined = "auto"
  ) {}
}
