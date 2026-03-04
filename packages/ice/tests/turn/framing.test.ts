import type { AddressInfo } from "node:net";

import type { Address, Transport } from "../../src/imports/common";
import { classes, methods } from "../../src/stun/const";
import { Message } from "../../src/stun/message";
import { TurnProtocol } from "../../src/turn/protocol";

/**
 * Tests that TurnProtocol correctly applies TCP-style stream framing
 * when the transport type is "tls" (TURNS), not just "tcp".
 *
 * This is critical because TLS-over-TCP is still a stream protocol —
 * multiple STUN messages may arrive coalesced in a single data event.
 * Without framing, the second message would be silently dropped or
 * cause a parse error.
 *
 * References:
 * - pion/turn: uses STUNConn adapter for both TCP and TLS
 * - libwebrtc: uses AsyncStunTCPSocket for both TCP and TLS (PROTO_TLS)
 */

function createMockTransport(type: string): Transport {
  return {
    type,
    address: {} as AddressInfo,
    closed: false,
    onData: () => {},
    send: async () => {},
    close: async () => {},
  };
}

function buildStunBindingRequest(): Buffer {
  const msg = new Message(methods.BINDING, classes.REQUEST);
  return msg.bytes;
}

describe("TurnProtocol stream framing", () => {
  test('applies framing for transport type "tls" (coalesced STUN messages)', () => {
    const transport = createMockTransport("tls");
    const turn = new TurnProtocol(
      ["127.0.0.1", 3478],
      "user",
      "pass",
      600,
      transport,
    );

    // Wire up onData (normally done by connectionMade, but we skip ALLOCATE)
    transport.onData = (data, addr) => {
      (turn as any).dataReceived(data, addr);
    };

    const received: Buffer[] = [];
    turn.onData.subscribe((data) => {
      received.push(data);
    });

    // Build two distinct STUN Binding Requests
    const msg1 = buildStunBindingRequest();
    const msg2 = buildStunBindingRequest();

    // Concatenate them to simulate coalesced stream delivery
    const coalesced = Buffer.concat([msg1, msg2]);

    // Fire as a single data event (as TLS stream would deliver)
    transport.onData(coalesced, ["127.0.0.1", 3478]);

    // Both messages should be processed separately by the framing logic
    // handleSTUNMessage receives REQUEST class → fires onData with raw data
    expect(received.length).toBe(2);
    expect(received[0].length).toBe(msg1.length);
    expect(received[1].length).toBe(msg2.length);
  });

  test('applies framing for transport type "tcp" (baseline)', () => {
    const transport = createMockTransport("tcp");
    const turn = new TurnProtocol(
      ["127.0.0.1", 3478],
      "user",
      "pass",
      600,
      transport,
    );

    transport.onData = (data, addr) => {
      (turn as any).dataReceived(data, addr);
    };

    const received: Buffer[] = [];
    turn.onData.subscribe((data) => {
      received.push(data);
    });

    const msg1 = buildStunBindingRequest();
    const msg2 = buildStunBindingRequest();
    const coalesced = Buffer.concat([msg1, msg2]);

    transport.onData(coalesced, ["127.0.0.1", 3478]);

    expect(received.length).toBe(2);
    expect(received[0].length).toBe(msg1.length);
    expect(received[1].length).toBe(msg2.length);
  });

  test('does NOT apply framing for transport type "udp"', () => {
    const transport = createMockTransport("udp");
    const turn = new TurnProtocol(
      ["127.0.0.1", 3478],
      "user",
      "pass",
      600,
      transport,
    );

    transport.onData = (data, addr) => {
      (turn as any).dataReceived(data, addr);
    };

    const received: Buffer[] = [];
    turn.onData.subscribe((data) => {
      received.push(data);
    });

    // Single STUN message — should be processed as-is
    const msg = buildStunBindingRequest();
    transport.onData(msg, ["127.0.0.1", 3478]);

    expect(received.length).toBe(1);
  });

  test("handles partial message delivery over TLS (fragmented stream)", () => {
    const transport = createMockTransport("tls");
    const turn = new TurnProtocol(
      ["127.0.0.1", 3478],
      "user",
      "pass",
      600,
      transport,
    );

    transport.onData = (data, addr) => {
      (turn as any).dataReceived(data, addr);
    };

    const received: Buffer[] = [];
    turn.onData.subscribe((data) => {
      received.push(data);
    });

    const msg = buildStunBindingRequest();

    // Deliver message in two fragments (simulates TCP fragmentation)
    const fragment1 = msg.subarray(0, 10);
    const fragment2 = msg.subarray(10);

    transport.onData(fragment1, ["127.0.0.1", 3478]);
    // Should not have processed anything yet (incomplete message)
    expect(received.length).toBe(0);

    transport.onData(fragment2, ["127.0.0.1", 3478]);
    // Now the full message should be assembled and processed
    expect(received.length).toBe(1);
    expect(received[0].length).toBe(msg.length);
  });

  test("handles three messages coalesced over TLS", () => {
    const transport = createMockTransport("tls");
    const turn = new TurnProtocol(
      ["127.0.0.1", 3478],
      "user",
      "pass",
      600,
      transport,
    );

    transport.onData = (data, addr) => {
      (turn as any).dataReceived(data, addr);
    };

    const received: Buffer[] = [];
    turn.onData.subscribe((data) => {
      received.push(data);
    });

    const msg1 = buildStunBindingRequest();
    const msg2 = buildStunBindingRequest();
    const msg3 = buildStunBindingRequest();
    const coalesced = Buffer.concat([msg1, msg2, msg3]);

    transport.onData(coalesced, ["127.0.0.1", 3478]);

    expect(received.length).toBe(3);
  });
});
