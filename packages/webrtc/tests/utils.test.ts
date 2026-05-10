import { deepMerge, parseIceServers, resolveTurnTransport } from "../src";
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

    test("turn with transport query", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turn:turn.l.google.com:19302?transport=tcp",
          credential: "credential",
          username: "username",
        },
      ];
      const { turnServer, turnTransport } = parseIceServers(iceServers);
      expect(turnServer).toEqual(["turn.l.google.com", 19302]);
      expect(turnTransport).toBe("tcp");
    });

    test("turns with tcp query resolves to tls transport", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turns:turn.l.google.com:5349?transport=tcp",
          credential: "credential",
          username: "username",
        },
      ];
      const { turnPassword, turnServer, turnTransport, turnUsername } =
        parseIceServers(iceServers);
      expect(turnServer).toEqual(["turn.l.google.com", 5349]);
      expect(turnUsername).toBe("username");
      expect(turnPassword).toBe("credential");
      expect(turnTransport).toBe("tls");
    });

    test("turns without transport query defaults to tls transport", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turns:turn.l.google.com",
          credential: "credential",
          username: "username",
        },
      ];
      const { turnPassword, turnServer, turnTransport, turnUsername } =
        parseIceServers(iceServers);
      expect(turnServer).toEqual(["turn.l.google.com", 5349]);
      expect(turnUsername).toBe("username");
      expect(turnPassword).toBe("credential");
      expect(turnTransport).toBe("tls");
    });

    test("turns with invalid transport query is ignored", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turns:turn.l.google.com:5349?transport=udp",
          credential: "credential",
          username: "username",
        },
      ];
      const { turnPassword, turnServer, turnTransport, turnUsername } =
        parseIceServers(iceServers);
      expect(turnServer).toBeFalsy();
      expect(turnUsername).toBeFalsy();
      expect(turnPassword).toBeFalsy();
      expect(turnTransport).toBeFalsy();
    });

    test("turn with unknown transport query is ignored", () => {
      const iceServers: RTCIceServer[] = [
        {
          urls: "turn:turn.l.google.com:3478?transport=tls",
          credential: "credential",
          username: "username",
        },
      ];
      const { turnPassword, turnServer, turnTransport, turnUsername } =
        parseIceServers(iceServers);
      expect(turnServer).toBeFalsy();
      expect(turnUsername).toBeFalsy();
      expect(turnPassword).toBeFalsy();
      expect(turnTransport).toBeFalsy();
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
      const { stunServer, turnPassword, turnServer, turnUsername } =
        parseIceServers(iceServers);
      expect(stunServer).toEqual(["stun.l.google.com", 19302]);
      expect(turnServer).toEqual(["turn.l.google.com", 19302]);
      expect(turnUsername).toBe("username");
      expect(turnPassword).toBe("credential");
    });
  });

  describe("resolveTurnTransport", () => {
    test("prefers the transport parsed from the ICE server URL", () => {
      expect(
        resolveTurnTransport({
          parsedTurnTransport: "tls",
          configuredTurnTransport: "udp",
          forceTurnTCP: true,
        }),
      ).toBe("tls");
    });

    test("falls back to explicit config and legacy forceTurnTCP", () => {
      expect(
        resolveTurnTransport({
          configuredTurnTransport: "tcp",
          forceTurnTCP: false,
        }),
      ).toBe("tcp");
      expect(
        resolveTurnTransport({
          forceTurnTCP: true,
        }),
      ).toBe("tcp");
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
