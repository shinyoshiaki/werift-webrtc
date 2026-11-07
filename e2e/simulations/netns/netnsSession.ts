/**
 * Shared Arrange utilities for the Chrome-side bottleneck simulation
 * (`chromeNetnsGcc.sim.ts`). Runs only inside the container prepared by
 * `in-container.sh`: werift lives in the container's network namespace,
 * Chrome in the `chrome` namespace, and `tc` on the veth `vw` shapes the
 * werift -> Chrome direction (Chrome's receive path).
 */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { type Browser, chromium, type Page } from "playwright-core";

import {
  GccBandwidthEstimator,
  MediaStreamTrack,
  RTCPeerConnection,
  RTCRtpCodecParameters,
  type RTCRtpSender,
  RtpHeader,
  RtpPacket,
  useAbsSendTime,
  usePLI,
  useTransportWideCC,
  useTWCC,
} from "../../../packages/webrtc/src";

const here = fileURLToPath(new URL(".", import.meta.url));

/** Bottleneck on Chrome's receive path. */
export type LinkShape = {
  rateKbit: number;
  /** One-way delay added before the rate limiter. */
  delayMs?: number;
  /** tbf queue size; packets beyond it are dropped. */
  limitBytes?: number;
  /** Random loss in percent (netem). */
  lossPercent?: number;
};

/** Replace the bottleneck parameters (`tc qdisc change` on `vw`). */
export function shapeLink({
  rateKbit,
  delayMs = 25,
  limitBytes = 15_000,
  lossPercent = 0,
}: LinkShape) {
  const netem = ["delay", `${delayMs}ms`];
  if (lossPercent > 0) netem.push("loss", `${lossPercent}%`);
  // `change` keeps unspecified netem options, so pass loss 0 explicitly.
  else netem.push("loss", "0%");
  execFileSync("tc", [
    ..."qdisc change dev vw root handle 1: netem".split(" "),
    ...netem,
  ]);
  execFileSync("tc", [
    ..."qdisc change dev vw parent 1: handle 2: tbf".split(" "),
    ...["rate", `${rateKbit}kbit`, "burst", "3000", "limit", `${limitBytes}`],
  ]);
}

export type Sample = {
  tMs: number;
  estimateBps: number;
  packetsReceived: number;
  packetsLost: number;
};

export type Session = {
  sender: RTCRtpSender;
  gcc: GccBandwidthEstimator;
  /**
   * Send synthetic VP8 RTP for `durationMs`: at `rateBps`, or at the GCC
   * estimate (`"follow"`, an application that adapts). Samples every second.
   */
  send: (durationMs: number, rateBps: number | "follow") => Promise<Sample[]>;
  close: () => Promise<void>;
};

/** Tiny VP8 keyframe descriptor so Chrome treats the payload as video RTP. */
const VP8_KEYFRAME_PREFIX = Buffer.from([
  0x10, 0x10, 0x00, 0x00, 0x9d, 0x01, 0x2a, 0x02, 0x00, 0x02, 0x00,
]);
const kPayloadBytes = 1000;
const kStartBitrateBps = 300_000;

/**
 * Connect werift (sendonly, GCC) to Chrome (recvonly) across the bottleneck.
 * With `rtx`, GCC can send probe padding on the RTX SSRC.
 */
