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
  SignatureHash,
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
import { FragmentedHandshake } from "./record/message/fragment";
import { parsePacket, parsePlainText } from "./record/receive";

const log = debug("werift/dtls/socket");

export class DtlsSocket {
  readonly onConnect = new Event();
  readonly onData = new Event<[Buffer]>();
  readonly onClose = new Event();
  readonly udp: TransportContext = new TransportContext(this.options.transport);
  readonly cipher: CipherContext = new CipherContext(
    this.sessionType,
    this.options.cert,
    this.options.key,
    this.options.signatureHash
  );
  readonly dtls: DtlsContext = new DtlsContext(this.options, this.sessionType);
  readonly srtp: SrtpContext = new SrtpContext();

  extensions: Extension[] = [];
  onHandleHandshakes: (assembled: FragmentedHandshake[]) => void = () => {};

  private bufferFragmentedHandshakes: FragmentedHandshake[] = [];

  constructor(public options: Options, public sessionType: SessionTypes) {
    this.setupExtensions();
    this.udp.socket.onData = this.udpOnMessage;
  }

  private udpOnMessage = (data: Buffer) => {
    const packets = parsePacket(data);

    for (const packet of packets) {
      const message = parsePlainText(this.dtls, this.cipher)(packet);
      switch (message.type) {
        case ContentType.handshake:
          {
            const handshake = message.data as FragmentedHandshake;
            const handshakes = this.handleFragmentHandshake([handshake]);
            const assembled = Object.values(
              handshakes.reduce(
                (acc: { [type: string]: FragmentedHandshake[] }, cur) => {
                  if (!acc[cur.msg_type]) acc[cur.msg_type] = [];
                  acc[cur.msg_type].push(cur);
                  return acc;
                },
                {}
              )
            )
              .map((v) => FragmentedHandshake.assemble(v))
              .sort((a, b) => a.msg_type - b.msg_type);

            this.onHandleHandshakes(assembled);
          }
          break;
        case ContentType.applicationData:
          {
            this.onData.execute(message.data as Buffer);
          }
          break;
        case ContentType.alert:
          this.onClose.execute();
          break;
      }
    }
  };

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
    // libwebrtc require 4=1 , 4=3 signatureHash
    signature.data = [
      { hash: HashAlgorithm.sha256, signature: SignatureAlgorithm.rsa },
      { hash: HashAlgorithm.sha256, signature: SignatureAlgorithm.ecdsa },
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

  handleFragmentHandshake(messages: FragmentedHandshake[]) {
    let handshakes = messages.filter((v) => {
      // find fragmented
      if (v.fragment_length !== v.length) {
        this.bufferFragmentedHandshakes.push(v);
        return false;
      }
      return true;
    });

    if (this.bufferFragmentedHandshakes.length > 1) {
      const last = this.bufferFragmentedHandshakes.slice(-1)[0];
      if (last.fragment_offset + last.fragment_length === last.length) {
        handshakes = [...this.bufferFragmentedHandshakes, ...handshakes];
        this.bufferFragmentedHandshakes = [];
      }
    }
    return handshakes; // return un fragmented handshakes
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

    if (this.sessionType === SessionType.CLIENT) {
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

export interface Options {
  transport: Transport;
  srtpProfiles?: number[];
  cert?: string;
  key?: string;
  signatureHash?: SignatureHash;
  certificateRequest?: boolean;
  extendedMasterSecret?: boolean;
}
