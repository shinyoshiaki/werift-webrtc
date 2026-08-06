import {
  DTLS13_LABEL_PREFIX,
  deriveSecret,
  emptyHashSha256,
  hashSha256,
  hkdfExpandLabelManual,
  hkdfExtract,
  hmacSha256,
} from "./hkdf";

const HASH_LEN = 32;
const KEY_LEN = 16; // AES-128
const IV_LEN = 12;

export interface TrafficKeys {
  key: Buffer;
  iv: Buffer;
  /** sn_key for DTLS 1.3 record number encryption (AES-128) */
  snKey: Buffer;
}

export interface Dtls13KeyScheduleState {
  earlySecret: Buffer;
  handshakeSecret: Buffer;
  masterSecret: Buffer;
  clientHandshakeTrafficSecret: Buffer;
  serverHandshakeTrafficSecret: Buffer;
  clientApplicationTrafficSecret: Buffer;
  serverApplicationTrafficSecret: Buffer;
  exporterMasterSecret: Buffer;
  resumptionMasterSecret?: Buffer;
}

/**
 * Full TLS 1.3 / DTLS 1.3 key schedule (PSK-less full handshake path).
 * Label prefix defaults to "dtls13" (RFC 9147).
 */
export class Dtls13KeySchedule {
  constructor(private readonly labelPrefix: string = DTLS13_LABEL_PREFIX) {}

  earlySecret(psk: Buffer = Buffer.alloc(0)): Buffer {
    // Early Secret = HKDF-Extract(0, PSK) with zeros of Hash.length when PSK empty
    const ikm = psk.length === 0 ? Buffer.alloc(HASH_LEN) : psk;
    return hkdfExtract(Buffer.alloc(HASH_LEN), ikm);
  }

  deriveHandshakeSecrets(
    sharedSecret: Buffer,
    helloTranscript: Buffer,
  ): {
    earlySecret: Buffer;
    handshakeSecret: Buffer;
    clientHandshakeTrafficSecret: Buffer;
    serverHandshakeTrafficSecret: Buffer;
  } {
    const earlySecret = this.earlySecret();
    const derived = deriveSecret(
      earlySecret,
      "derived",
      Buffer.alloc(0),
      this.labelPrefix,
    );
    // For empty messages, Derive-Secret uses Hash("")
    // deriveSecret already hashes messages; for "derived" use empty hash context:
    const derivedSecret = hkdfExpandLabelManual(
      earlySecret,
      "derived",
      emptyHashSha256(),
      HASH_LEN,
      this.labelPrefix,
    );
    const handshakeSecret = hkdfExtract(derivedSecret, sharedSecret);

    const clientHandshakeTrafficSecret = deriveSecret(
      handshakeSecret,
      "c hs traffic",
      helloTranscript,
      this.labelPrefix,
    );
    const serverHandshakeTrafficSecret = deriveSecret(
      handshakeSecret,
      "s hs traffic",
      helloTranscript,
      this.labelPrefix,
    );

    return {
      earlySecret,
      handshakeSecret,
      clientHandshakeTrafficSecret,
      serverHandshakeTrafficSecret,
    };
  }

  deriveApplicationSecrets(
    handshakeSecret: Buffer,
    handshakeTranscript: Buffer,
  ): {
    masterSecret: Buffer;
    clientApplicationTrafficSecret: Buffer;
    serverApplicationTrafficSecret: Buffer;
    exporterMasterSecret: Buffer;
  } {
    const derivedSecret = hkdfExpandLabelManual(
      handshakeSecret,
      "derived",
      emptyHashSha256(),
      HASH_LEN,
      this.labelPrefix,
    );
    const masterSecret = hkdfExtract(derivedSecret, Buffer.alloc(HASH_LEN));

    const clientApplicationTrafficSecret = deriveSecret(
      masterSecret,
      "c ap traffic",
      handshakeTranscript,
      this.labelPrefix,
    );
    const serverApplicationTrafficSecret = deriveSecret(
      masterSecret,
      "s ap traffic",
      handshakeTranscript,
      this.labelPrefix,
    );
    const exporterMasterSecret = deriveSecret(
      masterSecret,
      "exp master",
      handshakeTranscript,
      this.labelPrefix,
    );

    return {
      masterSecret,
      clientApplicationTrafficSecret,
      serverApplicationTrafficSecret,
      exporterMasterSecret,
    };
  }

  trafficKeys(trafficSecret: Buffer): TrafficKeys {
    return {
      key: hkdfExpandLabelManual(
        trafficSecret,
        "key",
        Buffer.alloc(0),
        KEY_LEN,
        this.labelPrefix,
      ),
      iv: hkdfExpandLabelManual(
        trafficSecret,
        "iv",
        Buffer.alloc(0),
        IV_LEN,
        this.labelPrefix,
      ),
      /** Record number encryption key (RFC 9147 §4.2.3) */
      snKey: hkdfExpandLabelManual(
        trafficSecret,
        "sn",
        Buffer.alloc(0),
        KEY_LEN,
        this.labelPrefix,
      ),
    };
  }

  finishedKey(baseKey: Buffer): Buffer {
    return hkdfExpandLabelManual(
      baseKey,
      "finished",
      Buffer.alloc(0),
      HASH_LEN,
      this.labelPrefix,
    );
  }

  verifyData(baseKey: Buffer, transcript: Buffer): Buffer {
    const finishedKey = this.finishedKey(baseKey);
    return hmacSha256(finishedKey, hashSha256(transcript));
  }

  /**
   * Traffic secret update for KeyUpdate (RFC 8446 §7.2).
   * application_traffic_secret_N+1 =
   *   HKDF-Expand-Label(..., "traffic upd", "", Hash.length)
   */
  updateTrafficSecret(secret: Buffer): Buffer {
    return hkdfExpandLabelManual(
      secret,
      "traffic upd",
      Buffer.alloc(0),
      HASH_LEN,
      this.labelPrefix,
    );
  }

  /**
   * TLS 1.3 exporter (RFC 8446 §7.5).
   * Used for DTLS-SRTP EXTRACTOR-dtls_srtp on 1.3 connections.
   */
  exportKeyingMaterial(
    exporterMasterSecret: Buffer,
    label: string,
    context: Buffer,
    length: number,
  ): Buffer {
    // Derive-Secret(exporter_master_secret, label, "") then
    // HKDF-Expand-Label(..., "exporter", Hash(context), Length)
    const derived = deriveSecret(
      exporterMasterSecret,
      label,
      Buffer.alloc(0),
      this.labelPrefix,
    );
    return hkdfExpandLabelManual(
      derived,
      "exporter",
      hashSha256(context),
      length,
      this.labelPrefix,
    );
  }
}

export const defaultKeySchedule = new Dtls13KeySchedule(DTLS13_LABEL_PREFIX);