export async function connectSession({
  rtx,
}: {
  rtx: boolean;
}): Promise<Session> {
  const browser = await launchChromeInNetns();
  const page = await browser.newPage();
  await page.goto("about:blank");

  const pc = new RTCPeerConnection({
    iceUseIpv4: true,
    iceUseIpv6: false,
    bundlePolicy: "max-bundle",
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: "video/VP8",
          clockRate: 90000,
          payloadType: 96,
          // No NACK: retransmission storms after congestion would hide
          // the estimator's response.
          rtcpFeedback: [usePLI(), useTWCC()],
        }),
        ...(rtx
          ? [
              new RTCRtpCodecParameters({
                mimeType: "video/rtx",
                clockRate: 90000,
                payloadType: 97,
                parameters: "apt=96",
              }),
            ]
          : []),
      ],
    },
    headerExtensions: { video: [useTransportWideCC(), useAbsSendTime()] },
  });
  const sender = pc.addTransceiver(new MediaStreamTrack({ kind: "video" }), {
    direction: "sendonly",
  }).sender;
  const gcc = new GccBandwidthEstimator(kStartBitrateBps);
  sender.setBandwidthEstimator(gcc);

  await pc.setLocalDescription(await pc.createOffer());
  const answer = await answerInChrome(page, pc.localDescription!.sdp);
  await pc.setRemoteDescription(answer);
  await pc.connectionStateChange.watch((s) => s === "connected");

  const startMs = Date.now();
  let seq = 0;
  let timestamp = 0;
  const payload = Buffer.alloc(kPayloadBytes, 0x5a);
  VP8_KEYFRAME_PREFIX.copy(payload);

  const send = async (durationMs: number, rateBps: number | "follow") => {
    const samples: Sample[] = [];
    const endMs = Date.now() + durationMs;
    let lastMs = Date.now();
    let creditBits = 0;
    let nextSampleMs = lastMs + 1_000;
    while (Date.now() < endMs) {
      const now = Date.now();
      const rate =
        rateBps === "follow"
          ? gcc.availableBitrate || kStartBitrateBps
          : rateBps;
      creditBits += ((now - lastMs) * rate) / 1000;
      lastMs = now;
      while (creditBits >= kPayloadBytes * 8) {
        creditBits -= kPayloadBytes * 8;
        void sender.sendRtp(
          new RtpPacket(
            new RtpHeader({
              sequenceNumber: seq++ & 0xffff,
              timestamp: (timestamp += 3000) >>> 0,
              payloadType: sender.codec!.payloadType,
              marker: seq % 30 === 0,
              extension: true,
              extensions: [],
              payloadOffset: 12,
            }),
            payload,
          ),
        );
      }
      if (now >= nextSampleMs) {
        nextSampleMs += 1_000;
        samples.push({
          tMs: now - startMs,
          estimateBps: gcc.availableBitrate,
          ...(await inboundStats(page)),
        });
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    return samples;
  };

  const close = async () => {
    await pc.close();
    await browser.close();
  };
  return { sender, gcc, send, close };
}

async function launchChromeInNetns(): Promise<Browser> {
  // PLAYWRIGHT_BROWSERS_PATH=/ms-playwright in the image: the bundled
  // Chromium matching e2e's playwright-core.
  process.env.NETNS_CHROME_BIN = chromium.executablePath();
  return chromium.launch({
    executablePath: join(here, "chrome-in-netns.sh"),
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--force-webrtc-ip-handling-policy=default",
    ],
  });
}

async function answerInChrome(page: Page, offerSdp: string) {
  return page.evaluate(async (sdp) => {
    const pc = new RTCPeerConnection();
    (window as unknown as { rpc: RTCPeerConnection }).rpc = pc;
    await pc.setRemoteDescription({ type: "offer", sdp });
    await pc.setLocalDescription(await pc.createAnswer());
    await new Promise<void>((resolve) => {
      if (pc.iceGatheringState === "complete") return resolve();
      pc.onicegatheringstatechange = () => {
        if (pc.iceGatheringState === "complete") resolve();
      };
    });
    return { type: "answer" as const, sdp: pc.localDescription!.sdp };
  }, offerSdp);
}

async function inboundStats(page: Page) {
  return page.evaluate(async () => {
    const pc = (window as unknown as { rpc: RTCPeerConnection }).rpc;
    let out = { packetsReceived: 0, packetsLost: 0 };
    (await pc.getStats()).forEach((r) => {
      if (r.type === "inbound-rtp") {
        const inbound = r as RTCInboundRtpStreamStats;
        out = {
          packetsReceived: inbound.packetsReceived ?? 0,
          packetsLost: inbound.packetsLost ?? 0,
        };
      }
    });
    return out;
  });
}
