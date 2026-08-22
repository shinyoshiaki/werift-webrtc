import { describe, expect, test } from "vitest";
import { SignatureAlgorithms } from "../../../src/handshake/extensions/signatureAlgorithms";
import { Alert } from "../../../src/handshake/message/alert";
import { CertificateRequest13 } from "../../../src/handshake/message/tls13/certificateRequest";
import { AlertDesc } from "../../../src/record/const";

describe("TLS 1.3 alert codec", () => {
  test("alert has level and description bytes", () => {
    // Arrange: 前提を準備する
    const a = new Alert(2, AlertDesc.HandshakeFailure);
    const wire = a.serialize();
    const b = Alert.deSerialize(wire);
    // Assert: alert/close を検証する
    expect(wire.length).toBe(2);
    expect(b.level).toBe(2);
    expect(b.description).toBe(AlertDesc.HandshakeFailure);
  });

  test("close_notify and certificate_required codes", () => {
    // Arrange: 前提を準備する
    expect(AlertDesc.CloseNotify).toBe(0);
    expect(AlertDesc.CertificateRequired).toBe(116);
    expect(AlertDesc.MissingExtension).toBe(109);
  });
});

describe("CertificateRequest signature_algorithms MUST", () => {
  test("CertificateRequest without signature_algorithms extension is detectable", () => {
    // Arrange: 前提を準備する
    const cr = new CertificateRequest13(Buffer.alloc(0), []);
    const wire = cr.serialize();
    const parsed = CertificateRequest13.deSerialize(wire);
    // Act: 証明書・署名を検証する
    const sigExt = parsed.extensions.find(
      (e) => e.type === SignatureAlgorithms.type,
    );
    // Assert: 証明書・署名を検証する
    expect(sigExt).toBeUndefined();
  });

  test("CertificateRequest.create always includes signature_algorithms", () => {
    // Arrange: 前提を準備する
    const cr = CertificateRequest13.create(Buffer.alloc(0));
    const sigExt = cr.extensions.find(
      (e) => e.type === SignatureAlgorithms.type,
    );
    // Assert: 証明書・署名を検証する
    expect(sigExt).toBeDefined();
    const schemes = SignatureAlgorithms.fromData(sigExt!.data).schemes;
    expect(schemes.length).toBeGreaterThan(0);
  });
});
