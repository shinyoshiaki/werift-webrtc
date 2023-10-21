import { ChildProcess, spawn } from "child_process";
import { config } from "dotenv";
import * as google from "googleapis";
import {
  RTCPeerConnection,
  RTCRtpCodecParameters,
} from "../../packages/webrtc/src";
import { createSocket } from "dgram";

config({ path: __dirname + "/../../credential.env" });

const clientId = process.env.CLIENT_ID;
const clientSecret = process.env.CLIENT_SECRET;
const projectId = process.env.PROJECT_ID;
const deviceName = process.env.DEVICE_NAME;
const refreshToken = process.env.REFRESH_TOKEN;

async function main() {
  const udp = createSocket("udp4");

  let pathToFfmpeg = require("ffmpeg-for-homebridge");
  if (!pathToFfmpeg) pathToFfmpeg = "ffmpeg";

  const ffmpegArgs = `-analyzeduration 15000000 -probesize 100000000 -loglevel verbose -protocol_whitelist file,crypto,udp,rtp -i /Users/tpotma/Source/webrtctest/src/ffmpeg.sdp -vcodec libx264 -acodec libopus /users/tpotma/Desktop/output.mkv`;
  const ffmpegProcess: ChildProcess = spawn(
    pathToFfmpeg,
    ffmpegArgs.split(/\s+/),
    { env: process.env }
  );

  if (ffmpegProcess.stdout) {
    ffmpegProcess.stdout.on("error", (error: Error) => {
      console.log(error.message);
    });
  }
  if (ffmpegProcess.stderr) {
    ffmpegProcess.stderr.on("data", (data: any) => {
      data
        .toString()
        .split(/\n/)
        .forEach((line: string) => {
          console.log(line);
        });
    });
  }
  ffmpegProcess.on("error", (error: Error) => {
    console.log("Failed to start stream: " + error.message);
  });
  ffmpegProcess.on("exit", (code: number, signal: NodeJS.Signals) => {
    const message =
      "FFmpeg exited with code: " + code + " and signal: " + signal;

    if (code == null || code === 255) {
      if (ffmpegProcess.killed) {
        console.log(message + " (Expected)");
      } else {
        console.log(message + " (Unexpected)");
      }
    } else {
      console.log(message + " (Error)");
    }
  });

  const oauth2Client = new google.Auth.OAuth2Client(clientId, clientSecret);

  oauth2Client.setCredentials({
    refresh_token: refreshToken,
  });
  const smartdevicemanagement =
    new google.smartdevicemanagement_v1.Smartdevicemanagement({
      auth: oauth2Client,
    });

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

  const audioTransceiver = pc.addTransceiver("audio", {
    direction: "recvonly",
  });
  audioTransceiver.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      udp.send(rtp.serialize(), 33301, "127.0.0.1");
    });
  });

  const videoTransceiver = pc.addTransceiver("video", {
    direction: "recvonly",
  });
  videoTransceiver.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe((rtp) => {
      udp.send(rtp.serialize(), 33305, "127.0.0.1");
    });
    track.onReceiveRtp.once(() => {
      setInterval(
        () => videoTransceiver.receiver.sendRtcpPLI(track.ssrc!),
        2000
      );
    });
  });

  pc.createDataChannel("dataSendChannel", { id: 1 });

  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);

  console.log(offer.sdp);

  const response =
    await smartdevicemanagement.enterprises.devices.executeCommand({
      name: `enterprises/${projectId}/devices/${deviceName}`,
      requestBody: {
        command: "sdm.devices.commands.CameraLiveStream.GenerateWebRtcStream",
        params: {
          offerSdp: offer.sdp,
        },
      },
    });

  const answerSdp = (<any>response.data.results).answerSdp;

  console.log(answerSdp);

  await pc.setRemoteDescription({
    type: "answer",
    sdp: answerSdp,
  });

  console.log("answer applied");

  process.on("SIGINT", () => {
    ffmpegProcess.kill("SIGINT");
    pc.close().then(() => {
      udp.close();
    });
  });
}

main();
