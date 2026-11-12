/**
 * Direct werift <-> Firefox check of `a=bundle-only` offers (ticket 21a27c92).
 * Node's werift answers; a Playwright Firefox offers. No e2e server or vitest.
 *
 *   cd e2e && node --import ../tools/node-ts/register.mjs tools/firefoxBundleOnly.ts \
 *     [--policy max-bundle|balanced] [--scenario first|reoffer|restart|all]
 *
 * Scenarios (Firefox writes the non-tagged m-lines of these offers as
 * `port 0` + `a=bundle-only`, RFC 8843 §6):
 *   first    first offer, two video m-lines + DataChannel (`max-bundle`)
 *   reoffer  after `first`, Firefox adds a video and re-offers
 *   restart  after `first`, Firefox re-offers with `iceRestart`
 * Each scenario checks that werift's answer is accepted by Firefox, a
 * DataChannel message and RTP of every video flow both ways, and prints PASS /
 * FAIL (exit code 1 on any FAIL). Browser: `PLAYWRIGHT_BROWSERS_PATH` or the
 * default Playwright cache (`npx playwright install firefox`).
 */
import { parseArgs } from "node:util";

import { firefox } from "playwright-core";

import {
  MediaStreamTrack,
  RTCPeerConnection,
  RtpHeader,
  RtpPacket,
} from "../../packages/webrtc/src";

