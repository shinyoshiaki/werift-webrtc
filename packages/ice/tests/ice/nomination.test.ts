import { setTimeout } from "timers/promises";

import { describe, expect, test, vi } from "vitest";

import { CandidatePairState } from "../../src";
import {
  addUdpRemoteCandidate,
  createIncomingCheck,
  createUdpNominationHarness,
  sentNominations,
} from "../utils";

describe("ICE regular nomination for UDP / relay pairs", () => {
  test("nominates only the higher-priority pair when a lower-priority pair succeeds first", async () => {
    const harness = createUdpNominationHarness();
    const high = await addUdpRemoteCandidate(harness, "host", 5001);
    const low = await addUdpRemoteCandidate(harness, "relay", 5002);
    // 高優先度 pair の check はまだ応答待ちとして扱う。
    high.updateState(CandidatePairState.IN_PROGRESS);

    try {
      // Act: 低優先度 (relay) pair の connectivity check だけ先に成功させる。
      await harness.connection.checkStart(low).awaitable;
      await setTimeout(20);

      // Assert: 通常 check に USE-CANDIDATE は付かず、まだ nominate しない。
      expect(harness.protocol.sentMessages).toHaveLength(1);
      expect(sentNominations(harness.protocol)).toHaveLength(0);
      expect(harness.connection.nominated).toBeUndefined();

      // Act: 高優先度 (host) pair の check を後から成功させる。
      await harness.connection.checkStart(high).awaitable;
      await vi.waitFor(() =>
        expect(harness.connection.nominated).toBeDefined(),
      );

      // Assert: 高優先度の valid pair だけが nominate される。
      expect(harness.connection.nominated).toBe(high);
      expect(low.nominated).toBe(false);
      // Assert: USE-CANDIDATE は高優先度 pair 宛ての 1 回だけ。
      const nominations = sentNominations(harness.protocol);
      expect(nominations).toHaveLength(1);
      expect(harness.protocol.sentMessages.at(-1)).toBe(nominations[0]);
    } finally {
      await harness.connection.close();
    }
  });

  test("does not commit to an early relay pair before a trickled higher-priority candidate is checked", async () => {
    const harness = createUdpNominationHarness({
      remoteCandidatesEnd: false,
      nominationDelay: 0.3,
    });
    const relay = await addUdpRemoteCandidate(harness, "relay", 5002);

    try {
      // Act: 先に届いた低優先度 relay candidate の check を成功させる。
      await harness.connection.checkStart(relay).awaitable;
      await setTimeout(50);

      // Assert: end-of-candidates 前かつ遅延期間中なので nominate しない。
      expect(sentNominations(harness.protocol)).toHaveLength(0);
      expect(harness.connection.nominated).toBeUndefined();

      // Act: 少し遅れて高優先度 candidate が trickle され、その check も成功する。
      const host = await addUdpRemoteCandidate(harness, "host", 5001);
      await harness.connection.checkStart(host).awaitable;
      await vi.waitFor(() =>
        expect(harness.connection.nominated).toBeDefined(),
      );

      // Assert: 停止条件 (nominationDelay) 経過後、高優先度 pair が選ばれる。
      expect(harness.connection.nominated).toBe(host);
      expect(relay.nominated).toBe(false);
      expect(sentNominations(harness.protocol)).toHaveLength(1);
    } finally {
      await harness.connection.close();
    }
  });

  test("nominates the best valid pair once nominationDelay elapses without end-of-candidates", async () => {
    const harness = createUdpNominationHarness({
      remoteCandidatesEnd: false,
      nominationDelay: 0.1,
    });
    const relay = await addUdpRemoteCandidate(harness, "relay", 5002);

    try {
      // Act: 唯一の pair を成功させ、end-of-candidates が来ないまま待つ。
      await harness.connection.checkStart(relay).awaitable;
      await vi.waitFor(() =>
        expect(harness.connection.nominated).toBeDefined(),
      );

      // Assert: 待機は nominationDelay で打ち切られ、その pair が nominate される。
      expect(harness.connection.nominated).toBe(relay);
      expect(sentNominations(harness.protocol)).toHaveLength(1);
    } finally {
      await harness.connection.close();
    }
  });

  test("nominates a single viable pair without delay when candidates are complete", async () => {
    // nominationDelay を長くし、遅延待ちに入れば検出できるようにする。
    const harness = createUdpNominationHarness({ nominationDelay: 10 });
    const pair = await addUdpRemoteCandidate(harness, "relay", 5002);

    try {
      // Act: 唯一の pair の check を成功させる。
      await harness.connection.checkStart(pair).awaitable;
      await vi.waitFor(
        () => expect(harness.connection.nominated).toBeDefined(),
        { timeout: 500 },
      );

      // Assert: 遅延を待たずに nominate され、check と nomination の 2 通のみ。
      expect(harness.connection.nominated).toBe(pair);
      expect(harness.protocol.sentMessages).toHaveLength(2);
      expect(sentNominations(harness.protocol)).toHaveLength(1);
    } finally {
      await harness.connection.close();
    }
  });

  test("nominates immediately when end-of-candidates arrives after the only valid pair", async () => {
    const harness = createUdpNominationHarness({
      remoteCandidatesEnd: false,
      nominationDelay: 10,
    });
    const pair = await addUdpRemoteCandidate(harness, "relay", 5002);

    try {
      // Act: pair を成功させた後に end-of-candidates を通知する。
      await harness.connection.checkStart(pair).awaitable;
      await setTimeout(20);
      // end-of-candidates 前は nominate しない。
      expect(harness.connection.nominated).toBeUndefined();
      await harness.connection.addRemoteCandidate(undefined);
      await vi.waitFor(
        () => expect(harness.connection.nominated).toBeDefined(),
        { timeout: 500 },
      );

      // Assert: end-of-candidates で停止条件を満たし、即座に nominate される。
      expect(harness.connection.nominated).toBe(pair);
      expect(sentNominations(harness.protocol)).toHaveLength(1);
    } finally {
      await harness.connection.close();
    }
  });

  test("emits a single USE-CANDIDATE even when more checks succeed after nomination", async () => {
    const harness = createUdpNominationHarness();
    const high = await addUdpRemoteCandidate(harness, "host", 5001);
    const mid = await addUdpRemoteCandidate(harness, "srflx", 5002);
    const low = await addUdpRemoteCandidate(harness, "relay", 5003);
    high.updateState(CandidatePairState.IN_PROGRESS);
    mid.updateState(CandidatePairState.IN_PROGRESS);

    try {
      // Act: 低 → 高の順に成功させ、高優先度 pair の nomination を待つ。
      await harness.connection.checkStart(low).awaitable;
      await harness.connection.checkStart(high).awaitable;
      await vi.waitFor(() => expect(harness.connection.nominated).toBe(high));

      // Act: nomination 後に残りの pair の check も成功させる。
      await harness.connection.checkStart(mid).awaitable;
      await setTimeout(20);

      // Assert: USE-CANDIDATE は component につき 1 回だけで、選択 pair は変わらない。
      expect(sentNominations(harness.protocol)).toHaveLength(1);
      expect(harness.connection.nominated).toBe(high);
      expect(mid.nominated).toBe(false);
      expect(low.nominated).toBe(false);
    } finally {
      await harness.connection.close();
    }
  });
});

