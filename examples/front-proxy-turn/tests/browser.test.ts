import { existsSync } from "node:fs";

import { chromium } from "playwright";
import { describe, expect, test } from "vitest";

import { createFrontProxyTurnExample } from "../src/server";
import { TURN_REALM } from "./fixture";

const chromiumExecutablePath = [
  process.env.CHROME_BIN,
  process.env.GOOGLE_CHROME_BIN,
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
].find((candidate) => candidate && existsSync(candidate));

describe("front-proxy-turn browser relay-only", () => {
  test("connects a relay-only DataChannel through the single TLS address", async () => {
    const app = createFrontProxyTurnExample({
      host: "127.0.0.1",
      port: 0,
      publicHost: "127.0.0.1",
      publicPort: 0,
      relayCount: 2,
      backendCount: 2,
      credentialSecret: "front-proxy-turn-browser-secret",
      realm: TURN_REALM,
    });
    await app.listen();

    const browser = await chromium.launch({
      headless: true,
      ...(chromiumExecutablePath
        ? { executablePath: chromiumExecutablePath }
        : {}),
      args: ["--ignore-certificate-errors", "--allow-insecure-localhost"],
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();

    try {
      // Act: HTTPS と同じ TLS address へ headless Chromium を開き、relay-only の PeerConnection を作る。
      await page.goto(`https://127.0.0.1:${app.port}/`, {
        waitUntil: "networkidle",
      });
      const result = await page.evaluate(async () => {
        const waitForConnection = (connection: RTCPeerConnection) => {
          if (connection.connectionState === "connected") {
            return Promise.resolve();
          }

          return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              connection.removeEventListener(
                "connectionstatechange",
                handleStateChange,
              );
              reject(
                new Error(
                  `peer connection did not connect: ${connection.connectionState}`,
                ),
              );
            }, 20_000);

            const handleStateChange = () => {
              if (connection.connectionState !== "connected") {
                return;
              }
              clearTimeout(timer);
              connection.removeEventListener(
                "connectionstatechange",
                handleStateChange,
              );
              resolve();
            };

            connection.addEventListener(
              "connectionstatechange",
              handleStateChange,
            );
          });
        };

        const waitForOpen = (channel: RTCDataChannel) => {
          if (channel.readyState === "open") {
            return Promise.resolve();
          }

          return new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => {
              channel.removeEventListener("open", handleOpen);
              reject(new Error("data channel did not open in time"));
            }, 20_000);

            const handleOpen = () => {
              clearTimeout(timer);
              channel.removeEventListener("open", handleOpen);
              resolve();
            };

            channel.addEventListener("open", handleOpen);
          });
        };

        const waitForMessage = (channel: RTCDataChannel, send: () => void) =>
          new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
              channel.removeEventListener("message", handleMessage);
              reject(new Error("timed out waiting for echoed data"));
            }, 20_000);

            const handleMessage = (event: MessageEvent<string>) => {
              clearTimeout(timer);
              channel.removeEventListener("message", handleMessage);
              resolve(event.data);
            };

            channel.addEventListener("message", handleMessage, { once: true });
            send();
          });

        const readSelectedPair = async (connection: RTCPeerConnection) => {
          const stats = await connection.getStats();
          const statsMap = stats as unknown as Map<string, RTCStats>;
          const transport = [...statsMap.values()].find(
            (stat) =>
              stat.type === "transport" &&
              typeof (stat as RTCTransportStats).selectedCandidatePairId ===
                "string",
          ) as RTCTransportStats | undefined;
          const pair =
            (transport?.selectedCandidatePairId
              ? statsMap.get(transport.selectedCandidatePairId)
              : undefined) ??
            [...statsMap.values()].find(
              (stat) =>
                stat.type === "candidate-pair" &&
                Boolean((stat as unknown as Record<string, unknown>).selected),
            );

          if (!pair || pair.type !== "candidate-pair") {
            throw new Error("selected ICE candidate pair was not found");
          }
          const selectedPair = pair as RTCIceCandidatePairStats;

          const localCandidate = selectedPair.localCandidateId
            ? statsMap.get(selectedPair.localCandidateId)
            : undefined;
          const remoteCandidate = selectedPair.remoteCandidateId
            ? statsMap.get(selectedPair.remoteCandidateId)
            : undefined;
          const readString = (
            stat: RTCStats | undefined,
            key: string,
          ): string | undefined => {
            if (!stat || !(key in stat)) {
              return undefined;
            }
            const value = (stat as unknown as Record<string, unknown>)[key];
            return typeof value === "string" ? value : undefined;
          };

          return {
            localCandidateType: readString(localCandidate, "candidateType"),
            remoteCandidateType: readString(remoteCandidate, "candidateType"),
            localRelayProtocol: readString(localCandidate, "relayProtocol"),
            remoteRelayProtocol: readString(remoteCandidate, "relayProtocol"),
          };
        };

        const credentials = await fetch("/credentials", {
          method: "POST",
        }).then((response) => response.json());
        const config = {
          iceServers: credentials.iceServers,
          iceTransportPolicy: "relay" as RTCIceTransportPolicy,
        };
        const offerer = new RTCPeerConnection(config);
        const answerer = new RTCPeerConnection(config);
        const channel = offerer.createDataChannel("front-proxy-turn");
        const answererChannel = new Promise<RTCDataChannel>((resolve) => {
          answerer.ondatachannel = ({ channel }) => {
            channel.onmessage = (event) => {
              channel.send(`echo:${event.data}`);
            };
            resolve(channel);
          };
        });

        offerer.onicecandidate = ({ candidate }) => {
          if (candidate) {
            void answerer.addIceCandidate(candidate);
          }
        };
        answerer.onicecandidate = ({ candidate }) => {
          if (candidate) {
            void offerer.addIceCandidate(candidate);
          }
        };

        await offerer.setLocalDescription(await offerer.createOffer());
        await answerer.setRemoteDescription(offerer.localDescription!);
        await answerer.setLocalDescription(await answerer.createAnswer());
        await offerer.setRemoteDescription(answerer.localDescription!);

        const openedAnswererChannel = await answererChannel;
        await Promise.all([
          waitForConnection(offerer),
          waitForConnection(answerer),
          waitForOpen(channel),
          waitForOpen(openedAnswererChannel),
        ]);
        const echo = await waitForMessage(channel, () => {
          channel.send("hello");
        });
        const [offererPair, answererPair] = await Promise.all([
          readSelectedPair(offerer),
          readSelectedPair(answerer),
        ]);

        openedAnswererChannel.close();
        channel.close();
        answerer.close();
        offerer.close();

        return {
          echo,
          turnUrl: credentials.turnUrl as string,
          offererPair,
          answererPair,
        };
      });

      // Assert: 同じ TLS address の turns URL で relay-only DataChannel が開き、選択候補も relay/relay になっている。
      expect(result.turnUrl).toBe(app.turnUrl);
      expect(result.echo).toBe("echo:hello");
      expect(result.offererPair.localCandidateType).toBe("relay");
      expect(result.offererPair.remoteCandidateType).toBe("relay");
      expect(result.answererPair.localCandidateType).toBe("relay");
      expect(result.answererPair.remoteCandidateType).toBe("relay");
      expect(result.offererPair.localRelayProtocol).toBe("tls");
    } finally {
      await context.close();
      await browser.close();
      await app.close();
    }
  });
});
