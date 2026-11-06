#!/bin/sh
# Launch the Playwright Chromium inside the "chrome" network namespace.
exec ip netns exec chrome "$NETNS_CHROME_BIN" "$@"
