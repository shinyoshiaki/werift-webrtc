import { decode, types } from "@shinyoshiaki/binary-data";

import { setTimeout } from "timers/promises";
import { Event, type Transport, debug } from "./imports/common.js";

import {
  NamedCurveAlgorithmList,
  type SignatureHash,
  signatures,
} from "./cipher/const.js";
import { exportKeyingMaterial } from "./cipher/prf.js";
import { SessionType, type SessionTypes } from "./cipher/suites/abstract.js";
import { CipherContext } from "./context/cipher.js";
import { DtlsContext } from "./context/dtls.js";
import { SrtpContext } from "./context/srtp.js";
import { TransportContext } from "./context/transport.js";
import { EllipticCurves } from "./handshake/extensions/ellipticCurves.js";
import { ExtendedMasterSecret } from "./handshake/extensions/extendedMasterSecret.js";
import { RenegotiationIndication } from "./handshake/extensions/renegotiationIndication.js";
import { Signature } from "./handshake/extensions/signature.js";
import { UseSRTP } from "./handshake/extensions/useSrtp.js";
import type { SrtpProfile } from "./imports/rtp.js";
import { createPlaintext } from "./record/builder.js";
import { ContentType } from "./record/const.js";
import { FragmentedHandshake } from "./record/message/fragment.js";
import { parsePacket, parsePlainText } from "./record/receive.js";
import type { Extension } from "./typings/domain.js";

const log = debug("werift-dtls : packages/dtls/src/socket.ts : log");
const err = debug("werift-dtls : packages/dtls/src/socket.ts : err");

export class DtlsSocket {
  readonly onConnect = new Event();
  readonly onData = new Event<[Buffer]>();
  readonly onError = new Event<[Error]>();
  readonly onClose = new Event();
  readonly transport: TransportContext;
  cipher: CipherContext;
  dtls: DtlsContext;
  srtp: SrtpContext = new SrtpContext();

  connected = false;
  extensions: Extension[] = [];
  onHandleHandshakes!: (assembled: FragmentedHandshake[]) => Promise<void>;

  private bufferFragmentedHandshakes: FragmentedHandshake[] = [];

  constructor(
    public options: Options,
    public sessionType: SessionTypes,
  ) {
    this.dtls = new DtlsContext(this.options, this.sessionType);
    this.cipher = new CipherContext(
      this.sessionType,
      this.options.cert,
      this.options.key,
      this.options.signatureHash,
    );
    this.transport = new TransportContext(this.options.transport);
    this.setupExtensions();
    this.transport.socket.onData = this.udpOnMessage;
  }

  renegotiation() {
    log("renegotiation", this.sessionType);
    this.connected = false;
    this.cipher = new CipherContext(
      this.sessionType,
      this.options.cert,
      this.options.key,
      this.options.signatureHash,
    );
    this.dtls = new DtlsContext(this.options, this.sessionType);
    this.srtp = new SrtpContext();
    this.extensions = [];
    this.bufferFragmentedHandshakes = [];
  }

  private udpOnMessage = (data: Buffer) => {
    const packets = parsePacket(data);

    for (const packet of packets) {
      try {
        const messages = parsePlainText(this.dtls, this.cipher)(packet);
        for (const message of messages) {
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
                    {},
                  ),
                )
                  .map((v) => FragmentedHandshake.assemble(v))
                  .sort((a, b) => a.msg_type - b.msg_type);

                this.onHandleHandshakes(assembled).catch((error) => {
                  err(this.dtls.sessionId, "onHandleHandshakes error", error);
                  this.onError.execute(error);
                });
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
      } catch (error) {
        err(this.dtls.sessionId, "catch udpOnMessage error", error);
      }
    }
  };

  private setupExtensions() {
    log(this.dtls.sessionId, "support srtpProfiles", this.options.srtpProfiles);
    if (this.options.srtpProfiles && this.options.srtpProfiles.length > 0) {
      const useSrtp = UseSRTP.create(
        this.options.srtpProfiles,
        Buffer.from([0x00]),
      );
      this.extensions.push(useSrtp.extension);
    }

    {
      const curve = EllipticCurves.createEmpty();
      curve.data = NamedCurveAlgorithmList;
      this.extensions.push(curve.extension);
    }

    {
      const signature = Signature.createEmpty();
      // libwebrtc/OpenSSL require 4=1 , 4=3 signatureHash
      signature.data = signatures;
      this.extensions.push(signature.extension);
    }
    if (this.options.extendedMasterSecret) {
      this.extensions.push({
        type: ExtendedMasterSecret.type,
        data: Buffer.alloc(0),
      });
    }

    {
      const renegotiationIndication = RenegotiationIndication.createEmpty();
      this.extensions.push(renegotiationIndication.extension);
    }
  }

  protected waitForReady = (condition: () => boolean) =>
    new Promise<void>(async (r, f) => {
      for (let i = 0; i < 10; i++) {
        if (condition()) {
          r();
          break;
        } else {
          await setTimeout(100 * i);
        }
      }
      f("waitForReady timeout");
    });

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
      const [last] = this.bufferFragmentedHandshakes.slice(-1);
      if (last.fragment_offset + last.fragment_length === last.length) {
        handshakes = [...this.bufferFragmentedHandshakes, ...handshakes];
        this.bufferFragmentedHandshakes = [];
      }
    }
    return handshakes; // return un fragmented handshakes
  }

  /**send application data */
  send = async (buf: Buffer) => {
    const pkt = createPlaintext(this.dtls)(
      [{ type: ContentType.applicationData, fragment: buf }],
      ++this.dtls.recordSequenceNumber,
    )[0];
    await this.transport.send(this.cipher.encryptPacket(pkt).serialize());
  };

  close() {
    this.transport.socket.close();
  }

  extractSessionKeys(keyLength: number, saltLength: number) {
    const keyingMaterial = this.exportKeyingMaterial(
      "EXTRACTOR-dtls_srtp",
      keyLength * 2 + saltLength * 2,
    );

    const { clientKey, serverKey, clientSalt, serverSalt } = decode(
      keyingMaterial,
      {
        clientKey: types.buffer(keyLength),
        serverKey: types.buffer(keyLength),
        clientSalt: types.buffer(saltLength),
        serverSalt: types.buffer(saltLength),
      },
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
      this.sessionType === SessionType.CLIENT,
    );
  }
}

export interface Options {
  transport: Transport;
  srtpProfiles?: SrtpProfile[];
  cert?: string;
  key?: string;
  signatureHash?: SignatureHash;
  certificateRequest?: boolean;
  extendedMasterSecret?: boolean;
}
