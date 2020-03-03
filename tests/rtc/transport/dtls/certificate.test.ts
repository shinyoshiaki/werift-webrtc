import { RTCCertificate } from "../../../../src/rtc/transport/dtls";

describe("RTCCertificateTest", () => {
  test("test_generate", () => {
    const cert = RTCCertificate.generateCertificate();
    expect(cert).not.toBeUndefined();

    const expires = cert.expires;
    expect(expires).not.toBeUndefined();
    // todo
    // self.assertTrue(isinstance(expires, datetime.datetime))

    const fingerprints = cert.expires;
  });
});
