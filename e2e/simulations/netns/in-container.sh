#!/bin/sh
# Runs inside the privileged container started by run-netns-sim.js.
# Chrome gets its own network namespace connected by a veth pair; the
# bottleneck (netem delay + tbf rate) shapes only werift -> Chrome traffic.
set -eu

ip netns add chrome
ip link add vw type veth peer name vc
ip link set vc netns chrome
ip addr add 10.77.0.1/24 dev vw
ip link set vw up
ip netns exec chrome ip addr add 10.77.0.2/24 dev vc
ip netns exec chrome ip link set vc up
ip netns exec chrome ip link set lo up
# Scenarios replace these parameters with `tc qdisc change`.
tc qdisc add dev vw root handle 1: netem delay 25ms
tc qdisc add dev vw parent 1: handle 2: tbf rate 1000kbit burst 3000 limit 15000

exec node --disable-warning=ExperimentalWarning \
  --disable-warning=MODULE_TYPELESS_PACKAGE_JSON \
  --import ../tools/node-ts/register.mjs \
  --test --test-concurrency=1 \
  simulations/netns/chromeNetnsGcc.sim.ts
