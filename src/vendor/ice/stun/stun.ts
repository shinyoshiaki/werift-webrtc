import {
  HEADER_LENGTH,
  FINGERPRINT_LENGTH,
  FINGERPRINT_XOR,
  INTEGRITY_LENGTH,
  ATTRIBUTES,
  COOKIE,
  RETRY_RTO,
  RETRY_MAX,
} from "./const";
import { jspack } from "jspack";
import {
  ATTRIBUTES_BY_TYPE,
  unpackXorAddress,
  ATTRIBUTES_BY_NAME,
  packXorAddress,
} from "./attributes";
import { createHmac } from "crypto";
import crc32 from "buffer-crc32";
import { bufferXor, randomTransactionId } from "../utils";
import { Event } from "rx.mini";
import { Address } from "../model";
import { TransactionFailed, TransactionTimeout } from "../exceptions";
import { StunProtocol } from "../ice/protocol";

const setBodyLength = (data: Buffer, length: number) => {
  return Buffer.concat([
    data.slice(0, 2),
    Buffer.from(jspack.Pack("!H", [length])),
    data.slice(4),
  ]);
};

function messageFingerprint(data: Buffer) {
  const checkData = setBodyLength(
    data,
    data.length - HEADER_LENGTH + FINGERPRINT_LENGTH
  );
  const crc32Buf = crc32(checkData);
  const xorBuf = Buffer.alloc(4);
  xorBuf.writeInt32BE(FINGERPRINT_XOR, 0);
  const fingerprint = bufferXor(crc32Buf, xorBuf);
  return fingerprint.readUInt32BE(0);
}

function messageIntegrity(data: Buffer, key: Buffer) {
  const checkData = setBodyLength(
    data,
    data.length - HEADER_LENGTH + INTEGRITY_LENGTH
  );
  return Buffer.from(
    createHmac("sha1", key).update(checkData).digest("hex"),
    "hex"
  );
}

export function parseMessage(data: Buffer, integrityKey: Buffer | null = null) {
  if (data.length < HEADER_LENGTH) {
    throw new Error("STUN message length is less than 20 bytes");
  }
  let [messageType, length] = jspack.Unpack(
    "!HHI",
    data.slice(0, HEADER_LENGTH)
  );

  const transactionId = Buffer.from(
    data.slice(HEADER_LENGTH - 12, HEADER_LENGTH)
  );

  if (data.length !== HEADER_LENGTH + length)
    throw new Error("STUN message length does not match");

  const attributes: { [key: string]: any } = {};

  for (let pos = HEADER_LENGTH; pos <= data.length - 4; ) {
    const [attrType, attrLen] = jspack.Unpack("!HH", data.slice(pos, pos + 4));
    const v = data.slice(pos + 4, pos + 4 + attrLen);
    const padLen = 4 * Math.floor((attrLen + 3) / 4) - attrLen;
    const attributesTypes = Object.keys(ATTRIBUTES_BY_TYPE);
    if (attributesTypes.includes(attrType.toString())) {
      const [, attrName, , attrUnpack] = ATTRIBUTES_BY_TYPE[attrType];
      if (attrUnpack.name === unpackXorAddress.name) {
        attributes[attrName] = attrUnpack(v, transactionId);
      } else {
        attributes[attrName] = attrUnpack(v);
      }

      if (attrName === "FINGERPRINT") {
        const fingerprint = messageFingerprint(data.slice(0, pos));
        if (attributes[attrName] !== fingerprint) {
          throw new Error("STUN message fingerprint does not match");
        }
      } else if (attrName === "MESSAGE-INTEGRITY") {
        if (integrityKey) {
          const integrity = messageIntegrity(data.slice(0, pos), integrityKey);
          if (!integrity.equals(attributes[attrName])) {
            throw new Error("STUN message integrity does not match");
          }
        }
      }
    }
    pos += 4 + attrLen + padLen;
  }

  return new Message(
    messageType & 0x3eef,
    messageType & 0x0110,
    transactionId,
    attributes
  );
}

export enum classes {
  REQUEST = 0x000,
  INDICATION = 0x010,
  RESPONSE = 0x100,
  ERROR = 0x110,
}

export enum methods {
  BINDING = 0x1,
  SHARED_SECRET = 0x2,
  ALLOCATE = 0x3,
  REFRESH = 0x4,
  SEND = 0x6,
  DATA = 0x7,
  CREATE_PERMISSION = 0x8,
  CHANNEL_BIND = 0x9,
}

export class Message {
  constructor(
    public messageMethod: methods,
    public messageClass: classes,
    public transactionId: Buffer = randomTransactionId(),
    public attributes: { [key in typeof ATTRIBUTES[number]]?: any } = {}
  ) {}

  get attributesKeys(): typeof ATTRIBUTES[number][] {
    return Object.keys(this.attributes) as any;
  }

  get transactionIdHex() {
    return this.transactionId.toString("hex");
  }

  get bytes() {
    let data = Buffer.from([]);
    for (let attrName of this.attributesKeys) {
      const attrValue = (this.attributes as any)[attrName];
      const [attrType, , attrPack] = ATTRIBUTES_BY_NAME[attrName];
      const v =
        attrPack.name === packXorAddress.name
          ? attrPack(attrValue, this.transactionId)
          : attrPack(attrValue);
      const attrLen = v.length;
      const padLen = 4 * Math.floor((attrLen + 3) / 4) - attrLen;
      data = Buffer.concat([
        data,
        Buffer.from(jspack.Pack("!HH", [attrType, attrLen])),
        v,
        ...[...Array(padLen)].map(() => Buffer.from("\x00")),
      ]);
    }
    const buf = Buffer.from(
      jspack.Pack("!HHI", [
        this.messageMethod | this.messageClass,
        data.length,
        COOKIE,
      ])
    );

    return Buffer.concat([buf, this.transactionId, data]);
  }

  addFingerprint() {
    this.attributes["FINGERPRINT"] = messageFingerprint(this.bytes);
  }

  addMessageIntegrity(key: Buffer) {
    this.attributes["MESSAGE-INTEGRITY"] = messageIntegrity(this.bytes, key);
  }
}

export class Transaction {
  integrityKey?: Buffer;
  private timeoutDelay = RETRY_RTO;
  private timeoutHandle: NodeJS.Timeout | null = null;
  private tries = 0;
  private triesMax =
    1 + (this.retransmissions ? this.retransmissions : RETRY_MAX);
  private future = new Event<[Message, Address]>();

  constructor(
    private request: Message,
    private addr: Address,
    private protocol: StunProtocol,
    private retransmissions?: number
  ) {}

  responseReceived = (message: Message, addr: Address) => {
    if (this.future.length > 0) {
      if (message.messageClass === classes.RESPONSE) {
        this.future.execute([message, addr]);
        this.future.complete();
      } else {
        this.future.error(new TransactionFailed(message));
      }
    }
  };

  run = async () => {
    try {
      this.retry();
      return await this.future.asPromise();
    } catch (error) {
      throw error;
    } finally {
      if (this.timeoutHandle) {
        clearTimeout(this.timeoutHandle);
      }
    }
  };

  private retry = () => {
    // todo fix
    if (this.tries >= this.triesMax * 2) {
      this.future.error(new TransactionTimeout());
      return;
    }
    this.protocol.sendStun(this.request, this.addr);
    this.timeoutHandle = setTimeout(this.retry, this.timeoutDelay);
    this.timeoutDelay *= 2;
    this.tries++;
  };
}
