import { KeyExchange } from "../key-exchange";

export type CipherHeader = {
  type: number;
  version: number;
  epoch: number;
  sequenceNumber: number;
};

export enum SessionType {
  CLIENT = 1,
  SERVER = 2,
}

export default abstract class AbstractCipher {
  id = 0;
  name?: string;
  hash?: string;
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
