import { config } from "dotenv";
import * as google from "googleapis";
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from "../../packages/webrtc/src";
import { MediaRecorder } from "../../packages/webrtc/src/nonstandard";

config({ path: __dirname + "/../../credential.env" });

const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const projectId = process.env.PROJECT_ID;
const refreshToken = process.env.REFRESH_TOKEN;

const oauth2Client = new google.Auth.OAuth2Client(clientId, clientSecret);

oauth2Client.setCredentials({
  refresh_token: refreshToken,
});
const smartdevicemanagement =
  new google.smartdevicemanagement_v1.Smartdevicemanagement({
    auth: oauth2Client,
  });

console.log("start");

async function main() {
  const response = await smartdevicemanagement.enterprises.devices.list({
    parent: `enterprises/${projectId}`,
  });

  for (const device of response.data.devices || []) {
    await session(device);
  }
}

const session = async (
  device: google.smartdevicemanagement_v1.Schema$GoogleHomeEnterpriseSdmV1Device,
) => {
  {
    const pc = new RTCPeerConnection({
      bundlePolicy: "max-bundle",
      codecs: {
        audio: [
          new RTCRtpCodecParameters({
            mimeType: "audio/opus",
            clockRate: 48000,
            channels: 2,
          }),
        ],
        video: [
          new RTCRtpCodecParameters({
            mimeType: "video/H264",
            clockRate: 90000,
            rtcpFeedback: [
              { type: "transport-cc" },
              { type: "ccm", parameter: "fir" },
              { type: "nack" },
              { type: "nack", parameter: "pli" },
              { type: "goog-remb" },
            ],
            parameters:
              "level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f",
          }),
        ],
      },
    });
    const recorder = new MediaRecorder({
      path: `./${device.name.split("/").at(-1)}.webm`,
      numOfTracks: 2,
    });

    const audioTransceiver = pc.addTransceiver("audio", {
      direction: "recvonly",
    });
    audioTransceiver.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((rtp) => {
        console.log("audio", rtp.header.sequenceNumber);
      });
      recorder.addTrack(track);
    });

    const videoTransceiver = pc.addTransceiver("video", {
      direction: "recvonly",
    });
    videoTransceiver.onTrack.subscribe((track) => {
      track.onReceiveRtp.subscribe((rtp) => {
        console.log("video", rtp.header.sequenceNumber);
      });
      track.onReceiveRtp.once(() => {
        setInterval(
          () => videoTransceiver.receiver.sendRtcpPLI(track.ssrc!),
          2000,
        );
      });
      recorder.addTrack(track);
    });

    pc.createDataChannel("dataSendChannel", { id: 1 });

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    console.log(offer.sdp);

    const response =
      await smartdevicemanagement.enterprises.devices.executeCommand({
        name: device.name,
        requestBody: {
          command: "sdm.devices.commands.CameraLiveStream.GenerateWebRtcStream",
          params: {
            offerSdp: offer.sdp,
          },
        },
      });

    const answerSdp = response.data.results.answerSdp;

    console.log(answerSdp);

    await pc.setRemoteDescription({
      type: "answer",
      sdp: answerSdp,
    });

    console.log("answer applied");

    process.on("SIGINT", async () => {
      pc.close();
      await recorder.stop();
    });
  }
};

main();
