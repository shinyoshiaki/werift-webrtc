import type { DtlsAlert } from "../alert";
import type { CipherContext } from "../context/cipher";
import type { DtlsContext } from "../context/dtls";
import { Alert } from "../handshake/message/alert";
import { debug } from "../imports/common";
import { alertDescName, ContentType } from "./const";
import { FragmentedHandshake } from "./message/fragment";
import { DtlsPlaintext } from "./message/plaintext";

const log = debug("werift-dtls : packages/dtls/record/receive.ts : log");
const err = debug("werift-dtls : packages/dtls/record/receive.ts : err");

/** DTLS record header: type(1) version(2) epoch(2) sequence(6) length(2). */
const recordHeaderLength = 13;

/**
 * Split a datagram into its records. A truncated record (shorter than its
 * header or its length field) ends the datagram: the records before it are
 * kept, the rest is discarded (RFC 6347 §4.1.2.1: invalid records are
 * silently discarded).
 */
export const parsePacket = (data: Buffer) => {
  let start = 0;
  const packets: DtlsPlaintext[] = [];
  while (data.length - start >= recordHeaderLength) {
    const fragmentLength = data.readUInt16BE(start + 11);
    if (data.length < start + recordHeaderLength + fragmentLength) {
      break;
    }
    const packet = DtlsPlaintext.deSerialize(data.subarray(start));
    packets.push(packet);

    start += recordHeaderLength + fragmentLength;
  }

  return packets;
};

export const parsePlainText =
  (dtls: DtlsContext, cipher: CipherContext) =>
  (
    plain: DtlsPlaintext,
  ): {
    type: ContentType;
    data: any;
  }[] => {
    const contentType = plain.recordLayerHeader.contentType;

    switch (contentType) {
      case ContentType.changeCipherSpec: {
        log(dtls.sessionId, "change cipher spec");
        return [
          {
            type: ContentType.changeCipherSpec,
            data: undefined,
          },
        ];
      }
      case ContentType.handshake: {
        let raw = plain.fragment;
        try {
          if (plain.recordLayerHeader.epoch > 0) {
            log(dtls.sessionId, "decrypt handshake");
            raw = cipher.decryptPacket(plain);
            dtls.remoteEpoch = Math.max(
              dtls.remoteEpoch,
              plain.recordLayerHeader.epoch,
            );
          }
        } catch (error) {
          err(dtls.sessionId, "decrypt failed", error);
          throw error;
        }
        try {
          let start = 0;
          const handshakes: { type: ContentType; data: any }[] = [];
          while (raw.length > start) {
            const handshake = FragmentedHandshake.deSerialize(
              raw.subarray(start),
            );
            handshakes.push({ type: ContentType.handshake, data: handshake });
            start += handshake.fragment_length + 12;
          }

          return handshakes;
        } catch (error) {
          err(dtls.sessionId, "decSerialize failed", error, raw);
          throw error;
        }
      }
      case ContentType.applicationData: {
        const data = cipher.decryptPacket(plain);
        dtls.remoteEpoch = Math.max(
          dtls.remoteEpoch,
          plain.recordLayerHeader.epoch,
        );
        return [{ type: ContentType.applicationData, data }];
      }
      case ContentType.alert: {
        // The record epoch tells whether the alert is protected: epoch 0 is
        // plaintext (before ChangeCipherSpec), epoch > 0 is encrypted. A
        // record that fails to decrypt throws and is dropped by the caller
        // (RFC 6347 §4.1.2.1: invalid records are silently discarded).
        const epoch = plain.recordLayerHeader.epoch;
        // Once the peer's protected records were accepted, a plaintext (or
        // older-epoch) alert is unauthenticated and must not end the
        // connection: drop it.
        if (epoch < dtls.remoteEpoch) {
          throw new Error("alert from a stale epoch");
        }
        const raw = epoch > 0 ? cipher.decryptPacket(plain) : plain.fragment;
        if (epoch > 0) {
          dtls.remoteEpoch = Math.max(dtls.remoteEpoch, epoch);
        }
        if (raw.length < 2) {
          throw new Error("malformed alert record");
        }
        // A record may carry several alerts (RFC 5246 §6.2.1, unchanged by
        // RFC 6347 §4.1): return all of them in order. The receiver stops at
        // the first one that ends the connection. A trailing partial alert
        // cannot be reassembled across DTLS records and is dropped.
        const alerts: { type: ContentType; data: DtlsAlert }[] = [];
        for (let start = 0; start + 2 <= raw.length; start += 2) {
          const alert = Alert.deSerialize(raw.subarray(start, start + 2));
          log(
            dtls.sessionId,
            "ContentType.alert",
            alert,
            alertDescName(alert.description),
            "flight",
            dtls.flight,
            "lastFlight",
            dtls.lastFlight,
          );
          alerts.push({
            type: ContentType.alert,
            data: { level: alert.level, description: alert.description },
          });
        }
        if (raw.length % 2 !== 0) {
          err(dtls.sessionId, "drop a partial alert at the end of the record");
        }
        return alerts;
      }
      default: {
        // Unknown content type: nothing to deliver (RFC 6347 §4.1.2.1).
        return [];
      }
    }
  };
