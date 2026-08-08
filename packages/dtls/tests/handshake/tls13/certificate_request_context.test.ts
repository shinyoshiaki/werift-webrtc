import { describe, expect, test } from "vitest";
import { DEFAULT_SIGNATURE_SCHEMES } from "../../../src/handshake/extensions/signatureAlgorithms";
import { CertificateRequest13 } from "../../../src/handshake/message/tls13/certificateRequest";

describe("CertificateRequest13 main handshake context", () => {
  test("create() with empty context is valid for main handshake", () => {
    // Arrange / Act: RFC 8446 §4.3.2 — main HS context SHALL be zero-length
    const cr = CertificateRequest13.create(
      Buffer.alloc(0),
      DEFAULT_SIGNATURE_SCHEMES,
    );
    const wire = cr.serialize();
    const parsed = CertificateRequest13.deSerialize(wire);
    // Assert
    expect(parsed.certificateRequestContext.length).toBe(0);
    expect(parsed.extensions.length).toBeGreaterThan(0);
  });
});
