import {
  createSelfSignedCertificate,
  RTCCertificate,
  RTCPeerConnection,
} from "../../src";
import { HashAlgorithm, SignatureAlgorithm } from "../../src/imports/dtls";
import { createTestCertificate, getSdpFingerprints } from "../fixture";

describe("DTLS certificate scope", () => {
  const pcs: RTCPeerConnection[] = [];
  const createPc = (
    ...args: ConstructorParameters<typeof RTCPeerConnection>
  ) => {
    const pc = new RTCPeerConnection(...args);
    pcs.push(pc);
    return pc;
  };

  afterEach(async () => {
    await Promise.all(pcs.splice(0).map((pc) => pc.close()));
  });

  test("既定(certificateScope 未指定)では PC 間で同じ証明書を共有する", async () => {
    // Arrange
    const a = createPc();
    const b = createPc();
    a.createDataChannel("a");
    b.createDataChannel("b");

    // Act
    const [offerA, offerB] = await Promise.all([
      a.createOffer(),
      b.createOffer(),
    ]);

    // Assert: 従来どおり fingerprint が一致し、既定値は "process"
    const fingerprintsA = getSdpFingerprints(offerA.sdp);
    expect(fingerprintsA.length).toBe(1);
    expect(getSdpFingerprints(offerB.sdp)).toEqual(fingerprintsA);
    expect(a.getConfiguration().certificateScope).toBe("process");
  });

  test("certificateScope が不正な値なら TypeError", () => {
    // Act / Assert: 構築時に検証される
    expect(
      () => new RTCPeerConnection({ certificateScope: "x" as any }),
    ).toThrow(/certificateScope/);
  });

  test("certificateScope は構築後に変更できない", () => {
    // Arrange
    const pc = createPc({ certificateScope: "peerConnection" });

    // Act / Assert: setConfiguration での変更は拒否される
    expect(() => pc.setConfiguration({ certificateScope: "process" })).toThrow(
      /certificateScope cannot be changed/,
    );
  });

  test("certificateScope: peerConnection では PC ごとに別の証明書を生成する", async () => {
    // Arrange
    const a = createPc({ certificateScope: "peerConnection" });
    const b = createPc({ certificateScope: "peerConnection" });
    a.createDataChannel("a");
    b.createDataChannel("b");

    // Act: 各 PC で証明書が生成される createOffer を呼ぶ
    const [offerA, offerB] = await Promise.all([
      a.createOffer(),
      b.createOffer(),
    ]);

    // Assert: 広告される fingerprint が PC 間で異なる
    const [fingerprintA] = getSdpFingerprints(offerA.sdp);
    const [fingerprintB] = getSdpFingerprints(offerB.sdp);
    expect(fingerprintA).toBeDefined();
    expect(fingerprintB).toBeDefined();
    expect(fingerprintA).not.toBe(fingerprintB);
    expect(a.getConfiguration().certificates).toEqual([]);
  });

  test("certificateScope: peerConnection でも同一 PC 内の全 DTLS transport は同じ証明書を使う", async () => {
    // Arrange: max-compat で m-line ごとに transport を作る
    const pc = createPc({
      bundlePolicy: "max-compat",
      certificateScope: "peerConnection",
    });
    pc.addTransceiver("audio");
    pc.addTransceiver("video");
    pc.createDataChannel("dc");

    // Act
    const offer = await pc.createOffer();

    // Assert: transport は複数あり、全て同一の証明書インスタンスを持つ
    const transports = pc.dtlsTransports;
    expect(transports.length).toBe(3);
    const [first] = transports;
    expect(first.localCertificate).toBeDefined();
    for (const transport of transports) {
      expect(transport.localCertificate).toBe(first.localCertificate);
    }
    // Assert: SDP 内の全 m-line の fingerprint が一致する
    const fingerprints = getSdpFingerprints(offer.sdp);
    expect(fingerprints.length).toBe(3);
    expect(new Set(fingerprints).size).toBe(1);
  });

  test("certificateScope: peerConnection で並行した createOffer / createAnswer でも証明書は 1 PC に 1 つ", async () => {
    // Arrange
    const caller = createPc({ certificateScope: "peerConnection" });
    caller.createDataChannel("dc");
    const callee = createPc({ certificateScope: "peerConnection" });
    await callee.setRemoteDescription(await caller.createOffer());

    // Act: 証明書生成前の PC で createOffer / createAnswer を同時に呼ぶ
    const [offer, answer] = await Promise.all([
      callee.createOffer(),
      callee.createAnswer(),
    ]);

    // Assert: どちらも同じ fingerprint を広告し、生成後は変わらない
    const fingerprints = [
      ...getSdpFingerprints(offer.sdp),
      ...getSdpFingerprints(answer.sdp),
    ];
    expect(new Set(fingerprints).size).toBe(1);
    const again = await callee.createAnswer();
    expect(getSdpFingerprints(again.sdp)).toEqual([fingerprints[0]]);
  });

  test("同じ RTCCertificate を渡した PC 同士は同じ fingerprint になる", async () => {
    // Arrange
    const source = await createTestCertificate();
    const cert = new RTCCertificate(
      source.privateKey,
      source.certPem,
      source.signatureHash,
    );
    const a = createPc({ certificates: [cert] });
    const b = createPc({ certificates: [cert] });
    a.createDataChannel("a");
    b.createDataChannel("b");

    // Act
    const [offerA, offerB] = await Promise.all([
      a.createOffer(),
      b.createOffer(),
    ]);

    // Assert: 明示した証明書の fingerprint が両 PC で一致する
    const expected = cert.getFingerprints()[0];
    const fingerprint = `${expected.algorithm} ${expected.value}`;
    expect(getSdpFingerprints(offerA.sdp)).toEqual([fingerprint]);
    expect(getSdpFingerprints(offerB.sdp)).toEqual([fingerprint]);
  });

  test("同じ dtls.keys を渡した PC 同士は同じ fingerprint になる", async () => {
    // Arrange
    const keys = await createSelfSignedCertificate({
      signature: SignatureAlgorithm.ecdsa_3,
      hash: HashAlgorithm.sha256_4,
    });
    const a = createPc({ dtls: { keys } });
    const b = createPc({ dtls: { keys } });
    a.createDataChannel("a");
    b.createDataChannel("b");

    // Act
    const [offerA, offerB] = await Promise.all([
      a.createOffer(),
      b.createOffer(),
    ]);

    // Assert
    const fingerprintsA = getSdpFingerprints(offerA.sdp);
    expect(fingerprintsA.length).toBe(1);
    expect(getSdpFingerprints(offerB.sdp)).toEqual(fingerprintsA);
  });

  test("certificateScope: peerConnection で別々の自動生成証明書を持つ PC 同士で DataChannel が通信できる", async () => {
    // Arrange
    const caller = createPc({ certificateScope: "peerConnection" });
    const callee = createPc({ certificateScope: "peerConnection" });
    const received = new Promise<string>((resolve) => {
      callee.onDataChannel.subscribe((channel) => {
        channel.onMessage.once((data) => resolve(data.toString()));
      });
    });
    const channel = caller.createDataChannel("dc");
    channel.onopen = () => channel.send("hello");

    // Act: offer / answer を交換して接続する
    await caller.setLocalDescription(await caller.createOffer());
    await callee.setRemoteDescription(caller.localDescription!);
    await callee.setLocalDescription(await callee.createAnswer());
    await caller.setRemoteDescription(callee.localDescription!);

    // Assert: fingerprint が異なっていても DTLS が確立しメッセージが届く
    expect(getSdpFingerprints(caller.localDescription!.sdp)).not.toEqual(
      getSdpFingerprints(callee.localDescription!.sdp),
    );
    await expect(received).resolves.toBe("hello");
  });
});
