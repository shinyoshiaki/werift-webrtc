import { parseIceServers } from "../src";
import { RTCIceServer } from "../src/peerConnection";

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
      const { stunServer, turnPassword, turnServer, turnUsername } =
        parseIceServers(iceServers);
      expect(stunServer).toEqual(["stun.l.google.com", 19302]);
      expect(turnServer).toEqual(["turn.l.google.com", 19302]);
      expect(turnUsername).toBe("username");
      expect(turnPassword).toBe("credential");
    });
  });
});
