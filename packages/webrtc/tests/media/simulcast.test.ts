import { RTCPeerConnection } from "../../src/pc";
import { RTCRtpTransceiver } from "../../src/media/rtpTransceiver";
import { MediaDescription } from "../../src/sdp";

describe("Simulcast Sending", () => {
  test("should generate correct SDP for simulcast sending offer", async () => {
    const pc = new RTCPeerConnection();

    // Add a video transceiver with simulcast sending configured
    pc.addTransceiver("video", {
      direction: "sendonly",
      // @ts-expect-error WIP: simulcast options structure might need alignment with RTCPeerConnection implementation details
      simulcast: [
        { rid: "q", direction: "send", scalabilityMode: "L1T3" }, // Example encoding param
        { rid: "h", direction: "send" },
        { rid: "f", direction: "send" },
      ],
    });

    const offer = await pc.createOffer();
    expect(offer.sdp).toBeTruthy();

    const sdpLines = offer.sdp!.split("\r\n");
    const videoMedia = sdpLines.find((line) => line.startsWith("m=video"));
    expect(videoMedia).toBeTruthy();

    // Find the media description block for video
    let videoMLineIndex = -1;
    for(let i=0; i<sdpLines.length; ++i) {
        if (sdpLines[i].startsWith("m=video")) {
            videoMLineIndex = i;
            break;
        }
    }
    expect(videoMLineIndex).toBeGreaterThan(-1);

    let currentMLineIndex = -1;
    const mediaSpecificLines: string[] = [];
    for(const line of sdpLines) {
        if (line.startsWith("m=")) {
            currentMLineIndex++;
        }
        if (currentMLineIndex === videoMLineIndex) {
            mediaSpecificLines.push(line);
        }
    }
    
    // Verify a=rid lines
    expect(mediaSpecificLines.includes("a=rid:q send")).toBe(true);
    expect(mediaSpecificLines.includes("a=rid:h send")).toBe(true);
    expect(mediaSpecificLines.includes("a=rid:f send")).toBe(true);

    // Verify a=simulcast line
    // The order of rids in a=simulcast might vary, so check for content
    const simulcastLine = mediaSpecificLines.find((line) =>
      line.startsWith("a=simulcast:send ")
    );
    expect(simulcastLine).toBeTruthy();
    expect(simulcastLine).toContain("q");
    expect(simulcastLine).toContain("h");
    expect(simulcastLine).toContain("f");
    // A more precise check for "q;h;f" or permutations might be needed if order is fixed
    expect(["q;h;f", "q;f;h", "h;q;f", "h;f;q", "f;q;h", "f;h;q"].some(perm => simulcastLine!.includes(`send ${perm}`))).toBe(true);


    // TODO: Add answer verification part if feasible without major PC changes
    // For now, this test focuses on the offer side as per subtask priority.
    // const remotePc = new RTCPeerConnection();
    // await remotePc.setRemoteDescription(offer);
    // const answer = await remotePc.createAnswer();
    // Verify answer SDP (might require remote to also understand simulcast)
  });

  test("should send RTP packets with correct RIDs and SSRCs for simulcast", async () => {
    const ssrc1 = 1111;
    const ssrc2 = 2222;
    const ssrc3 = 3333;
    const rid1 = "f";
    const rid2 = "h";
    const rid3 = "q";

    const sdesRtpStreamIdUri = "urn:ietf:params:rtp-hdrext:sdes:rtp-stream-id";
    const sdesMidUri = "urn:ietf:params:rtp-hdrext:sdes:mid";


    const mockDtlsTransport = {
      sendRtp: jest.fn(),
      state: "connected",
      transportSequenceNumber: 0,
    };

    const sender = new RTCRtpSender("video");
    // @ts-expect-error: Incomplete mock for dtls transport
    sender.setDtlsTransport(mockDtlsTransport);

    const sendEncodings = [
      { rid: rid1, ssrc: ssrc1, active: true },
      { rid: rid2, ssrc: ssrc2, active: true },
      { rid: rid3, ssrc: ssrc3, active: true },
    ];

    const codecs = [
      new RTCRtpCodecParameters({
        mimeType: "video/VP8",
        clockRate: 90000,
        payloadType: 96,
      }),
    ];
    const headerExtensions = [
      new RTCRtpHeaderExtensionParameters({ id: 1, uri: sdesMidUri }),
      new RTCRtpHeaderExtensionParameters({ id: 3, uri: sdesRtpStreamIdUri }),
    ];

    sender.prepareSend({
      codecs,
      headerExtensions,
      // @ts-expect-error we are testing RTCRtpSender directly here
      encodings: sendEncodings,
      muxId: "media_0", // Example MID
    });

    const dummyRtpPacket = new RtpPacket(
      new RtpHeader({
        payloadType: 96,
        sequenceNumber: 123,
        timestamp: 456,
        ssrc: 789, // Original SSRC, should be overridden
      }),
      Buffer.from("dummy_payload")
    );

    await sender.sendRtp(dummyRtpPacket);

    expect(mockDtlsTransport.sendRtp).toHaveBeenCalledTimes(3);

    const calls = mockDtlsTransport.sendRtp.mock.calls;

    // Check call for rid1/ssrc1
    const call1 = calls.find(
      ([payload, header]) => header.ssrc === ssrc1
    );
    expect(call1).toBeTruthy();
    const header1 = call1[1] as RtpHeader;
    const ridExt1 = header1.extensions.find(
      (ext) => headerExtensions.find(h => h.id === ext.id)?.uri === sdesRtpStreamIdUri
    );
    expect(ridExt1).toBeTruthy();
    // Assuming deserializeSdesRTPStreamID function exists and works
    // For test purposes, we can check raw payload if deserializer is not easily available here
    // expect(deserializeSdesRTPStreamID(ridExt1!.payload)).toBe(rid1); 
    // Let's check the raw payload based on common serialization (1-byte length, then ASCII)
    expect(ridExt1!.payload.toString("ascii")).toBe(rid1);


    // Check call for rid2/ssrc2
    const call2 = calls.find(
      ([payload, header]) => header.ssrc === ssrc2
    );
    expect(call2).toBeTruthy();
    const header2 = call2[1] as RtpHeader;
    const ridExt2 = header2.extensions.find(
      (ext) => headerExtensions.find(h => h.id === ext.id)?.uri === sdesRtpStreamIdUri
    );
    expect(ridExt2).toBeTruthy();
    expect(ridExt2!.payload.toString("ascii")).toBe(rid2);

    // Check call for rid3/ssrc3
    const call3 = calls.find(
      ([payload, header]) => header.ssrc === ssrc3
    );
    expect(call3).toBeTruthy();
    const header3 = call3[1] as RtpHeader;
    const ridExt3 = header3.extensions.find(
      (ext) => headerExtensions.find(h => h.id === ext.id)?.uri === sdesRtpStreamIdUri
    );
    expect(ridExt3).toBeTruthy();
    expect(ridExt3!.payload.toString("ascii")).toBe(rid3);
  });

  test("should correctly negotiate simulcast in offer/answer SDP", async () => {
    const pcLocal = new RTCPeerConnection();
    const pcRemote = new RTCPeerConnection();

    // Configure pcLocal to send simulcast
    pcLocal.addTransceiver("video", {
      direction: "sendonly",
      // @ts-expect-error WIP: simulcast options structure might need alignment
      simulcast: [
        { rid: "f", direction: "send" },
        { rid: "h", direction: "send" },
        { rid: "q", direction: "send" },
      ],
    });

    // Exchange ICE candidates
    pcLocal.onicecandidate = (e) => e.candidate && pcRemote.addIceCandidate(e.candidate);
    pcRemote.onicecandidate = (e) => e.candidate && pcLocal.addIceCandidate(e.candidate);

    const offer = await pcLocal.createOffer();
    await pcLocal.setLocalDescription(offer);
    await pcRemote.setRemoteDescription(offer);

    const answer = await pcRemote.createAnswer();
    await pcRemote.setLocalDescription(answer);
    await pcLocal.setRemoteDescription(answer);

    // Verify Local Offer SDP
    const offerSdpLines = offer.sdp!.split("\r\n");
    let localVideoMLineIndex = -1;
    for(let i=0; i<offerSdpLines.length; ++i) {
        if (offerSdpLines[i].startsWith("m=video")) {
            localVideoMLineIndex = i;
            break;
        }
    }
    let localCurrentMLineIndex = -1;
    const localMediaSpecificLines: string[] = [];
    for(const line of offerSdpLines) {
        if (line.startsWith("m=")) {
            localCurrentMLineIndex++;
        }
        if (localCurrentMLineIndex === localVideoMLineIndex) {
            localMediaSpecificLines.push(line);
        }
    }

    expect(localMediaSpecificLines.includes("a=rid:f send")).toBe(true);
    expect(localMediaSpecificLines.includes("a=rid:h send")).toBe(true);
    expect(localMediaSpecificLines.includes("a=rid:q send")).toBe(true);
    const localSimulcastLine = localMediaSpecificLines.find((line) => line.startsWith("a=simulcast:send "));
    expect(localSimulcastLine).toBeTruthy();
    expect(["f;h;q", "f;q;h", "h;f;q", "h;q;f", "q;f;h", "q;h;f"].some(perm => localSimulcastLine!.includes(`send ${perm}`))).toBe(true);

    // Verify Remote Answer SDP
    const answerSdpLines = answer.sdp!.split("\r\n");
    let remoteVideoMLineIndex = -1;
    for(let i=0; i<answerSdpLines.length; ++i) {
        if (answerSdpLines[i].startsWith("m=video")) {
            remoteVideoMLineIndex = i;
            break;
        }
    }
    let remoteCurrentMLineIndex = -1;
    const remoteMediaSpecificLines: string[] = [];
    for(const line of answerSdpLines) {
        if (line.startsWith("m=")) {
            remoteCurrentMLineIndex++;
        }
        if (remoteCurrentMLineIndex === remoteVideoMLineIndex) {
            remoteMediaSpecificLines.push(line);
        }
    }
    
    // Remote should acknowledge it will receive these RIDs
    // Note: The exact 'a=rid' lines in the answer might depend on transceiver capabilities and SDP processing.
    // We expect it to accept the RIDs offered for sending.
    expect(remoteMediaSpecificLines.includes("a=rid:f recv")).toBe(true);
    expect(remoteMediaSpecificLines.includes("a=rid:h recv")).toBe(true);
    expect(remoteMediaSpecificLines.includes("a=rid:q recv")).toBe(true);
    
    const remoteSimulcastLine = remoteMediaSpecificLines.find((line) => line.startsWith("a=simulcast:"));
    expect(remoteSimulcastLine).toBeTruthy();
    // Answer should indicate it's receiving the offered RIDs
    expect(["f;h;q", "f;q;h", "h;f;q", "h;q;f", "q;f;h", "q;h;f"].some(perm => remoteSimulcastLine!.includes(`recv ${perm}`))).toBe(true);
    // It might also indicate it's not sending anything, or sending something else if it were sendrecv
    // For recvonly, it should not have a 'send' part in its simulcast line for this transceiver.
    expect(remoteSimulcastLine).not.toContain("send");


    // Clean up
    pcLocal.close();
    pcRemote.close();
  });
});
// Helper to import for RtpPacket, RtpHeader, RTCRtpCodecParameters, RTCRtpHeaderExtensionParameters
import { RtpHeader, RtpPacket } from "../../src/rtp/rtp";
import { RTCPeerConnection } from "../../src/pc"; // Added for Test 3
import {
  RTCRtpCodecParameters,
  RTCRtpHeaderExtensionParameters,
} from "../../src/media/parameters";
import { RTCRtpSender } from "../../src/media/rtpSender";
// import { deserializeSdesRTPStreamID } from "../../src/rtp/rtp"; // Assuming this exists
// const sdesRtpStreamIdUri = RTP_EXTENSION_URI.sdesRTPStreamID; // if RTP_EXTENSION_URI is importable
