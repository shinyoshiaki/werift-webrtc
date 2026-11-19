import { RTCIceCandidate, RTCPeerConnection } from "../../src";
import {
  addIceCandidateNonBundleSdp,
  addIceCandidateSdpMid2,
  addIceCandidateUsernameFragment1,
  addIceCandidateUsernameFragment2,
  addIceCandidateWptSdp,
  mediaSectionsWithLine,
  pionCandidate,
  pionCandidateLine,
  remoteCandidatePortsByMLine,
  sharesIceTransport,
} from "./addIceCandidateUtils";

/**
 * An empty `sdpMid` with a numeric `sdpMLineIndex` (Pion's ToJSON shape) is
 * resolved by the index (normalizeEmptyCandidateMid); without an index it is
 * still an OperationError. The candidate must never land on another m-line or
 * another m-line's ICE transport.
 */
describe("addIceCandidate with an empty sdpMid", () => {
  let pc: RTCPeerConnection;

  beforeEach(() => {
    pc = new RTCPeerConnection();
  });

  afterEach(async () => {
    await pc.close();
  });

  const setRemote = (sdp: string) =>
    pc.setRemoteDescription({ type: "offer", sdp });

  const linesIn = (port: number) =>
    mediaSectionsWithLine(
      pc.remoteDescription!.sdp,
      `a=${pionCandidateLine(port)}`,
    );

  test("BUNDLE: sdpMLineIndex 0 targets m-line 0 and its ICE transport", async () => {
    await setRemote(addIceCandidateWptSdp);

    // Act: Pion 形 (sdpMid: "", sdpMLineIndex: 0) の candidate を追加する。
    await pc.addIceCandidate(pionCandidate(0, 30000));

    // Assert: m-line 0 にだけ記録され、m-line 0 の ICE transport に届く。
    expect(linesIn(30000)).toEqual([0]);
    expect(remoteCandidatePortsByMLine(pc)[0]).toContain(30000);
  });

  test("BUNDLE: sdpMLineIndex 1 targets m-line 1 only", async () => {
    await setRemote(addIceCandidateWptSdp);

    // Act: Pion 形 (sdpMid: "", sdpMLineIndex: 1) の candidate を追加する。
    await pc.addIceCandidate(pionCandidate(1, 30001));

    // Assert: m-line 1 にだけ記録され、m-line 0 には入らない。
    expect(linesIn(30001)).toEqual([1]);
  });

  test("BUNDLE: a usernameFragment of another m-line is rejected", async () => {
    await setRemote(addIceCandidateWptSdp);

    // Act / Assert: index 0 に m-line 1 の ufrag を付けると OperationError になる。
    await expect(
      pc.addIceCandidate(
        pionCandidate(0, 30002, {
          usernameFragment: addIceCandidateUsernameFragment2,
        }),
      ),
    ).rejects.toMatchObject({ name: "OperationError" });
    // Act / Assert: candidate 文字列の ufrag が不一致でも同様に OperationError になる。
    await expect(
      pc.addIceCandidate({
        ...pionCandidate(0, 30003),
        candidate: `${pionCandidateLine(30003)} ufrag ${addIceCandidateUsernameFragment2}`,
      }),
    ).rejects.toMatchObject({ name: "OperationError" });

    // Assert: どの m-line にも ICE transport にも記録されない。
    expect(linesIn(30002)).toEqual([]);
    expect(remoteCandidatePortsByMLine(pc).flat()).not.toContain(30002);
    expect(pc.remoteDescription!.sdp).not.toContain("30003 typ host");
  });

  test("BUNDLE: a matching usernameFragment is accepted", async () => {
    await setRemote(addIceCandidateWptSdp);

    // Act: index 0 と m-line 0 の ufrag を持つ candidate を追加する。
    await pc.addIceCandidate(
      pionCandidate(0, 30004, {
        usernameFragment: addIceCandidateUsernameFragment1,
      }),
    );

    // Assert: m-line 0 にだけ記録される。
    expect(linesIn(30004)).toEqual([0]);
  });

  test("an out-of-range sdpMLineIndex is rejected", async () => {
    await setRemote(addIceCandidateWptSdp);

    // Act / Assert: 範囲外の index は OperationError になる。
    await expect(
      pc.addIceCandidate(pionCandidate(5, 30005)),
    ).rejects.toMatchObject({
      name: "OperationError",
      message: "Media section for sdpMLineIndex was not found",
    });
  });

  test("an empty sdpMid without sdpMLineIndex is rejected", async () => {
    await setRemote(addIceCandidateWptSdp);

    // Act / Assert: index の無い candidate は原因の分かる OperationError になる。
    await expect(
      pc.addIceCandidate(pionCandidate(undefined, 30006)),
    ).rejects.toMatchObject({
      name: "OperationError",
      message: "sdpMid is empty and no sdpMLineIndex was given",
    });
    // Act / Assert: index の無い end-of-candidates も全 m-line へ広げず拒否する。
    await expect(
      pc.addIceCandidate({ candidate: "", sdpMid: "" }),
    ).rejects.toMatchObject({
      name: "OperationError",
      message: "sdpMid is empty and no sdpMLineIndex was given",
    });

    // Assert: candidate も end-of-candidates もどこにも記録されない。
    expect(linesIn(30006)).toEqual([]);
    expect(pc.remoteDescription!.sdp).not.toContain("a=end-of-candidates");
  });

  test("an empty sdpMid with an index ends only that m-line's candidates", async () => {
    await setRemote(addIceCandidateWptSdp);

    // Act: index 1 の end-of-candidates を Pion 形で追加する。
    await pc.addIceCandidate({ candidate: "", sdpMid: "", sdpMLineIndex: 1 });

    // Assert: a=end-of-candidates は m-line 1 にだけ現れる。
    expect(
      mediaSectionsWithLine(pc.remoteDescription!.sdp, "a=end-of-candidates"),
    ).toEqual([1]);
  });

  test("an RTCIceCandidate instance is routed the same way and left unchanged", async () => {
    await setRemote(addIceCandidateWptSdp);
    const candidate = new RTCIceCandidate(pionCandidate(0, 30007));

    // Act: sdpMid: "" を持つ RTCIceCandidate インスタンスを追加する。
    await pc.addIceCandidate(candidate);

    // Assert: m-line 0 にだけ記録され、呼び出し元のインスタンスは変更されない。
    expect(linesIn(30007)).toEqual([0]);
    expect(remoteCandidatePortsByMLine(pc)[0]).toContain(30007);
    expect(candidate.sdpMid).toBe("");
    expect(candidate.sdpMLineIndex).toBe(0);
  });

  test("a candidate queued before the remote description reaches its m-line", async () => {
    // Act: remote description より前に Pion 形 candidate を追加し、その後 SRD する。
    await expect(
      pc.addIceCandidate(pionCandidate(0, 30008)),
    ).resolves.toBeUndefined();
    await setRemote(addIceCandidateWptSdp);

    // Assert: SRD は reject されず、キューの candidate は m-line 0 にだけ入る。
    expect(linesIn(30008)).toEqual([0]);
    expect(remoteCandidatePortsByMLine(pc)[0]).toContain(30008);
  });

  test("non-BUNDLE: sdpMLineIndex 1 reaches only m-line 1's transport", async () => {
    await setRemote(addIceCandidateNonBundleSdp);
    // Arrange の確認: BUNDLE が無いので m-line ごとに別の ICE transport を持つ。
    expect(sharesIceTransport(pc)).toBe(false);

    // Act: Pion 形 (sdpMid: "", sdpMLineIndex: 1) の candidate を追加する。
    await pc.addIceCandidate(pionCandidate(1, 30009));

    // Assert: m-line 1 とその transport にだけ届き、m-line 0 の transport には届かない。
    expect(linesIn(30009)).toEqual([1]);
    const [audioPorts, videoPorts] = remoteCandidatePortsByMLine(pc);
    expect(videoPorts).toContain(30009);
    expect(audioPorts).not.toContain(30009);
  });

  test("non-BUNDLE: sdpMLineIndex 0 reaches only m-line 0's transport", async () => {
    await setRemote(addIceCandidateNonBundleSdp);

    // Act: Pion 形 (sdpMid: "", sdpMLineIndex: 0) の candidate を追加する。
    await pc.addIceCandidate(pionCandidate(0, 30010));

    // Assert: m-line 0 とその transport にだけ届く。
    expect(linesIn(30010)).toEqual([0]);
    const [audioPorts, videoPorts] = remoteCandidatePortsByMLine(pc);
    expect(audioPorts).toContain(30010);
    expect(videoPorts).not.toContain(30010);
  });

  test("a non-empty sdpMid still wins over a wrong sdpMLineIndex", async () => {
    await setRemote(addIceCandidateWptSdp);

    // Act: sdpMid "v1" と誤った index 0 を持つ candidate を追加する。
    await pc.addIceCandidate({
      candidate: pionCandidateLine(30011),
      sdpMid: addIceCandidateSdpMid2,
      sdpMLineIndex: 0,
    });

    // Assert: MID が優先され、m-line 1 にだけ記録される。
    expect(linesIn(30011)).toEqual([1]);
  });

  test("ICE restart: an old-ufrag candidate reaches the current generation, a new-ufrag one the pending one", async () => {
    // Arrange: 通常の交渉を完了して current を作り、新しい ufrag の再 offer を pending にする。
    const restartedSdp = addIceCandidateWptSdp
      .replace(addIceCandidateUsernameFragment1, "NEW1")
      .replace(addIceCandidateUsernameFragment2, "NEW2");
    await setRemote(addIceCandidateWptSdp);
    await pc.setLocalDescription(await pc.createAnswer());
    await setRemote(restartedSdp);
    expect(pc.pendingRemoteDescription).not.toBeNull();
    expect(pc.currentRemoteDescription).not.toBeNull();
    const sectionsOf = (sdp: string | undefined, port: number) =>
      mediaSectionsWithLine(sdp ?? "", `a=${pionCandidateLine(port)}`);

    // Act: 旧 ufrag の空 sdpMid + index candidate と、新 ufrag のものを追加する。
    await pc.addIceCandidate(
      pionCandidate(0, 30012, {
        usernameFragment: addIceCandidateUsernameFragment1,
      }),
    );
    await pc.addIceCandidate(
      pionCandidate(0, 30013, { usernameFragment: "NEW1" }),
    );

    // Assert: 旧 ufrag は current の m-line 0 のみ、新 ufrag は pending の m-line 0 のみに入る。
    const current = pc.currentRemoteDescription?.sdp;
    const pending = pc.pendingRemoteDescription?.sdp;
    expect(sectionsOf(current, 30012)).toEqual([0]);
    expect(sectionsOf(pending, 30012)).toEqual([]);
    expect(sectionsOf(pending, 30013)).toEqual([0]);
    expect(sectionsOf(current, 30013)).toEqual([]);
  });
});
