import { RTCCertificate } from "../../../../src/rtc/transport/dtls";

describe("RTCCertificateTest", () => {
  test("test_generate", () => {
    const certificate = RTCCertificate.generateCertificate();
    expect(certificate).not.toBeUndefined();

    const expires = certificate.expires;
    expect(expires).not.toBeUndefined();

    const fingerprints = certificate.getFingerprints();
    expect(fingerprints.length).toBe(1);
    expect(fingerprints[0].algorithm).toBe("sha-256");
    expect(fingerprints[0].value).toBeTruthy();
  });
});
