import { TransportContext } from "./context/transport";
import { DtlsContext } from "./context/dtls";
import { CipherContext } from "./context/cipher";
import { createPlaintext } from "./record/builder";
import { ContentType } from "./record/const";
import { Transport } from "./transport";
import { UseSRTP } from "./handshake/extensions/useSrtp";
import { EllipticCurves } from "./handshake/extensions/ellipticCurves";
import {
  NamedCurveAlgorithm,
  HashAlgorithm,
  SignatureAlgorithm,
} from "./cipher/const";
import { Signature } from "./handshake/extensions/signature";
import { Extension } from "./typings/domain";
import { SrtpContext } from "./context/srtp";
import { exportKeyingMaterial } from "./cipher/prf";
import { decode, types } from "binary-data";
import { Event } from "rx.mini";
import debug from "debug";
import { ExtendedMasterSecret } from "./handshake/extensions/extendedMasterSecret";
import { RenegotiationIndication } from "./handshake/extensions/renegotiationIndication";
import { SessionType, SessionTypes } from "./cipher/suites/abstract";

const log = debug("werift/dtls/socket");

export interface Options {
  transport: Transport;
  srtpProfiles?: number[];
  cert?: string;
  key?: string;
  certificateRequest?: boolean;
  extendedMasterSecret?: boolean;
}

export class DtlsSocket {
  readonly onConnect = new Event();
  readonly onData = new Event<[Buffer]>();
  readonly onClose = new Event();
  readonly udp: TransportContext = new TransportContext(this.options.transport);
  readonly cipher: CipherContext = new CipherContext(
    this.sessionType,
    this.options.cert,
    this.options.key
  );
  readonly dtls: DtlsContext = new DtlsContext(this.options, this.sessionType);
  readonly srtp: SrtpContext = new SrtpContext();
  extensions: Extension[] = [];

  constructor(public options: Options, public sessionType: SessionTypes) {
    this.setupExtensions();
  }

  private setupExtensions() {
    log("support srtpProfiles", this.options.srtpProfiles);
    if (this.options.srtpProfiles && this.options.srtpProfiles.length > 0) {
      const useSrtp = UseSRTP.create(
        this.options.srtpProfiles,
        Buffer.from([0x00])
      );
      this.extensions.push(useSrtp.extension);
    }

    const curve = EllipticCurves.createEmpty();
    curve.data = Object.values(NamedCurveAlgorithm);
    this.extensions.push(curve.extension);

    const signature = Signature.createEmpty();
    signature.data = [
      { hash: HashAlgorithm.sha256, signature: SignatureAlgorithm.rsa },
      // { hash: HashAlgorithm.sha256, signature: SignatureAlgorithm.ecdsa }, // todo fix
    ];
    this.extensions.push(signature.extension);

    if (this.options.extendedMasterSecret) {
      this.extensions.push({
        type: ExtendedMasterSecret.type,
        data: Buffer.alloc(0),
      });
    }

    const renegotiationIndication = RenegotiationIndication.createEmpty();
    this.extensions.push(renegotiationIndication.extension);
  }

  send(buf: Buffer) {
    const pkt = createPlaintext(this.dtls)(
      [{ type: ContentType.applicationData, fragment: buf }],
      ++this.dtls.recordSequenceNumber
    )[0];
    this.udp.send(this.cipher.encryptPacket(pkt).serialize());
  }

  close() {
    this.udp.socket.close();
  }

  extractSessionKeys() {
    const keyLen = 16;
    const saltLen = 14;

    const keyingMaterial = this.exportKeyingMaterial(
      "EXTRACTOR-dtls_srtp",
      keyLen * 2 + saltLen * 2
    );

    const { clientKey, serverKey, clientSalt, serverSalt } = decode(
      keyingMaterial,
      {
        clientKey: types.buffer(keyLen),
        serverKey: types.buffer(keyLen),
        clientSalt: types.buffer(saltLen),
        serverSalt: types.buffer(saltLen),
      }
    );

    if ((this.sessionType = SessionType.CLIENT)) {
      return {
        localKey: clientKey,
        localSalt: clientSalt,
        remoteKey: serverKey,
        remoteSalt: serverSalt,
      };
    } else {
      return {
        localKey: serverKey,
        localSalt: serverSalt,
        remoteKey: clientKey,
        remoteSalt: clientSalt,
      };
    }
  }

  exportKeyingMaterial(label: string, length: number) {
    return exportKeyingMaterial(
      label,
      length,
      this.cipher.masterSecret,
      this.cipher.localRandom.serialize(),
      this.cipher.remoteRandom.serialize(),
      this.sessionType === SessionType.CLIENT
    );
  }
}
