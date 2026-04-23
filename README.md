# nostream-multicast-poc

**Summer of Bitcoin 2026 · Nostream · Project 1 (Local-First Sync & Performance Engine) — Competency Test**

A standalone Node.js program that uses the built-in [`dgram`](https://nodejs.org/api/dgram.html) module to join the Nostr-over-multicast group `239.19.88.1:9797`, broadcast a dummy Nostr event as a JSON payload over UDP, and **receive and parse its own broadcast** — with byte-level framing compatibility with [Notedeck](https://github.com/damus-io/notedeck)'s `multicast.rs`.

Candidate: **Aryan Gautam** ([@archief2910](https://github.com/archief2910))
Mentor: Ricardo Arturo Cabral · Project: *Local-First Sync & Performance Engine*

---

## 1. Description

> - Set up a local Nostream development environment.
> - Write a standalone Node.js script using the `dgram` module that binds to a multicast group, broadcasts a dummy Nostr event as a JSON payload over UDP, and successfully receives and parses its own broadcast.

This repo is my answer to the second bullet. The first bullet (local Nostream dev environment) is documented in Section 6 — *Nostream Dev Environment Proof* — below.

---

## 2. Why this script matters for the proposal

The proposal (*Local-First Sync & Performance Engine*) promises a production multicast transport layer inside Nostream that reaches **byte-level parity with Notedeck's [`multicast.rs`](https://github.com/damus-io/notedeck)**:

- Group: `239.19.88.1` (administratively scoped IPv4, RFC 5771)
- Port: `9797`
- Framing: `u32 BE length || UTF-8 JSON` (no preamble, no magic)
- TTL: `1` (link-local only — multicast frames must never leave the LAN)
- Rejoin cadence: 200 s (exercised by `MulticastTransport.#rejoin` — matches Notedeck)

This PoC demonstrates, in a single ~600-line strict-TypeScript file, that **every one of those invariants is reproducible in Node.js** before Week 1 of the coding period. That de-risks the transport-layer PoC promised in proposal Section 8.2.

---

## 3. Prerequisites

- **Node.js ≥ 20** (tested on v22.16.0)
- A machine with at least one active network interface (multicast on loopback-only machines is flaky on Windows; the script will emit a clear diagnostic if join fails)
- On Windows, *Windows Defender Firewall* may block inbound UDP on Private networks — if the loopback round-trip times out, see Section 8 — *Troubleshooting*

No runtime dependencies. Everything (framing, Nostr event construction, validation, bounded seen-id cache, loopback verification, rejoin scheduler, structured logging, CLI parsing) is in-tree and uses only Node built-ins: `node:dgram`, `node:crypto`, `node:util.parseArgs`, `node:assert`.

---

## 4. How to run

```bash
# install the dev runner (tsx) and typecheck toolchain
npm install

# pure-function self-test (13 assertions; no socket required)
npm run selftest

# single-process end-to-end: bind -> send -> self-receive -> parse -> exit 0
npm run loopback

# composite: typecheck + selftest + loopback
npm test

# help / all CLI flags
npm run help

# two-process mode (two terminals on the same LAN):
#   terminal A: npm run receiver
#   terminal B: npm run sender
```

Full CLI surface (`--help`):

```
OPTIONS
  --role=<loopback|sender|receiver|selftest>   default: loopback
  --group=<ipv4>             multicast group  (default 239.19.88.1)
  --port=<1..65535>          multicast port   (default 9797)
  --ttl=<0..255>             multicast TTL    (default 1)
  --session-tag=<string>     filter own session (default: random UUID v4)
  --interval-ms=<int>        sender: ms between broadcasts (default 1000)
  --count=<int>              sender: max events to emit (default 0 = infinite)
  --deadline-ms=<int>        loopback: timeout (default 3000); receiver: 0 = infinite
  --seen-cache=<int>         loop-prevention cache capacity (default 10000)
  --strict=<bool>            filter frames not tagged with our session (default true)
  --json                     emit one JSON object per log line (default: human)
  --help                     this message
```

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Success (round-trip verified / count reached / SIGINT after success) |
| `1` | Runtime failure (socket error, loopback timeout, parse error in strict mode) |
| `2` | Usage error (unknown flag, malformed argument) |

---

## 5. Evidence (captured from real runs on my machine)

Four artefacts are committed under [`results/`](./results/). Each was produced by running the real script; none are hand-crafted.

| File | What it proves | How to regenerate |
|---|---|---|
| [`results/selftest-run.txt`](./results/selftest-run.txt) | 13/13 pure-function assertions pass (framing, validation, SeenIdCache FIFO eviction, NIP-01 event-id canonicalisation). | `npm run selftest > results/selftest-run.txt 2>&1` |
| [`results/loopback-run.txt`](./results/loopback-run.txt) | A single process binds the group, sends one framed event, receives its own broadcast, parses it, exits 0. | `npm run loopback > results/loopback-run.txt 2>&1` |
| [`results/two-process-run.txt`](./results/two-process-run.txt) | A **sender** process and a **receiver** process (different PIDs) exchange five framed events with matching IDs and byte totals, zero drops. | `pwsh scripts/capture-two-process.ps1` (Windows) or `bash scripts/capture-two-process.sh` (Linux/macOS/WSL) |
| [`results/nostream-tests.txt`](./results/nostream-tests.txt) | The full [cameri/nostream](https://github.com/cameri/nostream) unit suite passes on my clone  | `cd ../../nostream && npx mocha 'test/**/*.spec.ts' > competency-test/results/nostream-tests.txt 2>&1` |
| [`results/demo-session.txt`](./results/demo-session.txt) | A single recorded session that runs typecheck + selftest + loopback + two-process end-to-end. Readable top-to-bottom; no terminal required. | `pwsh scripts/record-demo.ps1` (Windows) or `bash scripts/record-demo.sh` (Linux/macOS/WSL — also produces `results/demo.cast` if [asciinema](https://asciinema.org) is installed) |

Headline numbers from [`results/two-process-run.txt`](./results/two-process-run.txt):

```
sender:    sent=5    bytesSent=2215
receiver:  received=5  bytesReceived=2215  droppedMalformed=0  droppedDuplicate=0  droppedOtherSession=0
```

All five event IDs observed by the receiver match (in order) the IDs printed by the sender — full bytes-in equals bytes-out.

---

## 6. Nostream dev environment proof 

To satisfy the "set up a local Nostream development environment" bullet I installed the project, ran its full unit suite, and contributed four merged-scope PRs against the upstream repository before writing this PoC:

| Contribution | Upstream issue | Closing PR |
|---|---|---|
| Hot-path PostgreSQL indexes + benchmark harness | [cameri/nostream#68](https://github.com/cameri/nostream/issues/68) | [cameri/nostream#534](https://github.com/cameri/nostream/pull/534) |
| I2P sidecar support (docker-compose overlay + scripts) | [cameri/nostream#35](https://github.com/cameri/nostream/issues/35) | [cameri/nostream#499](https://github.com/cameri/nostream/pull/499) |
| NIP-05 verification (spam-reduction layer) | [cameri/nostream#261](https://github.com/cameri/nostream/issues/261) | [cameri/nostream#463](https://github.com/cameri/nostream/pull/463) |
| NIP-03 OpenTimestamps binary parser + strategy dispatch | [cameri/nostream#105](https://github.com/cameri/nostream/issues/105) | [cameri/nostream#515](https://github.com/cameri/nostream/pull/515) |

Reproducing the dev environment from a clean clone:

```bash
git clone https://github.com/cameri/nostream.git
cd nostream
nvm use                          # uses .nvmrc
npm install
npm run db:migrate               # if running against a real Postgres
npx mocha 'test/**/*.spec.ts'    # 1037 tests pass on main
npm run build:check              # tsc --noEmit passes
```

The captured run of `npx mocha 'test/**/*.spec.ts'` on this machine is saved under [`results/nostream-tests.txt`](./results/nostream-tests.txt) — **1037 passing**.

---

## 7. Architecture 

```
poc-multicast.ts
├── Section  1  wire constants   (group, port, TTL, frame limits)
├── Section  2  exit codes        (single source of truth; only main() calls process.exit)
├── Section  3  types             (NostrEvent, Role, Config, Logger, TransportStats)
├── Section  4  pure functions    (frameEvent, unframe, validateNostrEvent,
│                                  makeDummyEvent, sessionTagOf)  <- covered by --selftest
├── Section  5  SeenIdCache       (bounded FIFO, proves proposal FR-5 primitive)
├── Section  6  typed errors      (FrameError, UsageError)
├── Section  7  Logger            (human + --json modes; stderr vs stdout separation)
├── Section  8  MulticastTransport(bind, join, send, 200 s rejoin, dedup, stats)
├── Section  9  Role runners      (loopback, sender, receiver)  <- async; honour AbortSignal
├── Section 10  runSelftest       (13 pure-function assertions, no socket needed)
├── Section 11  CLI parsing       (node:util.parseArgs, strict:true)
├── Section 12  main              (single exit path; every branch returns ExitCode)
└── Section 13  entry point       (unhandled-rejection guard; converts code -> process.exit)
```
---

## 8. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `[loopback.timeout]  deadlineMs=3000` | Firewall blocks inbound UDP to port 9797 | Windows: *Defender Firewall → Advanced → Inbound → New Rule → UDP → 9797 → Allow*. Linux: `sudo ufw allow 9797/udp`. |
| `EADDRINUSE` on bind | Another process holds `udp/9797` | `lsof -i UDP:9797` (Linux/macOS) or `netstat -ano -p udp \| findstr 9797` (Windows) — stop it, or run with `--port=9898`. |
| `EADDRNOTAVAIL` on `addMembership` | No NIC has multicast capability (common in VMs / some CI) | Run on a machine with at least one real NIC, or Docker with `--network=host`. |
| `[warn recv.malformed]  reason=declared length ... exceeds MAX_FRAME_BYTES` | Another sender on the group uses different framing | Either pick a different group (`--group=239.19.88.2`) or run with `--strict=false` to observe without filtering. |

---

## 9. Design trade-offs 

- **Why 239.19.88.1?** Chosen by Notedeck for Nostr-over-LAN gossip. The `239.0.0.0/8` block is RFC 5771 *administratively-scoped* — safe to use without a global allocation.
- **Why `u32 BE` length?** Matches Notedeck exactly. A smaller prefix (`u16`) would cap payloads at 65 KB; `u32` leaves headroom for future non-event wire types (e.g. NIP-77 NEG-MSG fragments) without a framing revision.
- **Why `setMulticastLoopback(true)`?** Required so the sending process can also receive its own frames on the same socket — this is how loopback-mode verification works on both Linux and Windows. Setting explicitly is portable.
- **Why `reuseAddr: true`?** Lets multiple Nostream instances on the same host (for integration tests) bind the same `udp/9797` without one winning the race.
- **Why FIFO instead of LFU for `SeenIdCache`?** For the PoC, the cache's *contract* (bounded + reject-duplicates) is what's being proven, not the replacement policy. The production `MulticastAdapter` will swap FIFO for LFU with a last-accessed tiebreaker (proposal Section 8.5); changing it is a ~20-line patch to this class with no caller-visible surface change.
- **Why session filtering?** The multicast group is world-readable on the LAN. Without filtering, two concurrent PoC runs (or a concurrent Notedeck client) would pollute each other's output. A UUID v4 per run is a zero-config fix.
- **Why no CBOR / protobuf?** Proposal NFR-3 (*Interoperability*) makes byte-parity with Notedeck a hard requirement. Transport-format experiments are explicitly post-SoB work.

---

## 10. Mapping to the proposal

| Concern in proposal | Where this PoC covers it |
|---|---|
| Section 6.1 — *Method Validation, Expected Outcome #2* | This whole file |
| Section 8.2 — *Phase 2 (Week 2) PoC 1 — `dgram` multicast competency* | This whole file |
| Section 8.5 — *Phase 5 (Weeks 6–8) Multicast Transport Layer* | Prefigures the production `MulticastAdapter`; framing, constants, session-id tag, rejoin cadence, and `SeenIdCache` carry over verbatim |
| FR-4 — `u32 BE length \|\| UTF-8 JSON(event)` | `frameEvent()` / `unframe()` + encoded in the `--selftest` round-trip assertion |
| FR-5 — loop prevention via bounded seen-id cache | `SeenIdCache` + two of the 13 selftests |
| NFR-3 — Notedeck byte-parity | Wire constants in Section 1 of the script; header evidence in `results/two-process-run.txt` |

---

## 11. License

MIT — see `LICENSE`.

---

## 12. Contact

**Aryan Gautam** — B.Tech Electronics & Communication Engineering, IIIT Allahabad
- Email: [archief117@gmail.com](mailto:archief117@gmail.com)
- Phone: +91 91314 22020
- GitHub: [@archief2910](https://github.com/archief2910)
- LinkedIn: [aryan-gautam-51a4a3253](https://www.linkedin.com/in/aryan-gautam-51a4a3253/)
