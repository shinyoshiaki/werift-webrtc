// webrtc/RTCPeerConnection-ontrack.https.html
import { setTimeout } from "timers/promises";

import {
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpTransceiver,
} from "../../src";
import { RTCRtpReceiver } from "../../src/media/rtpReceiver";
import { MediaStream } from "../../src/media/track";
import { addEventListenerPromise, assert_equals, assert_true } from "../utils";

jest.setTimeout(10_000);

describe("wpt/ontrack", () => {
  it("setRemoteDescription should trigger ontrack event when the MSID of the stream is parsed.", async () => {
    const pc = new RTCPeerConnection();

    const sdp = `v=0
o=- 166855176514521964 2 IN IP4 127.0.0.1
s=-
t=0 0
a=msid-semantic:WMS *
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:someufrag
a=ice-pwd:somelongpwdwithenoughrandomness
a=fingerprint:sha-256 8C:71:B3:8D:A5:38:FD:8F:A4:2E:A2:65:6C:86:52:BC:E0:6E:94:F2:9F:7C:4D:B5:DF:AF:AA:6F:44:90:8D:F4
a=setup:actpass
a=rtcp-mux
a=mid:mid1
a=sendonly
a=rtpmap:111 opus/48000/2
a=msid:stream1 track1
a=ssrc:1001 cname:some`;

    const trackEventPromise = addEventListenerPromise(pc, "track");
    await pc.setRemoteDescription({ type: "offer", sdp });
    const trackEvent: any = await trackEventPromise;
    const { streams, track, transceiver } = trackEvent;

    assert_equals(streams.length, 1, "the track belongs to one MediaStream");

    const [stream] = streams;
    assert_equals(
      stream.id,
      "stream1",
      "Expect stream.id to be the same as specified in the a=msid line"
    );

    assert_equals(track.kind, "audio", "Expect track.kind to be audio");

    validateTrackEvent(trackEvent);

    assert_equals(
      transceiver.direction,
      "recvonly",
      "Expect transceiver.direction to be reverse of sendonly (recvonly)"
    );

    await pc.close();
  });

  it("setRemoteDescription() with m= line of recvonly direction should not trigger track event", async () => {
    const pc = new RTCPeerConnection();
    const sdp = `v=0
o=- 166855176514521964 2 IN IP4 127.0.0.1
s=-
t=0 0
a=msid-semantic:WMS *
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:someufrag
a=ice-pwd:somelongpwdwithenoughrandomness
a=fingerprint:sha-256 8C:71:B3:8D:A5:38:FD:8F:A4:2E:A2:65:6C:86:52:BC:E0:6E:94:F2:9F:7C:4D:B5:DF:AF:AA:6F:44:90:8D:F4
a=setup:actpass
a=rtcp-mux
a=mid:mid1
a=recvonly
a=rtpmap:111 opus/48000/2
a=msid:stream1 track1
a=ssrc:1001 cname:some
`;
    let called = false;
    pc.ontrack = () => {
      called = true;
    };
    await pc.setRemoteDescription({ type: "offer", sdp });
    await setTimeout(100);
    expect(called).toBeFalsy();
    pc.close();
  });

  it("addTrack() should cause remote connection to fire ontrack when setRemoteDescription()", async () => {
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();
    const [track, mediaStream] = [
      new MediaStreamTrack({ kind: "audio" }),
      new MediaStream({ id: "id" }),
    ];
    pc1.addTrack(track, mediaStream);
    const trackEventPromise = addEventListenerPromise(pc2, "track");
    await pc2.setRemoteDescription(await pc1.createOffer());
    const trackEvent: any = await trackEventPromise;
    assert_equals(
      trackEvent.track.kind,
      "audio",
      "Expect track.kind to be audio"
    );
    validateTrackEvent(trackEvent);
    await Promise.all([pc1.close(), pc2.close()]);
  });

  it("addTransceiver('video') should cause remote connection to fire ontrack when setRemoteDescription()", async () => {
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();

    pc1.addTransceiver("video");

    const trackEventPromise = addEventListenerPromise(pc2, "track");
    await pc2.setRemoteDescription(await pc1.createOffer());
    const trackEvent: any = await trackEventPromise;
    const { track } = trackEvent;

    assert_equals(track.kind, "video", "Expect track.kind to be video");

    validateTrackEvent(trackEvent);
    await Promise.all([pc1.close(), pc2.close()]);
  });

  it("addTransceiver() with inactive direction should not cause remote connection to fire ontrack when setRemoteDescription()", async () => {
    const pc1 = new RTCPeerConnection();
    const pc2 = new RTCPeerConnection();

    pc1.addTransceiver("audio", { direction: "inactive" });
    let called = false;
    pc2.ontrack = () => {
      called = true;
    };

    await pc2.setRemoteDescription(await pc1.createOffer());
    await setTimeout(100);
    expect(called).toBeFalsy();

    await Promise.all([pc1.close(), pc2.close()]);
  });

  // todo impl
  // Using offerToReceiveAudio and offerToReceiveVideo should only cause a ${type} track event to fire, if ${type} was the only type negotiated
});

function validateTrackEvent(trackEvent) {
  const { receiver, track, streams, transceiver } = trackEvent;

  assert_true(
    track instanceof MediaStreamTrack,
    "Expect track to be instance of MediaStreamTrack"
  );

  assert_true(Array.isArray(streams), "Expect streams to be an array");

  for (const mediaStream of streams) {
    assert_true(
      mediaStream instanceof MediaStream,
      "Expect elements in streams to be instance of MediaStream"
    );

    assert_true(
      mediaStream.getTracks().includes(track),
      "Expect each mediaStream to have track as one of their tracks"
    );
  }

  assert_true(
    receiver instanceof RTCRtpReceiver,
    "Expect trackEvent.receiver to be defined and is instance of RTCRtpReceiver"
  );

  assert_equals(
    receiver.track,
    track,
    "Expect trackEvent.receiver.track to be the same as trackEvent.track"
  );

  assert_true(
    transceiver instanceof RTCRtpTransceiver,
    "Expect trackEvent.transceiver to be defined and is instance of RTCRtpTransceiver"
  );

  assert_equals(
    transceiver.receiver,
    receiver,
    "Expect trackEvent.transceiver.receiver to be the same as trackEvent.receiver"
  );
}
