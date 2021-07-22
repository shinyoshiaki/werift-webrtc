import debug from "debug";

import { CipherContext } from "../context/cipher";
import { DtlsContext } from "../context/dtls";
import { Alert } from "../handshake/message/alert";
import { ContentType } from "./const";
import { FragmentedHandshake } from "./message/fragment";
import { DtlsPlaintext } from "./message/plaintext";

const log = debug("werift-dtls : packages/dtls/record/receive.ts : log");
const err = debug("werift-dtls : packages/dtls/record/receive.ts : err");

export const parsePacket = (data: Buffer) => {
  let start = 0;
  const packets: DtlsPlaintext[] = [];
  while (data.length > start) {
    const fragmentLength = data.readUInt16BE(start + 11);
    if (data.length < start + (12 + fragmentLength)) break;
    const packet = DtlsPlaintext.deSerialize(data.slice(start));
    packets.push(packet);

    start += 13 + fragmentLength;
  }

  return packets;
};

export const parsePlainText =
  (dtls: DtlsContext, cipher: CipherContext) => (plain: DtlsPlaintext) => {
    const contentType = plain.recordLayerHeader.contentType;

    switch (contentType) {
      case ContentType.changeCipherSpec: {
        log(dtls.id, "change cipher spec");
        return {
          type: ContentType.changeCipherSpec,
          data: undefined,
        };
      }
      case ContentType.handshake: {
        let raw = plain.fragment;
        try {
          if (plain.recordLayerHeader.epoch > 0) {
            log(dtls.id, "decrypt handshake");
            raw = cipher.decryptPacket(plain);
          }
        } catch (error) {
          err(
            "decrypt failed",
            error,
            FragmentedHandshake.deSerialize(raw).summary
          );
        }
        return {
          type: ContentType.handshake,
          data: FragmentedHandshake.deSerialize(raw),
        };
      }
      case ContentType.applicationData: {
        return {
          type: ContentType.applicationData,
          data: cipher.decryptPacket(plain),
        };
      }
      case ContentType.alert: {
        const alert = Alert.deSerialize(plain.fragment);
        err(dtls.id, "ContentType.alert", alert, dtls.flight, dtls.lastFlight);
        if (alert.level > 1) throw new Error("alert fatal error");
      }
      // eslint-disable-next-line no-fallthrough
      default: {
        return { type: ContentType.alert, data: undefined };
      }
    }
  };
