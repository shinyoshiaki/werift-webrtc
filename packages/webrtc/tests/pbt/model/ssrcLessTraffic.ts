import { expect } from "vitest";
import {
  type RTCPeerConnection,
  type RTCRtpTransceiver,
  RtpHeader,
  RtpPacket,
} from "../../../src";
import type { RTCDtlsTransport } from "../../../src/transport/dtls";

/**
 * The traffic operation `remoteSsrcSwitch` of the model property: on an
 * m-line whose current remote description has neither `a=ssrc` nor RIDs
 * (#356, RFC 9143 section 9.2), the remote stream switches to a new SSRC
 * and a late packet of the previous one follows, injected at the router as
 * the peer's DTLS transport delivers them. It applies in any signaling
 * state, so a pending offer, pranswer, commit or rollback meets a running
 * SSRC switch. Expected: both reach the track `ontrack` announced, which
 * stays the receiver's track and shows the new SSRC.
 */

type Internal = {
  router: {
    routeRtp: (packet: RtpPacket, transport?: RTCDtlsTransport) => void;
  };
};

const sections = (sdp: string) => sdp.split(/(?=^m=)/m).slice(1);

/**
 * A receiving transceiver on an m-line its current remote description sends
 * without SSRC and RID, and that has no description track (an m-line whose
 * earlier description gave SSRCs keeps that track and its routes: a current
 * remote SSRC a later description omits stays routed, out of scope of #356).
 */
export function ssrcLessReceivers(pc: RTCPeerConnection) {
  const remote = pc.currentRemoteDescription?.sdp;
  if (!remote) return [];
  return pc.getTransceivers().filter((t) => {
    if (!t.mid || t.stopped || t.stopping) return false;
    if (t.receiver.tracks.length > 0) return false;
    if (!["recvonly", "sendrecv"].includes(t.currentDirection ?? "")) {
      return false;
    }
    const section = sections(remote).find((s) =>
      new RegExp(`^a=mid:${t.mid}\\r?$`, "m").test(s),
    );
    return (
      !!section &&
      !/^m=\S+ 0 /.test(section) &&
      /^a=(sendrecv|sendonly)\r?$/m.test(section) &&
      !/^a=(ssrc|rid|simulcast):/m.test(section)
    );
  });
}

/** The MID header extension ID of `t`'s current remote m-line, if negotiated. */
function midExtensionId(pc: RTCPeerConnection, t: RTCRtpTransceiver) {
  const section = sections(pc.currentRemoteDescription!.sdp).find((s) =>
    new RegExp(`^a=mid:${t.mid}\\r?$`, "m").test(s),
  );
  const local = sections(pc.currentLocalDescription?.sdp ?? "").find((s) =>
    new RegExp(`^a=mid:${t.mid}\\r?$`, "m").test(s),
  );
  const pattern =
    /^a=extmap:(\d+)(?:\/\w+)? urn:ietf:params:rtp-hdrext:sdes:mid\r?$/m;
  const id = section?.match(pattern)?.[1];
  return id && local?.match(pattern)?.[1] === id ? Number(id) : undefined;
}

/**
 * Receiving as the router decides it: the committed direction, or before the
 * first commit the provisional one (`RtpRouter.learnUnknownSsrc`).
 */
const receiving = (t: RTCRtpTransceiver) =>
  t.currentDirection
    ? ["recvonly", "sendrecv"].includes(t.currentDirection)
    : ["recvonly", "sendrecv"].includes(t.direction) &&
      t.firedReceiving &&
      !t.pendingRejection;

/** A media payload type of `t`'s receiver that no other receiving m-line of its transport receives. */
function payloadTypeOf(
  pc: RTCPeerConnection,
  t: RTCRtpTransceiver,
  unique: boolean,
) {
  const section = sections(pc.currentRemoteDescription!.sdp).find((s) =>
    new RegExp(`^a=mid:${t.mid}\\r?$`, "m").test(s),
  )!;
  const pts = section.split("\r\n")[0].split(" ").slice(3).map(Number);
  const others = pc
    .getTransceivers()
    .filter(
      (o) =>
        o !== t &&
        !o.stopped &&
        !o.stopping &&
        o.dtlsTransport === t.dtlsTransport &&
        receiving(o),
    );
  return pts.find(
    (pt) =>
      t.receiver.receivesMediaPayloadType(pt) &&
      (!unique ||
        !others.some(
          (o) =>
            o.receiver.receivesMediaPayloadType(pt) ||
            o.receiver.receivesRtxPayloadType(pt),
        )),
  );
}

let nextSsrc = 0x35600000;

/**
 * Act / Assert: a switch to a new SSRC, then a late packet of the previous
 * learned SSRC (`late`), with the MID extension when `withMid` and the
 * m-line negotiated it. Returns a note for the operation log.
 */
export function switchRemoteSsrc(
  pc: RTCPeerConnection,
  t: RTCRtpTransceiver,
  { withMid, late }: { withMid: boolean; late: boolean },
) {
  const midId = withMid ? midExtensionId(pc, t) : undefined;
  const payloadType = payloadTypeOf(pc, t, midId === undefined);
  if (payloadType === undefined) {
    return "  no payload type names the m-line: nothing to switch";
  }
  const announced = t.receiver.track;
  const previous = t.receiver.fallbackSsrc;
  const ssrc = ++nextSsrc;
  const received: string[] = [];
  const subscription = announced.onReceiveRtp.subscribe((rtp) => {
    received.push(rtp.payload.toString());
  });
  const send = (from: number, sequenceNumber: number, text: string) => {
    const packet = new RtpPacket(
      new RtpHeader({
        ssrc: from,
        payloadType,
        sequenceNumber,
        timestamp: sequenceNumber * 960,
        extensions:
          midId === undefined
            ? []
            : [{ id: midId, payload: Buffer.from(t.mid!) }],
      }),
      Buffer.from(text),
    );
    (pc as unknown as Internal).router.routeRtp(packet, t.dtlsTransport);
  };
  // 新しい SSRC に切り替え、続けて旧 SSRC の遅延パケットが届く。
  send(ssrc, 30000, `switch-${ssrc}`);
  if (late && previous !== undefined) send(previous, 1, `late-${previous}`);
  subscription.unSubscribe();
  const expected = [`switch-${ssrc}`];
  if (late && previous !== undefined) expected.push(`late-${previous}`);
  expect(received, `${t.mid}: RTP of a switched SSRC`).toEqual(expected);
  expect(t.receiver.track, `${t.mid}: the announced track stays`).toBe(
    announced,
  );
  expect(announced.ssrc, `${t.mid}: the track shows the newest SSRC`).toBe(
    ssrc,
  );
  return `  ${t.mid}: ${previous ?? "-"} -> ${ssrc} (pt ${payloadType}, mid ${midId !== undefined}, late ${late && previous !== undefined})`;
}
