import { Certificate, PrivateKey } from "@fidm/x509";
import Event from "rx.mini";
import { RTCIceTransport } from "./ice";
import { DtlsServer, DtlsClient, DtlsSocket } from "../../vendor/dtls";
import { fingerprint, createIceTransport } from "../../utils";
import { sleep } from "../../helper";

export enum DtlsState {
  NEW = 0,
  CONNECTING = 1,
  CONNECTED = 2,
  CLOSED = 3,
  FAILED = 4,
}

type DtlsRole = "auto" | "server" | "client";

export class RTCDtlsTransport {
  dtls?: DtlsSocket;
  stateChanged = new Event<DtlsState>();
  state = DtlsState.NEW;
  private localCertificate: RTCCertificate;
  role: DtlsRole = "auto";
  dataReceiver?: (buf: Buffer) => void;

  constructor(
    public iceTransport: RTCIceTransport,
    certificates: RTCCertificate[],
    public srtpProfiles: number[] = []
  ) {
    const certificate = certificates[0];
    this.localCertificate = certificate;
  }

  getLocalParameters() {
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

    await new Promise(async (r) => {
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
      this.dtls.onConnect = () => {
        this.setState(DtlsState.CONNECTED);
        r();
      };
      this.dtls.onClose = () => {
        this.setState(DtlsState.CLOSED);
      };

      if (((this.dtls as any) as DtlsClient).connect!!) {
        await sleep(100);
        ((this.dtls as any) as DtlsClient).connect();
      }
    });
  }

