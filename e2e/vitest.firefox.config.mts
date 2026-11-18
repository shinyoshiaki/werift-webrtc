import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

import {
  sharedOptimizeDeps,
  sharedPlugins,
  sharedTest,
} from "./vitest.shared.mts";

export default defineConfig({
  plugins: sharedPlugins(),
  optimizeDeps: sharedOptimizeDeps,
  test: {
    ...sharedTest,
    // Serve the test page over IPv4. Without a camera / microphone permission
    // Firefox gathers ICE candidates only for the default local address, and it
    // looks that address up in the IP family the page was loaded over. Vite's
    // default host `localhost` listens on ::1, so the lookup goes to IPv6 and
    // fails on hosts without an IPv6 default route: "Couldn't gather ICE
    // candidates", no candidate at all, and every test times out.
    api: { host: "127.0.0.1" },
    browser: {
      provider: playwright({
        launchOptions: {
          firefoxUserPrefs: {
            "media.navigator.permission.disabled": true,
            "media.navigator.streams.fake": true,
            // Chrome's --disable-features=WebRtcHideLocalIpsWithMdns: offer
            // plain host candidates instead of mDNS .local names.
            "media.peerconnection.ice.obfuscate_host_addresses": false,
            // The e2e TURN server listens on 127.0.0.1, and Firefox does not
            // use loopback addresses for ICE (TURN error 701) without this.
            "media.peerconnection.ice.loopback": true,
          },
        },
      }),
      enabled: true,
      instances: [
        {
          browser: "firefox",
        },
      ],
    },
  },
});