describe("ICE nomination behavior kept for controlled / ICE-lite", () => {
  test("controlling agent nominates the first valid pair when the remote is ICE-lite", async () => {
    const harness = createUdpNominationHarness({ remoteIsLite: true });
    const high = await addUdpRemoteCandidate(harness, "host", 5001);
    const low = await addUdpRemoteCandidate(harness, "relay", 5002);
    high.updateState(CandidatePairState.IN_PROGRESS);

    try {
      // Act: 高優先度 pair が未完了のまま、低優先度 pair の check を成功させる。
      await harness.connection.checkStart(low).awaitable;

      // Assert: ICE-lite 相手には従来通り最初の valid pair を即 nominate する。
      expect(harness.connection.nominated).toBe(low);
      const [check, nomination] = harness.protocol.sentMessages;
      expect(harness.protocol.sentMessages).toHaveLength(2);
      expect(check.attributesKeys).not.toContain("USE-CANDIDATE");
      expect(nomination.attributesKeys).toContain("USE-CANDIDATE");
    } finally {
      await harness.connection.close();
    }
  });

  test("controlled agent selects the pair nominated by the remote and never sends USE-CANDIDATE", async () => {
    const harness = createUdpNominationHarness({ iceControlling: false });
    const pair = await addUdpRemoteCandidate(harness, "relay", 5002);

    try {
      // Act: 自身の check を成功させても、controlled 側は nominate しない。
      await harness.connection.checkStart(pair).awaitable;
      expect(harness.connection.nominated).toBeUndefined();

      // Act: controlling 側から USE-CANDIDATE 付き check を受信する。
      harness.connection.checkIncoming(
        createIncomingCheck(harness.connection, {
          useCandidate: true,
          fromControlling: true,
        }),
        pair.remoteAddr,
        harness.protocol,
      );

      // Assert: remote の nomination に従って pair が選択される。
      expect(harness.connection.nominated).toBe(pair);
      // Assert: controlled 側からは USE-CANDIDATE を送らない。
      expect(sentNominations(harness.protocol)).toHaveLength(0);
    } finally {
      await harness.connection.close();
    }
  });
});
