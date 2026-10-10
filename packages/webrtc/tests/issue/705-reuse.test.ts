import {
  answerRemoteOffer,
  buildRemoteSdp,
  bundleGroups,
  closeAll,
  countNegotiationNeeded,
  createNegotiatedPair,
  createPeer,
  createRemoteStoppedVideoReservation,
  createSendonlyVideoPair,
  createTrack,
  expectRtpDelivered,
  flushEvents,
  mLines,
  negotiate,
  routedSsrcs,
  startAutoNegotiation,
  transceiverByMid,
} from "./705.helpers";

describe("issue 705: transceiver.stop()", () => {
  test("stop() is idempotent, releases the pipeline and requests negotiation once", async () => {
    // Arrange
    const { caller, callee, video } = await createNegotiatedPair();
    await flushEvents();
    const negotiationNeeded = countNegotiationNeeded(caller);
    const senderSsrc = video.sender.ssrc;

    try {
      // Act: 2 回 stop する
      video.stop();
      video.stop();
      await flushEvents();

      // Assert: stopping だが交渉前なので stopped ではない。送受信と router 登録は解除済み
      expect(video.stopping).toBe(true);
      expect(video.stopped).toBe(false);
      expect(video.sender.stopped).toBe(true);
      expect(video.receiver.stopped).toBe(true);
      expect(routedSsrcs(caller)).not.toContain(senderSsrc);
      expect(negotiationNeeded.count).toBe(1);

      // Act: 次の offer / answer で停止を交渉する
      const { offer, answer } = await negotiate(caller, callee);

      // Assert: 自分の offer で port 0 になり、answer 適用後に stopped が確定する
      expect(mLines(offer).map((m) => m.port)).toEqual([9, 0]);
      expect(mLines(answer).map((m) => m.port)).toEqual([9, 0]);
      expect(video.stopped).toBe(true);
      expect(video.currentDirection).toBe("stopped");
      expect(video.rejected).toBe(false);
      expect(transceiverByMid(callee, video.mid!)!.stopped).toBe(true);
      // Assert: 停止 m-line は BUNDLE group に含めない
      expect(bundleGroups(offer)).toEqual([[caller.getTransceivers()[0].mid]]);
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("stopping an unassociated transceiver does not create a stopped m-line", async () => {
    // Arrange
    const pc = createPeer();
    const audio = pc.addTransceiver("audio");
    const video = pc.addTransceiver("video");

    try {
      // Act: 未交渉のまま stop して offer を作る
      video.stop();
      const offer = await pc.createOffer();

      // Assert: 停止を即確定し、m-line を作らない
      expect(video.stopped).toBe(true);
      expect(mLines(offer.sdp).map((m) => m.kind)).toEqual(["audio"]);
      expect(audio.mid).not.toBeNull();
      expect(video.mid).toBeNull();
    } finally {
      await closeAll(pc);
    }
  });

  test("the answerer's stop() is negotiated by its own next offer", async () => {
    // Arrange
    const { caller, callee, video } = await createNegotiatedPair();
    await flushEvents();
    const calleeVideo = transceiverByMid(callee, video.mid!)!;
    const negotiationNeeded = countNegotiationNeeded(callee);

    try {
      // Act: answerer 側で stop した直後に、相手からの re-offer に答える
      calleeVideo.stop();
      const { answer } = await negotiate(caller, callee);
      await flushEvents();

      // Assert: compatible の answer は port 0 を強制せず inactive、停止は未確定
      expect(mLines(answer)[1].port).toBe(9);
      expect(calleeVideo.stopping).toBe(true);
      expect(calleeVideo.stopped).toBe(false);
      expect(video.stopped).toBe(false);
      // Assert: 停止を交渉するため negotiationneeded が出る
      expect(negotiationNeeded.count).toBeGreaterThan(0);

      // Act: answerer が自分の offer で停止を交渉する
      const { offer } = await negotiate(callee, caller);

      // Assert: その offer で port 0 になり、両者で停止が確定する
      expect(mLines(offer)[1].port).toBe(0);
      expect(calleeVideo.stopped).toBe(true);
      expect(video.stopped).toBe(true);
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("aggressive: the answerer's stop() is rejected by its inactive port 0 answer", async () => {
    // Arrange
    const { caller, callee, video } = await createNegotiatedPair({
      mLineReuse: "aggressive",
    });
    const calleeVideo = transceiverByMid(callee, video.mid!)!;

    try {
      // Act: answerer 側で stop した直後に re-offer に答える
      calleeVideo.stop();
      const { answer } = await negotiate(caller, callee);

      // Assert: aggressive の inactive は port 0 なので、その answer で両者の停止が確定する
      expect(mLines(answer)[1].port).toBe(0);
      expect(calleeVideo.stopped).toBe(true);
      expect(video.stopped).toBe(true);
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("a stop after createOffer-only MID assignment settles without looping negotiationneeded", async () => {
    // Arrange: audio を交渉済み、video は createOffer で MID だけ割り当てて適用しない
    const caller = createPeer();
    const callee = createPeer();
    caller.addTransceiver("audio");
    await negotiate(caller, callee);
    const video = caller.addTransceiver("video");
    await caller.createOffer();
    await flushEvents();
    const negotiationNeeded = countNegotiationNeeded(caller);

    try {
      // Act: 未適用の MID を持つ video を stop し、次の交渉を完了する
      video.stop();
      const { offer } = await negotiate(caller, callee);
      await flushEvents();

      // Assert: offer に含まれない stopping は answer 確定時に stopped となる
      expect(mLines(offer).map((m) => m.kind)).toEqual(["audio"]);
      expect(video.stopped).toBe(true);

      // Act: 保留されていた要求に応じてもう一度交渉する
      const afterFirst = negotiationNeeded.count;
      await negotiate(caller, callee);
      await flushEvents();

      // Assert: 停止済みの video のために negotiationneeded を繰り返さない
      expect(negotiationNeeded.count).toBe(afterFirst);
    } finally {
      await closeAll(caller, callee);
    }
  });
});

describe("issue 705: m-line reuse after a confirmed stop", () => {
  test.each(["compatible", "aggressive"] as const)(
    "%s: removeTrack + stop, negotiate, then addTransceiver reuses the index with a new MID",
    async (mode) => {
      // Arrange
      const { caller, callee, video } = await createNegotiatedPair({
        mLineReuse: mode,
      });
      const oldMid = video.mid;
      const oldCalleeVideo = transceiverByMid(callee, oldMid!)!;

      try {
        // Act: 同じ交渉前に removeTrack と stop を行い、port 0 の交渉を完了する
        caller.removeTrack(video.sender);
        video.stop();
        await negotiate(caller, callee);
        const newVideo = caller.addTransceiver(createTrack("video"));
        const { offer } = await negotiate(caller, callee);

        // Assert: m-line は 2 本のまま、index 1 に新 MID / 新 transceiver が入る
        const lines = mLines(offer);
        expect(lines).toHaveLength(2);
        expect(lines[1].port).toBe(9);
        expect(lines[1].mid).toBe(newVideo.mid);
        expect(newVideo.mid).not.toBe(oldMid);
        expect(newVideo.mLineIndex).toBe(1);
        expect(newVideo).not.toBe(video);
        // Assert: 旧 transceiver は MID / index を外され、復活しない
        expect(video.mid).toBeNull();
        expect(video.mLineIndex).toBeUndefined();
        expect(video.stopped).toBe(true);
        expect(caller.getTransceivers()).not.toContain(video);
        // Assert: remote 側も同じ位置に新しい transceiver / receiver を作る
        const calleeVideo = transceiverByMid(callee, newVideo.mid!)!;
        expect(calleeVideo).not.toBe(oldCalleeVideo);
        expect(calleeVideo.receiver).not.toBe(oldCalleeVideo.receiver);
        expect(calleeVideo.mLineIndex).toBe(1);
        expect(callee.getTransceivers()).toHaveLength(2);
      } finally {
        await closeAll(caller, callee);
      }
    },
  );

  test("removeTrack, negotiate, stop, negotiate, then add reuses the index", async () => {
    // Arrange
    const { caller, callee, video } = await createNegotiatedPair();

    try {
      // Act: removeTrack と stop を別々の交渉で行う
      caller.removeTrack(video.sender);
      const first = await negotiate(caller, callee);
      video.stop();
      await negotiate(caller, callee);
      const newVideo = caller.addTransceiver("video");
      const { offer } = await negotiate(caller, callee);

      // Assert: removeTrack 後は recvonly で残り、停止確定後に同じ index を再利用する
      expect(mLines(first.offer)[1].port).toBe(9);
      expect(mLines(offer)).toHaveLength(2);
      expect(newVideo.mLineIndex).toBe(1);
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("a transceiver added before the stop is negotiated does not take the stopping index", async () => {
    // Arrange
    const { caller, callee, video } = await createNegotiatedPair();

    try {
      // Act: stop の交渉前に新しい video を追加する
      video.stop();
      const newVideo = caller.addTransceiver("video");
      const { offer } = await negotiate(caller, callee);

      // Assert: 停止予定の位置は port 0 のまま、新 transceiver は末尾に追加される
      expect(mLines(offer).map((m) => m.port)).toEqual([9, 0, 9]);
      expect(newVideo.mLineIndex).toBe(2);
      expect(caller.getTransceivers()).toContain(video);
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("an unassociated answerer transceiver takes over the reused index and survives the answerer's re-offer", async () => {
    // Arrange: callee は停止確定前に同じ kind の未関連付け transceiver を持つ
    const { caller, callee, video } = await createNegotiatedPair();
    const oldCalleeVideo = transceiverByMid(callee, video.mid!)!;
    const pendingCalleeVideo = callee.addTransceiver(createTrack("video"));

    try {
      // Act: caller が stop を交渉し、同じ位置を新 MID で再利用する
      video.stop();
      await negotiate(caller, callee);
      const newVideo = caller.addTransceiver(createTrack("video"));
      await negotiate(caller, callee);

      // Assert: callee の未関連付け transceiver が index 1 / 新 MID を引き継ぎ、MID は重複しない
      expect(pendingCalleeVideo.mid).toBe(newVideo.mid);
      expect(pendingCalleeVideo.mLineIndex).toBe(1);
      expect(pendingCalleeVideo.currentDirection).toBe("sendrecv");
      const calleeMids = callee.getTransceivers().map((t) => t.mid);
      expect(new Set(calleeMids).size).toBe(calleeMids.length);
      // Assert: 旧 stopped transceiver は m-line から外れ、一覧からも置き換えられる
      expect(oldCalleeVideo.mid).toBeNull();
      expect(oldCalleeVideo.mLineIndex).toBeUndefined();
      expect(callee.getTransceivers()).not.toContain(oldCalleeVideo);

      // Act: callee 側から re-offer する
      const { offer } = await negotiate(callee, caller);

      // Assert: 再利用した m-line は port 0 にならず、caller 側の新 transceiver も生きている
      const lines = mLines(offer);
      expect(lines).toHaveLength(2);
      expect(lines[1].port).toBe(9);
      expect(lines[1].mid).toBe(newVideo.mid);
      expect(newVideo.stopped).toBe(false);
      expect(newVideo.currentDirection).toBe("sendrecv");
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("rolling back the reuse offer restores the stopped transceiver and leaves the answerer transceiver unassociated", async () => {
    // Arrange: callee は停止確定前に同じ kind の未関連付け transceiver を持つ
    const { caller, callee, video } = await createNegotiatedPair();
    const oldMid = video.mid!;
    const oldCalleeVideo = transceiverByMid(callee, oldMid)!;
    const pendingCalleeVideo = callee.addTransceiver(createTrack("video"));
    video.stop();
    await negotiate(caller, callee);
    const calleeTransceiversBefore = [...callee.getTransceivers()];

    try {
      // Act: 再利用 offer を callee に適用してから rollback する
      caller.addTransceiver(createTrack("video"));
      await caller.setLocalDescription(await caller.createOffer());
      await callee.setRemoteDescription(caller.localDescription!);
      await callee.setRemoteDescription({ type: "rollback" });

      // Assert: 旧 stopped transceiver が元の位置に戻り、未関連付け transceiver は未関連付けに戻る
      expect(callee.getTransceivers()).toEqual(calleeTransceiversBefore);
      expect(oldCalleeVideo.mLineIndex).toBe(1);
      expect(oldCalleeVideo.mid).toBe(oldMid);
      expect(pendingCalleeVideo.mid).toBeNull();
      expect(pendingCalleeVideo.mLineIndex).toBeUndefined();
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("a remote offer that reuses a locally reserved index with another kind releases the reservation", async () => {
    // Arrange: remote の停止確定後、werift が自分の offer 前に video で index 1 を予約している
    const { pc, reservedVideo } = await createRemoteStoppedVideoReservation();

    try {
      // Assert (前提): 予約は index 1 を指し、MID は未割り当て
      expect(reservedVideo.mLineIndex).toBe(1);
      expect(reservedVideo.mid).toBeNull();

      // Act: remote が index 1 を audio の新 MID で再利用した offer を送り、answer を確定する
      await answerRemoteOffer(
        pc,
        buildRemoteSdp({
          sections: [
            { kind: "audio", mid: "0" },
            { kind: "audio", mid: "2" },
          ],
          bundle: ["0", "2"],
        }),
      );

      // Assert: 予約した video は MID を奪わず予約も解除され、MID は一意
      const audio2 = pc.getTransceivers().find((t) => t.mid === "2")!;
      expect(audio2.kind).toBe("audio");
      expect(audio2.mLineIndex).toBe(1);
      expect(reservedVideo.mid).toBeNull();
      expect(reservedVideo.mLineIndex).toBeUndefined();
      const mids = pc
        .getTransceivers()
        .map((t) => t.mid)
        .filter((mid) => mid != null);
      expect(new Set(mids).size).toBe(mids.length);

      // Act: werift から次の offer を作る
      const offer = await pc.createOffer();

      // Assert: 交渉済み audio の m-line は残り、予約していた video は新しい MID で末尾に追加される
      const lines = mLines(offer.sdp);
      expect(lines.map((m) => [m.kind, m.mid])).toEqual([
        ["audio", "0"],
        ["audio", "2"],
        ["video", reservedVideo.mid],
      ]);
      expect(reservedVideo.mLineIndex).toBe(2);
    } finally {
      await closeAll(pc);
    }
  });

  test("aggressive answerer: an inactive m-line answered with port 0 is stopped on both sides and its index is reused", async () => {
    // Arrange: caller が sendonly video を 3 本送り、callee は aggressive の answerer
    const { caller, callee, videos } = await createSendonlyVideoPair({
      calleeMLineReuse: "aggressive",
      count: 3,
    });
    const second = videos[1];
    const calleeSecond = transceiverByMid(callee, second.mid!)!;

    try {
      // Act: 2 本目を removeTrack して交渉する
      caller.removeTrack(second.sender);
      const { answer } = await negotiate(caller, callee);

      // Assert: callee は inactive を port 0 で答え、自分の transceiver も停止を確定する
      expect(mLines(answer)[1].port).toBe(0);
      expect(second.stopped).toBe(true);
      expect(calleeSecond.stopped).toBe(true);

      // Act: caller が video を追加して交渉する
      const track = createTrack("video");
      const replaced = caller.addTransceiver(track, { direction: "sendonly" });
      await negotiate(caller, callee);

      // Assert: 同じ index 1 を新 MID で再利用し、callee の index 1 は新しい transceiver 1 つだけ
      expect(replaced.mLineIndex).toBe(1);
      const atIndex1 = callee
        .getTransceivers()
        .filter((t) => t.mLineIndex === 1);
      expect(atIndex1).toHaveLength(1);
      expect(atIndex1[0].mid).toBe(replaced.mid);
      // Assert: 再利用した位置で RTP を受信できる
      await expectRtpDelivered({
        track,
        receiverTransceiver: atIndex1[0],
        payload: "replaced",
      });
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("stopping the BUNDLE tag moves the tag and keeps the shared transport", async () => {
    // Arrange: 接続済みで audio(0) が tag
    const { caller, callee, audio, video, videoTrack } =
      await createNegotiatedPair({ connect: true });
    const sharedTransport = video.dtlsTransport;

    try {
      // Act: tag の audio を stop して交渉する
      audio.stop();
      const { offer, answer } = await negotiate(caller, callee);

      // Assert: tag は live な video に移り、共有 transport は閉じない
      expect(bundleGroups(offer)).toEqual([[video.mid]]);
      expect(bundleGroups(answer)).toEqual([[video.mid]]);
      expect(audio.stopped).toBe(true);
      expect(sharedTransport.state).toBe("connected");
      await expectRtpDelivered({
        track: videoTrack,
        receiverTransceiver: transceiverByMid(callee, video.mid!)!,
        payload: "after-tag-stop",
      });

      // Act: 先頭位置を新しい audio で再利用する
      const newAudio = caller.addTransceiver(createTrack("audio"));
      const reuse = await negotiate(caller, callee);

      // Assert: index 0 に新 MID が入り、group にも戻る
      expect(newAudio.mLineIndex).toBe(0);
      expect(mLines(reuse.offer)[0].mid).toBe(newAudio.mid);
      expect(bundleGroups(reuse.answer)[0]).toContain(newAudio.mid);
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("unbundled: the stopped m-line closes only its own transport", async () => {
    // Arrange: bundlePolicy disable で接続済み
    const { caller, callee, audio, video } = await createNegotiatedPair({
      bundlePolicy: "disable",
      connect: true,
    });
    const videoTransport = video.dtlsTransport;
    const audioTransport = audio.dtlsTransport;

    try {
      // Act
      video.stop();
      await negotiate(caller, callee);

      // Assert: video の独立 transport だけ閉じ、audio は維持する
      expect(videoTransport).not.toBe(audioTransport);
      expect(videoTransport.state).toBe("closed");
      expect(audioTransport.state).toBe("connected");
      expect(caller.dtlsTransports).not.toContain(videoTransport);

      // Act: 同じ位置を再利用する
      const newVideo = caller.addTransceiver("video");
      const { offer } = await negotiate(caller, callee);

      // Assert: 再利用位置は新しい transport を持つ
      expect(mLines(offer)).toHaveLength(2);
      expect(newVideo.mLineIndex).toBe(1);
      expect(newVideo.dtlsTransport).not.toBe(videoTransport);
      expect(newVideo.dtlsTransport.state).not.toBe("closed");
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("SCTP before RTP: stop and reuse keep the original indexes", async () => {
    // Arrange: SCTP(0) → audio(1) → video(2)
    const { caller, callee, video } = await createNegotiatedPair({
      dataChannelFirst: true,
    });

    try {
      // Act
      video.stop();
      const stop = await negotiate(caller, callee);
      const newVideo = caller.addTransceiver("video");
      const reuse = await negotiate(caller, callee);

      // Assert: SCTP 先行でも停止・再利用は元の index を保つ
      expect(mLines(stop.offer).map((m) => [m.kind, m.port])).toEqual([
        ["application", 9],
        ["audio", 9],
        ["video", 0],
      ]);
      expect(mLines(reuse.offer).map((m) => [m.kind, m.mid])).toEqual([
        ["application", caller.sctpTransport!.mid],
        ["audio", caller.getTransceivers()[0].mid],
        ["video", newVideo.mid],
      ]);
      expect(newVideo.mLineIndex).toBe(2);
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("removeTrack keeps the sender resumable", async () => {
    // Arrange
    const { caller, callee, audio } = await createNegotiatedPair({
      connect: true,
    });

    try {
      // Act: removeTrack → 交渉 → 同じ sender に track を戻して sendrecv で再交渉
      caller.removeTrack(audio.sender);
      await negotiate(caller, callee);
      const resumed = createTrack("audio");
      await audio.sender.replaceTrack(resumed);
      audio.setDirection("sendrecv");
      await negotiate(caller, callee);

      // Assert: sender は停止しておらず、同じ sender から RTP が届く
      expect(audio.sender.stopped).toBe(false);
      await expectRtpDelivered({
        track: resumed,
        receiverTransceiver: transceiverByMid(callee, audio.mid!)!,
        payload: "resumed",
      });
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("removeTrack fires negotiationneeded once, and not again for a sender without a track", async () => {
    // Arrange
    const { caller, callee, video } = await createNegotiatedPair();
    await flushEvents();
    const negotiationNeeded = countNegotiationNeeded(caller);

    try {
      // Act: 交渉済み sendrecv の sender で removeTrack する
      caller.removeTrack(video.sender);
      await flushEvents();

      // Assert: negotiationneeded は 1 回だけ
      expect(negotiationNeeded.count).toBe(1);

      // Act: 交渉して、track のない sender で再度 removeTrack する
      await negotiate(caller, callee);
      caller.removeTrack(video.sender);
      await flushEvents();

      // Assert: 変更がないので追加の negotiationneeded は発火しない
      expect(negotiationNeeded.count).toBe(1);
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("onnegotiationneeded-driven signaling handles removeTrack with a single offer", async () => {
    // Arrange: onnegotiationneeded で offer を送る一般的な実装
    const { caller, callee, video } = await createNegotiatedPair();
    await flushEvents();
    const auto = startAutoNegotiation(caller, callee);

    try {
      // Act: removeTrack して、自動交渉が落ち着くまで待つ
      caller.removeTrack(video.sender);
      await auto.settle();

      // Assert: offer は 1 回だけで signaling エラーは起きず、送信停止が交渉済みになる
      // (callee は recvonly なので確定方向は inactive)
      expect(auto.result.errors).toEqual([]);
      expect(auto.result.offers).toBe(1);
      expect(caller.signalingState).toBe("stable");
      expect(video.direction).toBe("recvonly");
      expect(video.currentDirection).toBe("inactive");
    } finally {
      await closeAll(caller, callee);
    }
  });

  test("changes in the same tick fire a single negotiationneeded", async () => {
    // Arrange
    const pc = createPeer();
    const negotiationNeeded = countNegotiationNeeded(pc);

    try {
      // Act: 同じ tick で 2 つの transceiver を追加する
      pc.addTransceiver("audio");
      pc.addTransceiver("video");
      await flushEvents();

      // Assert: negotiationneeded はまとめて 1 回
      expect(negotiationNeeded.count).toBe(1);
    } finally {
      await closeAll(pc);
    }
  });

  test.each(["compatible", "aggressive"] as const)(
    "%s: RTP is received after repeated reuse of the same index",
    async (mode) => {
      // Arrange: 接続済みペア
      const { caller, callee, video } = await createNegotiatedPair({
        mLineReuse: mode,
        connect: true,
      });

      try {
        let current = video;
        for (let round = 0; round < 3; round++) {
          // Act: 現在の video を止めて交渉し、新しい video で同じ位置を再利用する
          caller.removeTrack(current.sender);
          current.stop();
          await negotiate(caller, callee);
          const track = createTrack("video");
          const next = caller.addTransceiver(track);
          const { offer } = await negotiate(caller, callee);

          // Assert: m-line 数は増えず、新しい受信側で実 RTP を受け取れる
          expect(mLines(offer)).toHaveLength(2);
          expect(next.mLineIndex).toBe(1);
          await expectRtpDelivered({
            track,
            receiverTransceiver: transceiverByMid(callee, next.mid!)!,
            payload: `round-${round}`,
          });
          current = next;
        }
        // Assert: 旧 transceiver は残らず、getTransceivers は 2 本のまま
        expect(caller.getTransceivers()).toHaveLength(2);
        expect(callee.getTransceivers()).toHaveLength(2);
      } finally {
        await closeAll(caller, callee);
      }
    },
  );
});
