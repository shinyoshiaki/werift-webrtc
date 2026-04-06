import { parseIceServers } from "../src";
import { deepMerge } from "../src";
import type { RTCIceServer } from "../src/peerConnection";

describe("utils", () => {
  describe("parseIceServers", () => {
    test("stun", () => {
      const iceServers = [{ urls: "stun:stun.l.google.com:19302" }];
      const { stunServer, turnPassword, turnServer, turnUsername } =
        parseIceServers(iceServers);
      expect(stunServer).toEqual(["stun.l.google.com", 19302]);
      expect(turnPassword).toBeFalsy();
      expect(turnServer).toBeFalsy();
      expect(turnUsername).toBeFalsy();
    });

    test("turn", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turn:turn.l.google.com:19302",
          credential: "credential",
          username: "username",
        },
      ];
      const { stunServer, turnPassword, turnServer, turnUsername } =
        parseIceServers(iceServers);
      expect(stunServer).toBeFalsy();
      expect(turnServer).toEqual(["turn.l.google.com", 19302]);
      expect(turnUsername).toBe("username");
      expect(turnPassword).toBe("credential");
    });

    test("turn & stun", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turn:turn.l.google.com:19302",
          credential: "credential",
          username: "username",
        },
        { urls: "stun:stun.l.google.com:19302" },
      ];
      const { stunServer, turnPassword, turnServer, turnUsername, turnSsl } =
        parseIceServers(iceServers);
      expect(stunServer).toEqual(["stun.l.google.com", 19302]);
      expect(turnServer).toEqual(["turn.l.google.com", 19302]);
      expect(turnUsername).toBe("username");
      expect(turnPassword).toBe("credential");
      expect(turnSsl).toBe(false);
    });

    test("turns (TURN-over-TLS)", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turns:global.relay.metered.ca:443",
          credential: "credential",
          username: "username",
        },
      ];
      const { turnServer, turnUsername, turnPassword, turnSsl } =
        parseIceServers(iceServers);
      expect(turnServer).toEqual(["global.relay.metered.ca", 443]);
      expect(turnUsername).toBe("username");
      expect(turnPassword).toBe("credential");
      expect(turnSsl).toBe(true);
    });

    test("turns with query params", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turns:global.relay.metered.ca:443?transport=tcp",
          credential: "credential",
          username: "username",
        },
      ];
      const { turnServer, turnSsl } = parseIceServers(iceServers);
      expect(turnServer).toEqual(["global.relay.metered.ca", 443]);
      expect(turnSsl).toBe(true);
    });

    test("turn with query params", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turn:relay.example.com:3478?transport=tcp",
          credential: "credential",
          username: "username",
        },
      ];
      const { turnServer, turnSsl } = parseIceServers(iceServers);
      expect(turnServer).toEqual(["relay.example.com", 3478]);
      expect(turnSsl).toBe(false);
    });

    // RFC 7065 §3.2: default port for turns: is 5349 (pion, libwebrtc, aiortc all implement this)
    test("turns without port defaults to 5349 (RFC 7065)", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turns:global.relay.metered.ca",
          credential: "credential",
          username: "username",
        },
      ];
      const { turnServer, turnSsl } = parseIceServers(iceServers);
      expect(turnServer).toEqual(["global.relay.metered.ca", 5349]);
      expect(turnSsl).toBe(true);
    });

    // RFC 7065 §3.2: default port for turn: is 3478
    test("turn without port defaults to 3478 (RFC 7065)", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turn:relay.example.com",
          credential: "credential",
          username: "username",
        },
      ];
      const { turnServer, turnSsl } = parseIceServers(iceServers);
      expect(turnServer).toEqual(["relay.example.com", 3478]);
      expect(turnSsl).toBe(false);
    });

    // RFC 7065: default port for stun: is 3478
    test("stun without port defaults to 3478 (RFC 7065)", () => {
      const iceServers = [{ urls: "stun:stun.l.google.com" }];
      const { stunServer } = parseIceServers(iceServers);
      expect(stunServer).toEqual(["stun.l.google.com", 3478]);
    });

    // pion uri_test.go: explicit port overrides default
    test("turns with explicit port overrides default 5349", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turns:relay.example.com:443",
          credential: "credential",
          username: "username",
        },
      ];
      const { turnServer } = parseIceServers(iceServers);
      expect(turnServer).toEqual(["relay.example.com", 443]);
    });

    // pion uri_test.go: turns without port + query params
    test("turns without port but with query params defaults to 5349", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turns:relay.example.com?transport=tcp",
          credential: "credential",
          username: "username",
        },
      ];
      const { turnServer, turnSsl } = parseIceServers(iceServers);
      expect(turnServer).toEqual(["relay.example.com", 5349]);
      expect(turnSsl).toBe(true);
    });

    // libwebrtc: empty ice servers returns no servers
    test("empty ice servers", () => {
      const { stunServer, turnServer, turnSsl } = parseIceServers([]);
      expect(stunServer).toBeUndefined();
      expect(turnServer).toBeUndefined();
      expect(turnSsl).toBe(false);
    });

    // Regression: "stun:" must not match "stuns:" URLs
    test("turns-only does not produce a spurious stunServer", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turns:secure.relay.com:443",
          credential: "cred",
          username: "user",
        },
      ];
      const { stunServer, turnServer, turnSsl } = parseIceServers(iceServers);
      expect(stunServer).toBeUndefined();
      expect(turnServer).toEqual(["secure.relay.com", 443]);
      expect(turnSsl).toBe(true);
    });

    test("turns preferred over turn when both present", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turn:plain.relay.com:3478",
          credential: "plain-cred",
          username: "plain-user",
        },
        {
          urls: "turns:secure.relay.com:443",
          credential: "tls-cred",
          username: "tls-user",
        },
      ];
      const { turnServer, turnUsername, turnPassword, turnSsl } =
        parseIceServers(iceServers);
      expect(turnServer).toEqual(["secure.relay.com", 443]);
      expect(turnUsername).toBe("tls-user");
      expect(turnPassword).toBe("tls-cred");
      expect(turnSsl).toBe(true);
    });
  });

  describe("deepMerge", () => {
    test("merges two objects", () => {
      const obj1 = { a: 1, b: { c: 2, d: 3 } };
      const obj2 = { b: { c: 20, e: 5 }, f: 6 };
      const result = deepMerge(obj1, obj2 as any);
      expect(result).toEqual({ a: 1, b: { c: 20, e: 5 }, f: 6 });
    });

    test("does not overwrite with undefined", () => {
      const obj1 = { a: 1, b: 2 };
      const obj2 = { a: undefined, b: 3 };
      const result = deepMerge(obj1, obj2 as any);
      expect(result).toEqual({ a: 1, b: 3 });
    });

    test("handles nested objects", () => {
      const obj1 = { a: { b: { c: 1 } } };
      const obj2 = { a: { b: { d: 2 }, e: 3 } };
      const result = deepMerge(obj1, obj2 as any);
      expect(result).toEqual({ a: { b: { d: 2 }, e: 3 } });
    });

    test("arrays are replaced, not merged", () => {
      const obj1 = { a: [1, 2, 3], b: { c: [4, 5] } };
      const obj2 = { a: [6, 7], b: { c: [8] } };
      const result = deepMerge(obj1, obj2);
      expect(result).toEqual({ a: [6, 7], b: { c: [8] } });
    });

    test("handles non-object inputs accordingly", () => {
      expect(deepMerge(null as any, { a: 1 })).toEqual({ a: 1 });
      expect(deepMerge({ a: 1 }, null as any)).toEqual({ a: 1 });
      // lodash mergeWith treats non-objects as Datatype Objects
      // and assigns attributes to them, which makes no sense
      // following test would fail, as it would expect
      // the result equal to Object(42) with attribute 'a' = 1
      expect(deepMerge(42 as any, { a: 1 })).toEqual({ a: 1 });
      expect(deepMerge({ a: 1 }, 42 as any)).toEqual(42);
    });

    test("merges complex nested structures", () => {
      const obj1 = { a: { b: 1, c: { d: 2 } }, e: 3 };
      const obj2 = { a: { c: { f: 4 } }, g: 5 };
      const result = deepMerge(obj1, obj2 as any);
      expect(result).toEqual({ a: { c: { f: 4 } }, e: 3, g: 5 });
    });

    test("Date objects are replaced, not merged", () => {
      const date1 = new Date("2020-01-01");
      const date2 = new Date("2021-01-01");
      const obj1 = { a: date1 };
      const obj2 = { a: date2 };
      const result = deepMerge(obj1, obj2);
      expect(result).toEqual({ a: date2 });
    });

    test("functions are replaced, not merged", () => {
      const func1 = () => 1;
      const func2 = () => 2;
      const obj1 = { a: func1 };
      const obj2 = { a: func2 };
      const result = deepMerge(obj1, obj2);
      expect(result.a).toBe(func2);
    });

    test("symbol properties are ignored", () => {
      const sym1 = Symbol("a");
      const sym2 = Symbol("b");
      const obj1 = { [sym1]: 1 };
      const obj2 = { [sym2]: 2 };
      const result = deepMerge(obj1, obj2 as any);
      expect(result).toEqual({ [sym1]: 1 });
    });
  });
});