const { values } = parseArgs({
  options: {
    policy: { type: "string", default: "max-bundle" },
    scenario: { type: "string", default: "all" },
  },
});
const policy = values.policy as "max-bundle" | "balanced";
// reoffer / restart need the session `first` establishes, so `first` always runs.
const scenarios = [
  "first",
  ...(values.scenario === "all"
    ? ["reoffer", "restart"]
    : values.scenario === "first"
      ? []
      : [values.scenario!]),
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function until(what: string, check: () => boolean | Promise<boolean>) {
  for (let i = 0; i < 100; i++) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(`timeout: ${what}`);
}

async function gathered(pc: RTCPeerConnection) {
  await until(
    "werift ICE gathering",
    () => pc.iceGatheringState === "complete",
  );
}

/** Count of RTP packets each remote track received on the werift side. */
const received = new Map<string, number>();

function sendRtp(track: MediaStreamTrack, seq: number) {
  track.writeRtp(
    new RtpPacket(
      new RtpHeader({
        payloadType: 96,
        sequenceNumber: seq,
        timestamp: seq * 3000,
        ssrc: 1000,
      }),
      Buffer.alloc(100),
    ),
  );
}

async function main() {
  const browser = await firefox.launch({
    headless: true,
    firefoxUserPrefs: {
      "media.peerconnection.ice.obfuscate_host_addresses": false,
      "media.peerconnection.ice.loopback": true,
    },
  });
  const page = await browser.newPage();
  await page.evaluate(
    ([bundlePolicy]) => {
      const w = window as any;
      w.pc = new RTCPeerConnection({ bundlePolicy });
      w.messages = [];
      w.addVideo = () => {
        const canvas = document.createElement("canvas");
        canvas.width = 64;
        canvas.height = 64;
        const ctx = canvas.getContext("2d")!;
        setInterval(() => {
          ctx.fillStyle = `hsl(${Date.now() % 360},50%,50%)`;
          ctx.fillRect(0, 0, 64, 64);
        }, 50);
        const [track] = (canvas as any).captureStream(20).getVideoTracks();
        w.pc.addTransceiver(track, { direction: "sendrecv" });
      };
      w.offer = async (iceRestart: boolean) => {
        await w.pc.setLocalDescription(await w.pc.createOffer({ iceRestart }));
        while (w.pc.iceGatheringState !== "complete") {
          await new Promise((r) => setTimeout(r, 50));
        }
        return w.pc.localDescription.sdp as string;
      };
      w.inboundVideoPackets = async () => {
        const stats = await w.pc.getStats();
        const counts: number[] = [];
        stats.forEach((s: any) => {
          if (s.type === "inbound-rtp" && s.kind === "video") {
            counts.push(s.packetsReceived);
          }
        });
        return counts;
      };
    },
    [policy],
  );

  const pc = new RTCPeerConnection();
  const sendTracks: MediaStreamTrack[] = [];
  pc.onTrack.subscribe((track) => {
    track.onReceiveRtp.subscribe(() => {
      received.set(track.uuid, (received.get(track.uuid) ?? 0) + 1);
    });
  });
  const channelMessages: string[] = [];
  pc.onDataChannel.subscribe((channel) => {
    channel.onMessage.subscribe((m) => channelMessages.push(String(m)));
  });
  let seq = 0;
  const pump = setInterval(() => {
    for (const track of sendTracks) sendRtp(track, seq);
    seq++;
  }, 20);

  /** Firefox offers, werift answers; returns the offer SDP and answer SDP. */
  async function exchange(iceRestart: boolean) {
    const offer: string = await page.evaluate(
      (restart) => (window as any).offer(restart),
      iceRestart,
    );
    await pc.setRemoteDescription({ type: "offer", sdp: offer });
    for (const t of pc.getTransceivers()) {
      if (!sendTracks.some((s) => s === t.sender.track)) {
        const track = new MediaStreamTrack({ kind: t.kind });
        await t.sender.replaceTrack(track);
        t.direction = "sendrecv";
        sendTracks.push(track);
      }
    }
    await pc.setLocalDescription(await pc.createAnswer());
    await gathered(pc);
    const answer = pc.localDescription!.sdp;
    await page.evaluate(
      (sdp) => (window as any).pc.setRemoteDescription({ type: "answer", sdp }),
      answer,
    );
    return { offer, answer };
  }

  async function verify(name: string, offer: string, answer: string) {
    const failures: string[] = [];
    const bundleOnly = (offer.match(/^a=bundle-only/gm) ?? []).length;
    if (name === "first" && policy === "max-bundle" && bundleOnly === 0) {
      failures.push("offer had no a=bundle-only (scenario not exercised)");
    }
    const sections = answer.split(/(?=^m=)/m).slice(1);
    for (const s of sections) {
      if (!/^c=/m.test(s) && !/^c=/m.test(answer.split(/(?=^m=)/m)[0])) {
        failures.push(`answer m-line without c=: ${s.split("\r\n")[0]}`);
      }
    }
    await until("Firefox connected", async () =>
      page.evaluate(() => (window as any).pc.connectionState === "connected"),
    ).catch(() => failures.push("Firefox did not reach connected"));
    await until(
      "werift connected",
      () => pc.connectionState === "connected",
    ).catch(() => failures.push("werift did not reach connected"));

    // DataChannel, Firefox -> werift and werift -> Firefox.
    const before = channelMessages.length;
    await page.evaluate((label) => {
      const w = window as any;
      w.channel ??= w.pc.createDataChannel("probe");
      const send = () => w.channel.send(label);
      if (w.channel.readyState === "open") send();
      else w.channel.addEventListener("open", send, { once: true });
    }, name);
    await until(
      "DataChannel Firefox -> werift",
      () => channelMessages.length > before,
    ).catch(() => failures.push("DataChannel did not reach werift"));

    // RTP of every video, both ways.
    const snapshot = new Map(received);
    const ffBefore: number[] = await page.evaluate(() =>
      (window as any).inboundVideoPackets(),
    );
    await sleep(2000);
    const videos = pc.getTransceivers().filter((t) => t.kind === "video");
    for (const t of videos) {
      const id = t.receiver.track.uuid;
      if ((received.get(id) ?? 0) <= (snapshot.get(id) ?? 0)) {
        failures.push(`no RTP Firefox -> werift on mid ${t.mid}`);
      }
    }
    const ffAfter: number[] = await page.evaluate(() =>
      (window as any).inboundVideoPackets(),
    );
    if (
      ffAfter.length < videos.length ||
      ffAfter.some((n, i) => n <= (ffBefore[i] ?? 0))
    ) {
      failures.push(
        `no RTP werift -> Firefox on every video (${ffBefore} -> ${ffAfter})`,
      );
    }
    console.log(`${failures.length ? "FAIL" : "PASS"} ${policy}/${name}`);
    for (const f of failures) console.log(`  - ${f}`);
    return failures.length === 0;
  }

  let ok = true;
  try {
    for (const name of scenarios) {
      if (name === "first") {
        await page.evaluate(() => {
          const w = window as any;
          w.addVideo();
          w.addVideo();
          w.channel = w.pc.createDataChannel("probe");
        });
      } else if (name === "reoffer") {
        await page.evaluate(() => (window as any).addVideo());
      }
      const { offer, answer } = await exchange(name === "restart");
      ok = (await verify(name, offer, answer)) && ok;
    }
  } finally {
    clearInterval(pump);
    await pc.close();
    await browser.close();
  }
  process.exit(ok ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