  sendData(data: Buffer) {
    this.dtls!.send(data);
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
    return new RTCCertificate(
      `-----BEGIN PRIVATE KEY-----
    MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCsUhdMfiOlixc5
    N/GoJTY3o7seKd4mT9RdHQ3lOF/Xl8kLb3FSGztWGcklY0MahMKf5s9rgNh7kMOn
    3pcfy37KPjOBzgem1Kd7cU0cFjK0W9g8/ctqqUEqy4Ghbq8JSYZgIQABjFqQDJLE
    J/BLqrzD9r8v2p1I3RhoiV2+GpGlx5ZFfUsSoK3d5f6nYNmry70aD2i632kBTiDl
    aSZcOEka/uiR6RnaW+aCaTuliob6q0MKD2r6/9jlsGyHcwzDBm/gFD7j6JZyoETM
    utZ76CrhnDpxWzTrK2dbGgFNPETZV5clm3bmXa2jhCX566UPszYoAI9xHheh5+Ei
    OXX/DiSpAgMBAAECggEAbFERmiBz8bvzdiEHQuVZJjJCDVzN6hEl8P2xXVNJU3By
    jECZ372EV8PPnzO82292EyL3YKDV8x31DpEpN3Anm6Lrp31FbAWh3UND8BK3/oz4
    6KWzdrE7aFYRftLfLZxM3iIAKfj6eC+fFbPxJO8GxrtURBVL5qArlpI6HaP/x08c
    ovRF7HBCRIBUHpqmkYBOT1hzj+XT/1IfMRTb2XUKUJOVGYZ6GkG4OuQV7U61LJW9
    GniuYOlw9SIMgsiMYv+7iwLEgLU4DxCP+3Qmw2N9hzQsNBtvJRmAXUfxE+5bVslM
    LgKq+Pw6zFyS70fWXsnFQ+dKjYTXuvJz1DD9pj1MnQKBgQDY/2qw+58j6OQ85Ilh
    y9I+T+zZfHvtQfutWQ0A5fRrOlL3Bk5v9q061PXPokpFom8DVkOzGUxnBuloWZyc
    MNcgnW/PhsUiXQfKiZtaZQUyijI2ujOHu358xmNbiQkrS2IqEiZQlGTMQsjdqTu1
    CgeIWGZ4a0WMwHOp0qyPt8SSTwKBgQDLSvnxs5Z3sDkHlf6BdnMWGtkxjD7oCaHq
    0BCfsjpfYxFjd0+MAzCtjOxKxqN23F2FuwF5K0LkMSYGAdIxvAAaIRbRvXzJQA3s
    Fxy2NwzsdI+u8AZUKZM98p3WboajOeyiC5D73a6O4owFQc/AQTpg728+0hi3bSns
    yMfuOzzzhwKBgCmgdbsVyeV9m6sCvEgCbYZ+lpTyCGPvMHSEjLYLZuPbAGda0lkw
    HPMYPz9hhpXtHxaoybvlsn5hGQ1ng1+DDwG2sehBljeNWR1FYIPqtSCI2jEdbx0u
    nokZFZ5Nn3CquV4QtUDn9p4ogZfkCwwjrGY/bwjSqzjhAk8lluzK9+6JAoGBAJ4e
    fPWv91K0sEbkNYZAuRbyXwiYyrzz8QqQNr3fhGN4zKeOv0JpoMz8FTW79pyWne9M
    GsNCEM8oIyj89Z5VWcb5AaS1O3/U4H9HIr/fZZ/ssW0hp+qCQ9IlCPsmEHaYsSMA
    2A3uyLy+HKZiH9KraVrIIMC97ReOQtO2/zqevLO1AoGAImV+zywDZEzCRckhaKPB
    zZn2vq3xNVGjFU8uEQao+bFauDTlfg6ER9YXrKSZi0LZnO7ceyIrRbAJad9jmhJf
    v5/QTK1BlvJ52UxGn2C+SQVK7ZLO5U+lnrLJ8DmW4z7/hmK+VK7g27GxIbqVn75v
    MRWZMFdB3hM1ZJ3myUyE8qw=
    -----END PRIVATE KEY-----
    `,
      `-----BEGIN CERTIFICATE-----
    MIIDETCCAfkCFEtWAs2R7xuwFvkze6b7C0mNodXKMA0GCSqGSIb3DQEBCwUAMEUx
    CzAJBgNVBAYTAkFVMRMwEQYDVQQIDApTb21lLVN0YXRlMSEwHwYDVQQKDBhJbnRl
    cm5ldCBXaWRnaXRzIFB0eSBMdGQwHhcNMjAwNTE3MDQxMTIwWhcNMzAwNTE1MDQx
    MTIwWjBFMQswCQYDVQQGEwJBVTETMBEGA1UECAwKU29tZS1TdGF0ZTEhMB8GA1UE
    CgwYSW50ZXJuZXQgV2lkZ2l0cyBQdHkgTHRkMIIBIjANBgkqhkiG9w0BAQEFAAOC
    AQ8AMIIBCgKCAQEArFIXTH4jpYsXOTfxqCU2N6O7HineJk/UXR0N5Thf15fJC29x
    Uhs7VhnJJWNDGoTCn+bPa4DYe5DDp96XH8t+yj4zgc4HptSne3FNHBYytFvYPP3L
    aqlBKsuBoW6vCUmGYCEAAYxakAySxCfwS6q8w/a/L9qdSN0YaIldvhqRpceWRX1L
    EqCt3eX+p2DZq8u9Gg9out9pAU4g5WkmXDhJGv7okekZ2lvmgmk7pYqG+qtDCg9q
    +v/Y5bBsh3MMwwZv4BQ+4+iWcqBEzLrWe+gq4Zw6cVs06ytnWxoBTTxE2VeXJZt2
    5l2to4Ql+eulD7M2KACPcR4XoefhIjl1/w4kqQIDAQABMA0GCSqGSIb3DQEBCwUA
    A4IBAQBK3tyv1r3mMBxgHb3chNDtoqcdMQH4eznLQwKKvD/N6FLpDIoRL8BBShFa
    v5P+MWpsAzn9PpMxDLIJlzmJKcgxh/dA+CC8rj5Zdiyepzs8V5jMz9lL5htJeN/b
    nGn2BjuUqyzwlIKmiQADnhYxcD7gOJzfnXGrYPxnQoRujocnSrrgPyYfS08bDaP8
    lnEvp3yUlo4uRDqs24V+SdDfOSBGaSAlMjtugHc/GAN2jE1IOLbWGv2XJm0FL5IT
    B8GwHtA40Ar2XRQJdJhGkoMARqcOPbXKLy3EOUEMHbNAvwu+smqqn22zC0btKP39
    AtQOdUkFbpbYBfEjOzp2AtgUk1W+
    -----END CERTIFICATE-----
    `
    );
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
