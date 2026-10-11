import { CipherSuite, CipherSuiteList } from "../../src/cipher/const";
import { createCipher } from "../../src/cipher/create";
import { SessionType } from "../../src/cipher/suites/abstract";
import AEADChaCha20Poly1305Cipher from "../../src/cipher/suites/chacha";

const CHACHA20_RSA = 0xcca8;
const CHACHA20_ECDSA = 0xcca9;

// Deterministic key material; values are arbitrary but shared by both peers so
// they derive identical write keys/IVs (as they would after a real handshake).
const masterSecret = Buffer.alloc(48, 0x0b);
const clientRandom = Buffer.alloc(32, 0x01);
const serverRandom = Buffer.alloc(32, 0x02);

const header = (sequenceNumber: number) => ({
  type: 23, // application_data
  version: 0xfefd, // DTLS 1.2
  epoch: 1,
  sequenceNumber,
});

function initPair() {
  const client = createCipher(CHACHA20_RSA) as AEADChaCha20Poly1305Cipher;
  const server = createCipher(CHACHA20_RSA) as AEADChaCha20Poly1305Cipher;
  client.init(masterSecret, serverRandom, clientRandom);
  server.init(masterSecret, serverRandom, clientRandom);
  return { client, server };
}

describe("cipher/suites/chacha", () => {
  test("0xcca8 / 0xcca9 are offered in the ClientHello cipher list", () => {
    expect(CipherSuiteList).toContain(CHACHA20_RSA);
    expect(CipherSuiteList).toContain(CHACHA20_ECDSA);
    expect(CipherSuite.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256_52392).toBe(
      CHACHA20_RSA,
    );
  });

  test("createCipher(0xcca8) returns a ChaCha20-Poly1305 cipher (RFC 7905 params)", () => {
    const cipher = createCipher(CHACHA20_RSA) as AEADChaCha20Poly1305Cipher;
    expect(cipher).toBeInstanceOf(AEADChaCha20Poly1305Cipher);
    expect(cipher.keyLength).toBe(32);
    expect(cipher.nonceLength).toBe(12);
    expect(cipher.authTagLength).toBe(16);
    // No explicit (per-record) nonce on the wire.
    expect(cipher.nonceExplicitLength).toBe(0);
  });

  test("client-encrypted record round-trips through server decrypt", () => {
    const { client, server } = initPair();
    const plaintext = Buffer.from("the quick brown fox");

    const sealed = client.encrypt(SessionType.CLIENT, plaintext, header(0));
    // RFC 7905: ciphertext length == plaintext length, plus a 16-byte tag,
    // with no explicit nonce prefix.
    expect(sealed.length).toBe(plaintext.length + 16);

    const opened = server.decrypt(SessionType.SERVER, sealed, header(0));
    expect(opened).toEqual(plaintext);
  });

  test("server-encrypted record round-trips through client decrypt", () => {
    const { client, server } = initPair();
    const plaintext = Buffer.from("jumps over the lazy dog");

    const sealed = server.encrypt(SessionType.SERVER, plaintext, header(7));
    const opened = client.decrypt(SessionType.CLIENT, sealed, header(7));
    expect(opened).toEqual(plaintext);
  });

  test("distinct sequence numbers produce distinct ciphertexts (nonce varies)", () => {
    const { client } = initPair();
    const plaintext = Buffer.from("repeated plaintext");

    const a = client.encrypt(SessionType.CLIENT, plaintext, header(0));
    const b = client.encrypt(SessionType.CLIENT, plaintext, header(1));
    expect(a.equals(b)).toBe(false);
  });

  test("a tampered auth tag is rejected", () => {
    const { client, server } = initPair();
    const sealed = client.encrypt(
      SessionType.CLIENT,
      Buffer.from("authenticated"),
      header(0),
    );
    sealed[sealed.length - 1] ^= 0xff; // flip a tag byte

    expect(() =>
      server.decrypt(SessionType.SERVER, sealed, header(0)),
    ).toThrow();
  });
});
