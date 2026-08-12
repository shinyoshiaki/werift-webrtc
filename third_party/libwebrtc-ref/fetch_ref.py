#!/usr/bin/env python3
"""Download a curated goog_cc / AIMD / probe snapshot from webrtc.googlesource.com.

Default pin matches PIN.json (0fda1615…). Full tree clone is intentionally avoided.
"""

from __future__ import annotations

import argparse
import base64
import json
import ssl
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_COMMIT = "0fda16159e33adf59c71a7ad1173dcbe5a632102"
DEFAULT_BRANCH = "main"
REPO = "https://webrtc.googlesource.com/src"

# Curated list — keep in sync with MANIFEST.md
FILES = [
    "modules/congestion_controller/goog_cc/goog_cc_network_control.h",
    "modules/congestion_controller/goog_cc/goog_cc_network_control.cc",
    "modules/congestion_controller/goog_cc/delay_based_bwe.h",
    "modules/congestion_controller/goog_cc/delay_based_bwe.cc",
    "modules/congestion_controller/goog_cc/inter_arrival_delta.h",
    "modules/congestion_controller/goog_cc/inter_arrival_delta.cc",
    "modules/congestion_controller/goog_cc/trendline_estimator.h",
    "modules/congestion_controller/goog_cc/trendline_estimator.cc",
    "modules/congestion_controller/goog_cc/acknowledged_bitrate_estimator_interface.h",
    "modules/congestion_controller/goog_cc/acknowledged_bitrate_estimator_interface.cc",
    "modules/congestion_controller/goog_cc/acknowledged_bitrate_estimator.h",
    "modules/congestion_controller/goog_cc/acknowledged_bitrate_estimator.cc",
    "modules/congestion_controller/goog_cc/bitrate_estimator.h",
    "modules/congestion_controller/goog_cc/bitrate_estimator.cc",
    "modules/congestion_controller/goog_cc/robust_throughput_estimator.h",
    "modules/congestion_controller/goog_cc/robust_throughput_estimator.cc",
    "modules/congestion_controller/goog_cc/loss_based_bwe_v2.h",
    "modules/congestion_controller/goog_cc/loss_based_bwe_v2.cc",
    "modules/congestion_controller/goog_cc/probe_controller.h",
    "modules/congestion_controller/goog_cc/probe_controller.cc",
    "modules/congestion_controller/goog_cc/probe_bitrate_estimator.h",
    "modules/congestion_controller/goog_cc/probe_bitrate_estimator.cc",
    "modules/congestion_controller/goog_cc/send_side_bandwidth_estimation.h",
    "modules/congestion_controller/goog_cc/send_side_bandwidth_estimation.cc",
    "modules/remote_bitrate_estimator/aimd_rate_control.h",
    "modules/remote_bitrate_estimator/aimd_rate_control.cc",
    "modules/pacing/bitrate_prober.h",
    "modules/pacing/bitrate_prober.cc",
    "modules/congestion_controller/rtp/transport_feedback_adapter.h",
    "modules/congestion_controller/rtp/transport_feedback_adapter.cc",
    "modules/congestion_controller/rtp/transport_feedback_demuxer.h",
    "modules/congestion_controller/rtp/transport_feedback_demuxer.cc",
]


def fetch_one(commit: str, rel: str, dest: Path, ctx: ssl.SSLContext) -> int:
    url = f"{REPO}/+/{commit}/{rel}?format=TEXT"
    last_err: Exception | None = None
    for attempt in range(6):
        try:
            if attempt:
                time.sleep(1.5 * attempt)
            with urllib.request.urlopen(url, context=ctx, timeout=60) as resp:
                data = base64.b64decode(resp.read())
            dest.parent.mkdir(parents=True, exist_ok=True)
            dest.write_bytes(data)
            return len(data)
        except Exception as exc:  # noqa: BLE001 — retry on rate limit / net
            last_err = exc
    raise RuntimeError(f"failed {rel}: {last_err}") from last_err


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--commit",
        default=DEFAULT_COMMIT,
        help=f"git commit pin (default {DEFAULT_COMMIT[:12]}…)",
    )
    parser.add_argument(
        "--branch",
        default=DEFAULT_BRANCH,
        help="branch label stored in PIN.json only",
    )
    parser.add_argument(
        "--out",
        type=Path,
        default=Path(__file__).resolve().parent,
        help="output directory (default: this script's directory)",
    )
    args = parser.parse_args(argv)

    out: Path = args.out
    out.mkdir(parents=True, exist_ok=True)
    ctx = ssl.create_default_context()
    ok: list[str] = []
    failed: list[str] = []

    for rel in FILES:
        dest = out / rel
        try:
            size = fetch_one(args.commit, rel, dest, ctx)
            print(f"OK {rel} ({size} bytes)")
            ok.append(rel)
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL {rel}: {exc}", file=sys.stderr)
            failed.append(rel)

    pin = {
        "repository": REPO,
        "branch": args.branch,
        "commit": args.commit,
        "pinned_at": "2026-08-11",
        "files": ok,
        "failed": failed,
    }
    (out / "PIN.json").write_text(json.dumps(pin, indent=2) + "\n")
    print(f"\nWrote {out / 'PIN.json'} ({len(ok)} ok, {len(failed)} failed)")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
