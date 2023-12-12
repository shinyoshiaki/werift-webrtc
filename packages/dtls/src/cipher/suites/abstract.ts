import { KeyExchange } from "../key-exchange";

export type CipherHeader = {
  type: number;
  version: number;
  epoch: number;
  sequenceNumber: number;
};

export const SessionType = {
  CLIENT: 1,
  SERVER: 2,
} as const;
export type SessionTypes = (typeof SessionType)[keyof typeof SessionType];

export default abstract class AbstractCipher {
  id = 0;
  name?: string;
  hashAlgorithm?: string;
  verifyDataLength = 12;

  blockAlgorithm?: string;
  kx?: KeyExchange;

  /**
   * Init cipher.
   * @abstract
   */
  init(...args: any) {
    throw new Error("not implemented");
  }

  /**
   * Encrypts data.
   * @abstract
   */
  encrypt(...args: any): Buffer {
    throw new Error("not implemented");
  }

  /**
   * Decrypts data.
   * @abstract
   */
  decrypt(...args: any): Buffer {
    throw new Error("not implemented");
  }

  /**
   * @returns {string}
   */
  toString() {
    return this.name;
  }
}
