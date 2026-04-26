import { Candidate } from "../src/candidate";

describe("candidate", () => {
  test("test_can_pair_ipv4", () => {
    const a = Candidate.fromSdp(
      "6815297761 1 udp 659136 1.2.3.4 31102 typ host generation 0",
    );
    const b = Candidate.fromSdp(
      "6815297761 1 udp 659136 1.2.3.4 12345 typ host generation 0",
    );
    expect(a.canPairWith(b)).toBe(true);
  });

  test("test_can_pair_ipv4_case_insensitive", () => {
    const a = Candidate.fromSdp(
      "6815297761 1 udp 659136 1.2.3.4 31102 typ host generation 0",
    );
    const b = Candidate.fromSdp(
      "6815297761 1 UDP 659136 1.2.3.4 12345 typ host generation 0",
    );
    expect(a.canPairWith(b)).toBe(true);
  });

  test("test_can_pair_ipv6", () => {
    const a = Candidate.fromSdp(
      "6815297761 1 udp 659136 2a02:0db8:85a3:0000:0000:8a2e:0370:7334 31102 typ host generation 0",
    );
    const b = Candidate.fromSdp(
      "6815297761 1 udp 659136 2a02:0db8:85a3:0000:0000:8a2e:0370:7334 12345 typ host generation 0",
    );
    expect(a.canPairWith(b)).toBe(true);
  });

  test("test_cannot_pair_ipv4_ipv6", () => {
    const a = Candidate.fromSdp(
      "6815297761 1 udp 659136 1.2.3.4 31102 typ host generation 0",
    );
    const b = Candidate.fromSdp(
      "6815297761 1 udp 659136 2a02:0db8:85a3:0000:0000:8a2e:0370:7334 12345 typ host generation 0",
    );
    expect(a.canPairWith(b)).toBe(false);
  });

  test("test_cannot_pair_different_components", () => {
    const a = Candidate.fromSdp(
      "6815297761 1 udp 659136 1.2.3.4 31102 typ host generation 0",
    );
    const b = Candidate.fromSdp(
      "6815297761 2 udp 659136 1.2.3.4 12345 typ host generation 0",
    );
    expect(a.canPairWith(b)).toBe(false);
  });

  test("test_cannot_pair_different_transports", () => {
    const a = Candidate.fromSdp(
      "6815297761 1 udp 659136 1.2.3.4 31102 typ host generation 0",
    );
    const b = Candidate.fromSdp(
      "6815297761 1 tcp 659136 1.2.3.4 12345 typ host generation 0 tcptype active",
    );
    expect(a.canPairWith(b)).toBe(false);
  });

  test("test_from_sdp_udp", () => {
    const candidate = Candidate.fromSdp(
      "6815297761 1 udp 659136 1.2.3.4 31102 typ host generation 0",
    );
    expect(candidate.foundation).toBe("6815297761");
    expect(candidate.component).toBe(1);
    expect(candidate.transport).toBe("udp");
    expect(candidate.priority).toBe(659136);
    expect(candidate.host).toBe("1.2.3.4");
    expect(candidate.port).toBe(31102);
    expect(candidate.type).toBe("host");
    expect(candidate.generation).toBe(0);

    expect(candidate.toSdp()).toBe(
      "6815297761 1 udp 659136 1.2.3.4 31102 typ host generation 0",
    );
  });

  test("test_from_sdp_udp_srflx", () => {
    const candidate = Candidate.fromSdp(
      "1 1 UDP 1686052863 1.2.3.4 42705 typ srflx raddr 192.168.1.101 rport 42705",
    );
    expect(candidate.foundation).toBe("1");
    expect(candidate.component).toBe(1);
    expect(candidate.transport).toBe("UDP");
    expect(candidate.priority).toBe(1686052863);
    expect(candidate.host).toBe("1.2.3.4");
    expect(candidate.port).toBe(42705);
    expect(candidate.type).toBe("srflx");
    expect(candidate.relatedAddress).toBe("192.168.1.101");
    expect(candidate.relatedPort).toBe(42705);
    expect(candidate.generation).toBe(undefined);

    expect(candidate.toSdp()).toBe(
      "1 1 UDP 1686052863 1.2.3.4 42705 typ srflx raddr 192.168.1.101 rport 42705",
    );
  });

  test("test_from_sdp_tcp", () => {
    const candidate = Candidate.fromSdp(
      "1936595596 1 tcp 1518214911 1.2.3.4 9 typ host tcptype active generation 0 network-id 1 network-cost 10",
    );
    expect(candidate.foundation).toBe("1936595596");
    expect(candidate.component).toBe(1);
    expect(candidate.transport).toBe("tcp");
    expect(candidate.priority).toBe(1518214911);
    expect(candidate.host).toBe("1.2.3.4");
    expect(candidate.port).toBe(9);
    expect(candidate.type).toBe("host");
    expect(candidate.tcptype).toBe("active");
    expect(candidate.generation).toBe(0);

    expect(candidate.toSdp()).toBe(
      "1936595596 1 tcp 1518214911 1.2.3.4 9 typ host tcptype active generation 0",
    );
  });

  test("test_from_sdp_no_generation", () => {
    const candidate = Candidate.fromSdp(
      "6815297761 1 udp 659136 1.2.3.4 31102 typ host",
    );
    expect(candidate.foundation).toBe("6815297761");
    expect(candidate.component).toBe(1);
    expect(candidate.transport).toBe("udp");
    expect(candidate.priority).toBe(659136);
    expect(candidate.host).toBe("1.2.3.4");
    expect(candidate.port).toBe(31102);
    expect(candidate.type).toBe("host");
    expect(candidate.generation).toBe(undefined);

    expect(candidate.toSdp()).toBe(
      "6815297761 1 udp 659136 1.2.3.4 31102 typ host",
    );
  });

  test("test_from_sdp_no_generation", () => {
    try {
      Candidate.fromSdp("6815297761 1 udp 659136 1.2.3.4 31102 typ");
    } catch (error) {
      expect(error).not.toBeNull();
    }
  });
});
