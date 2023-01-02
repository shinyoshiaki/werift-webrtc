import {
  DepacketizeCallback,
  JitterBufferCallback,
  LipsyncCallback,
  PromiseQueue,
  RTCPeerConnection,
  RtcpSourceCallback,
  RtpSourceCallback,
  NtpTimeCallback,
  WebmCallback,
} from "../../../packages/webrtc/src";
import { Server } from "ws";
import { createServer } from "http";
import {
  appendFile,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "fs/promises";
import path from "path";
import { MPD } from "./mpd";

const dir = "./dash";
const dashServerPort = 8125;
const signalingServerPort = 8888;

console.log({ dir, dashServerPort, signalingServerPort });

const signalingServer = new Server({ port: signalingServerPort });
signalingServer.on("connection", async (socket) => {
  const { audio, video, audioRtcp, videoRtcp } = await recorder();

  const pc = new RTCPeerConnection();

  pc.addTransceiver("audio", { direction: "recvonly" }).onTrack.subscribe(
    (track) => {
      // 音声のRTPを受け取る
      track.onReceiveRtp.subscribe((rtp) => {
        audio.input(rtp);
      });
      track.onReceiveRtcp.subscribe((rtcp) => {
        audioRtcp.input(rtcp);
      });
    }
  );

  pc.addTransceiver("video", { direction: "recvonly" }).onTrack.subscribe(
    (track, transceiver) => {
      // 映像のRTPを受け取る
      track.onReceiveRtp.subscribe((rtp) => {
        video.input(rtp);
      });
      track.onReceiveRtcp.subscribe((rtcp) => {
        videoRtcp.input(rtcp);
      });
      // 5秒ごとにキーフレームを要求する
      setInterval(() => {
        transceiver.receiver.sendRtcpPLI(track.ssrc!);
      }, 5_000);
    }
  );

  const sdp = await pc.setLocalDescription(await pc.createOffer());
  socket.send(JSON.stringify(sdp));

  socket.on("message", (data: any) => {
    const obj = JSON.parse(data);
    if (obj.sdp) {
      console.log(new Date().toISOString(), "sRD");
      pc.setRemoteDescription(obj);
    }
  });
});

async function recorder() {
  await rm(dir, { recursive: true }).catch((e) => e);
  await mkdir(dir).catch((e) => e);

  await writeFile(dir + "/dash.mpd", mpd.build());

  const webm = new WebmCallback(
    [
      {
        kind: "audio",
        codec: "OPUS",
        clockRate: 48000,
        trackNumber: 1,
      },
      {
        width: 640,
        height: 480,
        kind: "video",
        codec: "VP8",
        clockRate: 90000,
        trackNumber: 2,
      },
    ],
    { duration: 1000 * 60 * 60 * 24, strictTimestamp: true }
  );
  const lipsync = new LipsyncCallback();

  const audio = new RtpSourceCallback();
  const video = new RtpSourceCallback();
  const audioRtcp = new RtcpSourceCallback();
  const videoRtcp = new RtcpSourceCallback();

  {
    const depacketizer = new DepacketizeCallback("opus");
    const ntpTime = new NtpTimeCallback(48000);

    audio.pipe(ntpTime.input);
    audioRtcp.pipe(ntpTime.input);

    ntpTime.pipe(depacketizer.input);
    depacketizer.pipe(lipsync.inputAudio);
    lipsync.pipeAudio(webm.inputAudio);
  }
  {
    const jitterBuffer = new JitterBufferCallback(90000);
    const depacketizer = new DepacketizeCallback("vp8", {
      isFinalPacketInSequence: (h) => h.marker,
    });
    const ntpTime = new NtpTimeCallback(90000);

    video.pipe(jitterBuffer.input);
    videoRtcp.pipe(ntpTime.input);

    jitterBuffer.pipe(ntpTime.input);
    ntpTime.pipe(depacketizer.input);
    depacketizer.pipe(lipsync.inputVideo);
    lipsync.pipeVideo(webm.inputVideo);
  }

  let timestamp = 0;
  const queue = new PromiseQueue();
  webm.pipe(async (value) => {
    queue.push(async () => {
      if (value.saveToFile && value.kind) {
        switch (value.kind) {
          case "initial":
            {
              // webmのSegmentのヘッダー部
              await writeFile(dir + "/init.webm", value.saveToFile);
            }
            break;
          case "cluster":
            {
              if (value.previousDuration! > 0) {
                // MPDにクラスターの長さを書き込む
                mpd.segmentationTimeLine.push({
                  d: value.previousDuration!,
                  t: timestamp,
                });
                await writeFile(dir + "/dash.mpd", mpd.build());
                // 一時保存していたクラスターをDASH用にリネームする
                // ファイル名はMPDで定義したとおりにする。
                await rename(
                  dir + "/cluster.webm",
                  dir + `/media${timestamp}.webm`
                );
                console.log(
                  new Date().toISOString(),
                  "cluster",
                  `media${timestamp}.webm`
                );
                timestamp += value.previousDuration!;
              }

              // クラスターを一時保存する
              await writeFile(dir + `/cluster.webm`, value.saveToFile);
            }
            break;
          case "block":
            {
              // 個々のブロックはクラスターの一時保存先に足していく
              await appendFile(dir + `/cluster.webm`, value.saveToFile);
            }
            break;
        }
      }
    });
  });

  return { audio, video, audioRtcp, videoRtcp };
}

const mpd = new MPD({
  codecs: ["vp8", "opus"],
  minBufferTime: 5,
  minimumUpdatePeriod: 1,
});

const dashServer = createServer();
dashServer.on("request", async (req, res) => {
  const filePath = dir + req.url;

  // console.log({ filePath });

  const extname = String(path.extname(filePath)).toLowerCase();
  const mimeTypes: any = {
    ".mpd": "application/dash+xml",
    ".webm": "video/webm",
  };

  if (extname === ".mpd") {
    await writeFile(dir + "/dash.mpd", mpd.build());
  }

  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Request-Method", "*");
  res.setHeader("Access-Control-Allow-Methods", "OPTIONS, GET");
  res.setHeader("Access-Control-Allow-Headers", "*");

  try {
    const file = await readFile(filePath);
    res.writeHead(200, { "Content-Type": mimeTypes[extname] });
    res.end(file);
  } catch (error) {
    res.writeHead(404);
    res.end();
  }
});
dashServer.listen(dashServerPort);
