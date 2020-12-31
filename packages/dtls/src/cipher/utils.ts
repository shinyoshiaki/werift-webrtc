import * as crypto from "crypto";

/**
 * Culculates HMAC using provided hash.
 * @param {string} algorithm - Hash algorithm.
 * @param {Buffer} secret - Hmac seed.
 * @param {Buffer} data - Input data.
 * @returns {Buffer}
 */
function hmac(algorithm: string, secret: Buffer, data: Buffer) {
  const hash = crypto.createHmac(algorithm, secret);
  hash.update(data);
  return hash.digest();
}

/**
 * A data expansion function for PRF.
 * @param {number} bytes - The number of bytes required by PRF.
 * @param {string} algorithm - Hmac hash algorithm.
 * @param {Buffer} secret - Hmac secret.
 * @param {Buffer} seed - Input data.
 * @returns {Buffer}
 */
function pHash(bytes: number, algorithm: string, secret: Buffer, seed: Buffer) {
  const totalLength = bytes;
  const bufs: Buffer[] = [];
  let Ai = seed; // A0

  do {
    Ai = hmac(algorithm, secret, Ai); // A(i) = HMAC(secret, A(i-1))
    const output = hmac(algorithm, secret, Buffer.concat([Ai, seed]));

    bufs.push(output);
    bytes -= output.length; // eslint-disable-line no-param-reassign
  } while (bytes > 0);

  return Buffer.concat(bufs, totalLength);
}

export { hmac, pHash };
