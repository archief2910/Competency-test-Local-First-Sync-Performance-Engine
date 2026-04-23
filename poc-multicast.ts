#!/usr/bin/env node
/**
 * Summer of Bitcoin 2026 · Nostream · Project 1 (Local-First Sync & Performance Engine)
 * Competency Test — standalone Node.js dgram multicast PoC.
 *
 * What this program proves
 * ------------------------
 *  1. A Node.js process can join the Nostr-over-multicast group 239.19.88.1:9797
 *     with Notedeck-compatible wire framing (`u32 BE length || UTF-8 JSON`) and
 *     receive + parse its own broadcasts (--role=loopback).
 *  2. Two Node.js processes on the same LAN exchange framed Nostr events with
 *     zero shared state (--role=sender + --role=receiver).
 *  3. The framing, bounded seen-id cache, and maintenance rejoin scheduler that
 *     this PoC exercises are the exact three primitives the production
 *     MulticastAdapter in proposal Section 8.5 will use.
 *
 * Non-goals
 * ---------
 *  - Real Nostr signature verification .
 *  - Cross-machine NAT traversal (multicast is link-local by TTL=1 — on purpose).
 *  - Fragmentation of oversized frames (UDP datagrams > 65 KB are rejected at
 *    frame encode time so the test stays deterministic).
 *
 * References
 * ----------
 *  - Notedeck multicast.rs (group, port, framing): https://github.com/damus-io/notedeck
 *  - RFC 5771 (239.0.0.0/8 administratively-scoped IPv4):
 *      https://www.rfc-editor.org/rfc/rfc5771
 *  - Proposal Section 8.2 (this PoC) and Section 8.5 (production port).
 *
 * Usage
 * -----
 *   tsx poc-multicast.ts --help
 *   tsx poc-multicast.ts --selftest
 *   tsx poc-multicast.ts --role=loopback
 *   tsx poc-multicast.ts --role=sender   [--interval-ms=1000] [--count=10]
 *   tsx poc-multicast.ts --role=receiver [--deadline-ms=0]
 *
 * Exit codes
 * ----------
 *   0  success (round-trip verified, count reached, or SIGINT after success)
 *   1  runtime failure (socket error, timeout, parse error in strict mode)
 *   2  usage error (unknown flag, unknown role, malformed argument)
 *
 * @author Aryan Gautam <archief117@gmail.com>  (https://github.com/archief2910)
 * @license MIT
 */

import { createSocket, type RemoteInfo, type Socket } from 'node:dgram'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { parseArgs } from 'node:util'
import { strict as assert } from 'node:assert'

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 1 · Wire constants 
// ═══════════════════════════════════════════════════════════════════════════════

const DEFAULT_GROUP = '239.19.88.1' // administratively-scoped IPv4 (RFC 5771)
const DEFAULT_PORT = 9797 // Notedeck `multicast.rs`
const DEFAULT_TTL = 1 // link-local only
const REJOIN_INTERVAL_MS = 200_000 // Notedeck rejoins every 200 s
const FRAME_HEADER_BYTES = 4 // u32 BE length prefix
const MAX_UDP_PAYLOAD = 65_507 // 2**16 - 1 - 8-byte UDP header
const MAX_FRAME_BYTES = MAX_UDP_PAYLOAD // strict upper bound enforced on send AND recv
const DEFAULT_LOOPBACK_DEADLINE_MS = 3_000
const DEFAULT_SENDER_INTERVAL_MS = 1_000
const DEFAULT_SEEN_CACHE_CAPACITY = 10_000

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 2 · Exit codes (single source of truth — main() is the only process.exit site)
// ═══════════════════════════════════════════════════════════════════════════════

const ExitCode = {
  Success: 0,
  RuntimeFailure: 1,
  UsageError: 2,
} as const
type ExitCode = (typeof ExitCode)[keyof typeof ExitCode]

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 3 · Types
// ═══════════════════════════════════════════════════════════════════════════════

/** Nostr event shape (NIP-01). `sig` is a placeholder in this PoC — see module docstring. */
interface NostrEvent {
  id: string
  pubkey: string
  created_at: number
  kind: number
  tags: string[][]
  content: string
  sig: string
}

type Role = 'sender' | 'receiver' | 'loopback' | 'selftest'

interface Config {
  readonly role: Role
  readonly group: string
  readonly port: number
  readonly ttl: number
  readonly sessionTag: string
  readonly intervalMs: number
  readonly count: number // 0 = infinite (sender role)
  readonly deadlineMs: number // 0 = infinite (receiver role); always finite (loopback)
  readonly strict: boolean
  readonly json: boolean
  readonly seenCacheCapacity: number
}

interface Logger {
  info(event: string, detail?: Readonly<Record<string, unknown>>): void
  warn(event: string, detail?: Readonly<Record<string, unknown>>): void
  error(event: string, detail?: Readonly<Record<string, unknown>>): void
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 4 · Pure functions (framing, event construction, validation)
//              — exercised by --selftest; no IO, no side effects
// ═══════════════════════════════════════════════════════════════════════════════

/** Encode a Nostr event as `u32 BE length || UTF-8 JSON`. */
function frameEvent(event: NostrEvent): Buffer {
  const json = Buffer.from(JSON.stringify(event), 'utf8')
  const total = FRAME_HEADER_BYTES + json.length
  if (total > MAX_FRAME_BYTES) {
    throw new FrameError(
      `frame too large (${total} B > UDP max ${MAX_FRAME_BYTES} B); ` +
        `real transports fragment, this PoC refuses to keep tests deterministic`,
    )
  }
  const out = Buffer.alloc(total)
  out.writeUInt32BE(json.length, 0)
  json.copy(out, FRAME_HEADER_BYTES)
  return out
}

/** Decode a framed event. Throws `FrameError` for any violation of the wire contract. */
function unframe(buf: Buffer): NostrEvent {
  if (buf.length < FRAME_HEADER_BYTES) {
    throw new FrameError(`frame shorter than ${FRAME_HEADER_BYTES}-byte length prefix`)
  }
  const length = buf.readUInt32BE(0)
  if (length > MAX_FRAME_BYTES - FRAME_HEADER_BYTES) {
    // Defense against malicious / buggy peers claiming a giant payload.
    throw new FrameError(`declared length ${length} B exceeds MAX_FRAME_BYTES`)
  }
  if (buf.length < FRAME_HEADER_BYTES + length) {
    throw new FrameError(
      `frame truncated: header says ${length} B, got ${buf.length - FRAME_HEADER_BYTES} B`,
    )
  }
  const jsonBytes = buf.subarray(FRAME_HEADER_BYTES, FRAME_HEADER_BYTES + length)
  let parsed: unknown
  try {
    parsed = JSON.parse(jsonBytes.toString('utf8'))
  } catch (err) {
    throw new FrameError(`JSON parse failed: ${(err as Error).message}`)
  }
  return validateNostrEvent(parsed)
}

/** Runtime shape check — guards against trusting arbitrary JSON from the wire. */
function validateNostrEvent(value: unknown): NostrEvent {
  if (value === null || typeof value !== 'object') {
    throw new FrameError('event is not an object')
  }
  const v = value as Record<string, unknown>
  const requireHexString = (field: string, length: number): string => {
    const x = v[field]
    if (typeof x !== 'string' || x.length !== length || !/^[0-9a-f]+$/i.test(x)) {
      throw new FrameError(`event.${field} must be ${length}-char lowercase hex`)
    }
    return x
  }
  const requireInt = (field: string): number => {
    const x = v[field]
    if (typeof x !== 'number' || !Number.isInteger(x) || x < 0) {
      throw new FrameError(`event.${field} must be a non-negative integer`)
    }
    return x
  }
  if (!Array.isArray(v.tags)) throw new FrameError('event.tags must be an array')
  if (typeof v.content !== 'string') throw new FrameError('event.content must be a string')
  return {
    id: requireHexString('id', 64),
    pubkey: requireHexString('pubkey', 64),
    created_at: requireInt('created_at'),
    kind: requireInt('kind'),
    tags: v.tags as string[][],
    content: v.content,
    sig: requireHexString('sig', 128),
  }
}

/** Generate a dummy but validly-shaped Nostr event, tagged with the run's session id. */
function makeDummyEvent(sessionTag: string, extraContent = ''): NostrEvent {
  const pubkey = randomBytes(32).toString('hex')
  const created_at = Math.floor(Date.now() / 1000)
  const kind = 1
  const content = `SoB 2026 - Nostream P1 competency test${extraContent ? ` - ${extraContent}` : ''}`
  const tags: string[][] = [
    ['s', sessionTag], // session id — used by loopback/receiver to filter concurrent runs
    ['t', 'sob2026'],
    ['t', 'nostream'],
  ]
  // NIP-01 canonical id: sha256 over JSON.stringify([0,pubkey,created_at,kind,tags,content])
  const serialized = JSON.stringify([0, pubkey, created_at, kind, tags, content])
  const id = createHash('sha256').update(serialized).digest('hex')
  // Placeholder sig — this is a competency test, not signature validation.
  const sig = randomBytes(64).toString('hex')
  return { id, pubkey, created_at, kind, tags, content, sig }
}

/** Return session tag if present, else `null`. */
function sessionTagOf(event: NostrEvent): string | null {
  for (const tag of event.tags) if (tag[0] === 's' && typeof tag[1] === 'string') return tag[1]
  return null
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 5 · SeenIdCache  (bounded, FIFO eviction)
//            This is the loop-prevention primitive promised in proposal FR-5.
//            A real deployment would use LFU with a last-accessed tie-breaker;
//            for the PoC a bounded insertion-ordered Set is a faithful model
//            of the contract.
// ═══════════════════════════════════════════════════════════════════════════════

class SeenIdCache {
  readonly #capacity: number
  readonly #ids: Set<string> = new Set()

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity <= 0) {
      throw new RangeError(`SeenIdCache capacity must be a positive integer, got ${capacity}`)
    }
    this.#capacity = capacity
  }

  /** Returns `true` if the id is new (and records it); `false` if it was already seen. */
  observe(id: string): boolean {
    if (this.#ids.has(id)) return false
    this.#ids.add(id)
    if (this.#ids.size > this.#capacity) {
      // Set preserves insertion order — drop the oldest (FIFO).
      const oldest = this.#ids.values().next().value
      if (oldest !== undefined) this.#ids.delete(oldest)
    }
    return true
  }

  get size(): number {
    return this.#ids.size
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 6 · Typed errors  (make failure modes grep-able in logs)
// ═══════════════════════════════════════════════════════════════════════════════

class FrameError extends Error {
  override readonly name = 'FrameError'
}

class UsageError extends Error {
  override readonly name = 'UsageError'
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 7 · Logger  (human + JSON modes; never interleaved with stderr events)
// ═══════════════════════════════════════════════════════════════════════════════

function makeLogger(json: boolean): Logger {
  if (json) {
    const emit = (level: 'info' | 'warn' | 'error', event: string, detail?: object) => {
      const rec = { ts: new Date().toISOString(), level, event, ...detail }
      const line = JSON.stringify(rec)
      if (level === 'error') process.stderr.write(`${line}\n`)
      else process.stdout.write(`${line}\n`)
    }
    return {
      info: (e, d) => emit('info', e, d),
      warn: (e, d) => emit('warn', e, d),
      error: (e, d) => emit('error', e, d),
    }
  }
  const fmt = (d?: object): string =>
    d === undefined
      ? ''
      : `  ${Object.entries(d)
          .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
          .join('  ')}`
  return {
    info: (e, d) => process.stdout.write(`[${e}]${fmt(d)}\n`),
    warn: (e, d) => process.stderr.write(`[warn ${e}]${fmt(d)}\n`),
    error: (e, d) => process.stderr.write(`[error ${e}]${fmt(d)}\n`),
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 8 · MulticastTransport  (socket lifecycle, rejoin timer, dedup, stats)
// ═══════════════════════════════════════════════════════════════════════════════

interface TransportStats {
  sent: number
  received: number
  droppedMalformed: number
  droppedDuplicate: number
  droppedOtherSession: number
  bytesSent: number
  bytesReceived: number
}

class MulticastTransport {
  readonly #config: Config
  readonly #logger: Logger
  readonly #seen: SeenIdCache
  readonly #socket: Socket
  readonly #stats: TransportStats = {
    sent: 0,
    received: 0,
    droppedMalformed: 0,
    droppedDuplicate: 0,
    droppedOtherSession: 0,
    bytesSent: 0,
    bytesReceived: 0,
  }
  #rejoinTimer: NodeJS.Timeout | null = null
  #closed = false

  constructor(config: Config, logger: Logger) {
    this.#config = config
    this.#logger = logger
    this.#seen = new SeenIdCache(config.seenCacheCapacity)
    this.#socket = createSocket({ type: 'udp4', reuseAddr: true })
  }

  get stats(): Readonly<TransportStats> {
    return this.#stats
  }

  /** Bind, join the group, and start the rejoin maintenance loop. */
  async bindAndJoin(onEvent: (event: NostrEvent, rinfo: RemoteInfo) => void): Promise<void> {
    const { group, port, ttl } = this.#config
    this.#socket.on('error', (err) => {
      this.#logger.error('socket.error', { message: err.message })
    })
    this.#socket.on('message', (buf, rinfo) => this.#onRawMessage(buf, rinfo, onEvent))

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => reject(err)
      this.#socket.once('error', onError)
      this.#socket.bind(port, () => {
        try {
          this.#socket.setMulticastTTL(ttl)
          this.#socket.setMulticastLoopback(true) // required for loopback role; no-op for receiver
          this.#socket.addMembership(group)
          this.#socket.off('error', onError)
          this.#logger.info('bind.ok', { group, port, ttl })
          resolve()
        } catch (err) {
          reject(err as Error)
        }
      })
    })

    // Notedeck-parity rejoin every 200 s — defends against router IGMP-state drops.
    this.#rejoinTimer = setInterval(() => this.#rejoin(), REJOIN_INTERVAL_MS)
    this.#rejoinTimer.unref()
  }

  /** Send one framed event to the group. Resolves when the OS accepts the frame. */
  send(event: NostrEvent): Promise<number> {
    const buf = frameEvent(event)
    return new Promise<number>((resolve, reject) => {
      this.#socket.send(buf, this.#config.port, this.#config.group, (err) => {
        if (err) return reject(err)
        this.#stats.sent += 1
        this.#stats.bytesSent += buf.length
        resolve(buf.length)
      })
    })
  }

  /** Gracefully close the socket — idempotent. */
  close(): void {
    if (this.#closed) return
    this.#closed = true
    if (this.#rejoinTimer !== null) {
      clearInterval(this.#rejoinTimer)
      this.#rejoinTimer = null
    }
    try {
      this.#socket.dropMembership(this.#config.group)
    } catch {
      /* already left — ignore */
    }
    try {
      this.#socket.close()
    } catch {
      /* already closed — ignore */
    }
  }

  // ── private ──────────────────────────────────────────────────────────────────

  #rejoin(): void {
    if (this.#closed) return
    try {
      this.#socket.dropMembership(this.#config.group)
      this.#socket.addMembership(this.#config.group)
      this.#logger.info('rejoin.ok', { group: this.#config.group })
    } catch (err) {
      this.#logger.warn('rejoin.fail', { message: (err as Error).message })
    }
  }

  #onRawMessage(
    buf: Buffer,
    rinfo: RemoteInfo,
    onEvent: (event: NostrEvent, rinfo: RemoteInfo) => void,
  ): void {
    this.#stats.bytesReceived += buf.length
    let event: NostrEvent
    try {
      event = unframe(buf)
    } catch (err) {
      this.#stats.droppedMalformed += 1
      this.#logger.warn('recv.malformed', {
        from: `${rinfo.address}:${rinfo.port}`,
        reason: (err as Error).message,
      })
      return
    }
    // Session filter: in loopback / receiver roles we only want events from THIS run
    // unless --strict=false allows cross-session reception. This matters because the
    // multicast group is world-readable on the LAN and a concurrent Notedeck client
    // would otherwise flood our output.
    const peerTag = sessionTagOf(event)
    if (this.#config.strict && peerTag !== this.#config.sessionTag) {
      this.#stats.droppedOtherSession += 1
      return
    }
    // Loop prevention (proposal FR-5) — same event id must not be delivered twice
    // to the downstream handler even if multicast delivered it twice.
    if (!this.#seen.observe(event.id)) {
      this.#stats.droppedDuplicate += 1
      return
    }
    this.#stats.received += 1
    onEvent(event, rinfo)
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 9 · Role runners
// ═══════════════════════════════════════════════════════════════════════════════

async function runLoopback(
  transport: MulticastTransport,
  config: Config,
  logger: Logger,
  signal: AbortSignal,
): Promise<ExitCode> {
  return new Promise<ExitCode>((resolve) => {
    let expectedId: string | null = null
    let settled = false
    const deadline = setTimeout(() => {
      if (settled) return
      settled = true
      logger.error('loopback.timeout', {
        deadlineMs: config.deadlineMs,
        hint: 'firewall blocking udp/9797, no active NIC, or port conflict',
      })
      resolve(ExitCode.RuntimeFailure)
    }, config.deadlineMs)
    deadline.unref()

    signal.addEventListener(
      'abort',
      () => {
        if (settled) return
        settled = true
        clearTimeout(deadline)
        resolve(ExitCode.RuntimeFailure)
      },
      { once: true },
    )

    transport
      .bindAndJoin((event, rinfo) => {
        if (event.id !== expectedId || settled) return
        settled = true
        clearTimeout(deadline)
        logger.info('loopback.ok', {
          from: `${rinfo.address}:${rinfo.port}`,
          id: event.id,
          pubkey: `${event.pubkey.slice(0, 16)}…${event.pubkey.slice(-8)}`,
          kind: event.kind,
          tags: event.tags,
          content: event.content,
        })
        resolve(ExitCode.Success)
      })
      .then(async () => {
        const event = makeDummyEvent(config.sessionTag, 'loopback')
        expectedId = event.id
        try {
          const bytes = await transport.send(event)
          logger.info('loopback.sent', { id: event.id, bytes })
        } catch (err) {
          settled = true
          clearTimeout(deadline)
          logger.error('loopback.send.fail', { message: (err as Error).message })
          resolve(ExitCode.RuntimeFailure)
        }
      })
      .catch((err: Error) => {
        settled = true
        clearTimeout(deadline)
        logger.error('loopback.bind.fail', { message: err.message })
        resolve(ExitCode.RuntimeFailure)
      })
  })
}

async function runSender(
  transport: MulticastTransport,
  config: Config,
  logger: Logger,
  signal: AbortSignal,
): Promise<ExitCode> {
  // Sender does NOT need to bind to the group to send — a default ephemeral port is fine.
  // But we bind anyway so stats (bytesReceived from any replies) stay coherent.
  await transport.bindAndJoin((event, rinfo) => {
    logger.info('recv', {
      from: `${rinfo.address}:${rinfo.port}`,
      id: event.id.slice(0, 16),
      kind: event.kind,
    })
  })

  logger.info('sender.start', { intervalMs: config.intervalMs, count: config.count || 'infinite' })

  let emitted = 0
  return new Promise<ExitCode>((resolve) => {
    const tick = async (): Promise<void> => {
      if (signal.aborted) return
      if (config.count > 0 && emitted >= config.count) {
        logger.info('sender.done', { emitted, stats: transport.stats })
        resolve(ExitCode.Success)
        return
      }
      const event = makeDummyEvent(config.sessionTag, `seq=${emitted + 1}`)
      try {
        const bytes = await transport.send(event)
        emitted += 1
        logger.info('send', { seq: emitted, id: event.id.slice(0, 16), bytes })
      } catch (err) {
        logger.error('send.fail', { message: (err as Error).message })
      }
    }

    const interval = setInterval(() => {
      void tick()
    }, config.intervalMs)
    interval.unref()
    signal.addEventListener(
      'abort',
      () => {
        clearInterval(interval)
        logger.info('sender.abort', { emitted, stats: transport.stats })
        resolve(ExitCode.Success)
      },
      { once: true },
    )
    void tick() // emit the first one immediately
  })
}

async function runReceiver(
  transport: MulticastTransport,
  config: Config,
  logger: Logger,
  signal: AbortSignal,
): Promise<ExitCode> {
  await transport.bindAndJoin((event, rinfo) => {
    logger.info('recv', {
      from: `${rinfo.address}:${rinfo.port}`,
      id: event.id.slice(0, 16),
      kind: event.kind,
      tags: event.tags,
      content: event.content,
    })
  })

  logger.info('receiver.ready', { deadlineMs: config.deadlineMs || 'infinite' })

  return new Promise<ExitCode>((resolve) => {
    const cleanup = () => {
      logger.info('receiver.done', { stats: transport.stats })
      resolve(ExitCode.Success)
    }
    if (config.deadlineMs > 0) {
      const t = setTimeout(cleanup, config.deadlineMs)
      t.unref()
    }
    signal.addEventListener('abort', cleanup, { once: true })
  })
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 10 · Self-test  (runs pure-function assertions; no socket needed)
//                          Proves correctness without a Mocha/Jest harness.
// ═══════════════════════════════════════════════════════════════════════════════

function runSelftest(logger: Logger): ExitCode {
  const cases: Array<[string, () => void]> = [
    [
      'frameEvent / unframe round-trip preserves every NIP-01 field',
      () => {
        const original = makeDummyEvent('test-session')
        const buf = frameEvent(original)
        const roundtrip = unframe(buf)
        assert.deepEqual(roundtrip, original)
      },
    ],
    [
      'frameEvent writes u32 BE length prefix',
      () => {
        const e = makeDummyEvent('test-session')
        const buf = frameEvent(e)
        assert.equal(buf.readUInt32BE(0), buf.length - FRAME_HEADER_BYTES)
      },
    ],
    [
      'unframe rejects frames shorter than the length prefix',
      () => {
        assert.throws(() => unframe(Buffer.alloc(2)), FrameError)
      },
    ],
    [
      'unframe rejects a declared length that exceeds MAX_FRAME_BYTES',
      () => {
        const hostile = Buffer.alloc(8)
        hostile.writeUInt32BE(MAX_FRAME_BYTES + 1, 0)
        assert.throws(() => unframe(hostile), FrameError)
      },
    ],
    [
      'unframe rejects a truncated payload',
      () => {
        const e = makeDummyEvent('test-session')
        const good = frameEvent(e)
        const truncated = good.subarray(0, good.length - 10)
        assert.throws(() => unframe(truncated), FrameError)
      },
    ],
    [
      'unframe rejects a non-object JSON payload',
      () => {
        const bad = Buffer.from(JSON.stringify(42), 'utf8')
        const out = Buffer.alloc(FRAME_HEADER_BYTES + bad.length)
        out.writeUInt32BE(bad.length, 0)
        bad.copy(out, FRAME_HEADER_BYTES)
        assert.throws(() => unframe(out), FrameError)
      },
    ],
    [
      'validateNostrEvent rejects a missing id',
      () => {
        assert.throws(() => validateNostrEvent({ pubkey: 'x' }), FrameError)
      },
    ],
    [
      'validateNostrEvent rejects an id that is not 64 hex chars',
      () => {
        const e = { ...makeDummyEvent('t'), id: 'not-hex' } as unknown
        assert.throws(() => validateNostrEvent(e), FrameError)
      },
    ],
    [
      'SeenIdCache.observe returns false on repeat, true on first sight',
      () => {
        const c = new SeenIdCache(2)
        assert.equal(c.observe('a'), true)
        assert.equal(c.observe('a'), false)
        assert.equal(c.observe('b'), true)
        assert.equal(c.size, 2)
      },
    ],
    [
      'SeenIdCache evicts the oldest entry when capacity is exceeded (FIFO)',
      () => {
        const c = new SeenIdCache(2)
        c.observe('a')
        c.observe('b')
        c.observe('c') // size was 2, now 3, FIFO-evicts 'a' → cache holds {b, c}
        assert.equal(c.size, 2)
        // 'b' and 'c' must still read as seen — observing them is side-effect free.
        assert.equal(c.observe('b'), false)
        assert.equal(c.observe('c'), false)
        // 'a' was evicted, so it reads as new.
        assert.equal(c.observe('a'), true)
      },
    ],
    [
      'SeenIdCache rejects non-positive capacity',
      () => {
        assert.throws(() => new SeenIdCache(0), RangeError)
        assert.throws(() => new SeenIdCache(-1), RangeError)
        assert.throws(() => new SeenIdCache(1.5), RangeError)
      },
    ],
    [
      'makeDummyEvent embeds the provided session tag',
      () => {
        const e = makeDummyEvent('my-session')
        assert.equal(sessionTagOf(e), 'my-session')
      },
    ],
    [
      'makeDummyEvent produces a NIP-01-canonical event id',
      () => {
        const e = makeDummyEvent('test-session')
        const serialized = JSON.stringify([0, e.pubkey, e.created_at, e.kind, e.tags, e.content])
        const expected = createHash('sha256').update(serialized).digest('hex')
        assert.equal(e.id, expected)
      },
    ],
  ]

  let passed = 0
  let failed = 0
  for (const [name, fn] of cases) {
    try {
      fn()
      logger.info('selftest.pass', { name })
      passed += 1
    } catch (err) {
      logger.error('selftest.fail', { name, reason: (err as Error).message })
      failed += 1
    }
  }

  logger.info('selftest.summary', { passed, failed, total: cases.length })
  return failed === 0 ? ExitCode.Success : ExitCode.RuntimeFailure
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 11 · CLI parsing
// ═══════════════════════════════════════════════════════════════════════════════

function printHelp(): void {
  process.stdout.write(
    [
      'poc-multicast — SoB 2026 · Nostream · Project 1 competency test',
      '',
      'USAGE',
      '  tsx poc-multicast.ts [OPTIONS]',
      '',
      'OPTIONS',
      '  --role=<loopback|sender|receiver|selftest>   default: loopback',
      '  --group=<ipv4>             multicast group (default 239.19.88.1)',
      '  --port=<1..65535>          multicast port  (default 9797)',
      '  --ttl=<0..255>             multicast TTL   (default 1)',
      '  --session-tag=<string>     filter own session (default: random UUID v4)',
      '  --interval-ms=<int>        sender: ms between broadcasts (default 1000)',
      '  --count=<int>              sender: max events to emit (default 0 = infinite)',
      '  --deadline-ms=<int>        loopback: timeout (default 3000); receiver: 0 = infinite',
      '  --seen-cache=<int>         loop-prevention cache capacity (default 10000)',
      '  --strict=<bool>            filter frames not tagged with our session (default true)',
      '  --json                     emit one JSON object per log line (default: human)',
      '  --help                     this message',
      '',
      'EXIT CODES',
      '  0  success    1  runtime failure    2  usage error',
      '',
    ].join('\n'),
  )
}

function parseBool(name: string, value: string): boolean {
  if (value === 'true' || value === '1' || value === 'yes') return true
  if (value === 'false' || value === '0' || value === 'no') return false
  throw new UsageError(`--${name} must be true|false, got "${value}"`)
}

function parsePositiveInt(name: string, value: string, allowZero = false): number {
  const n = Number(value)
  if (!Number.isInteger(n) || (allowZero ? n < 0 : n <= 0)) {
    throw new UsageError(`--${name} must be a ${allowZero ? 'non-negative' : 'positive'} integer`)
  }
  return n
}

function parseConfig(argv: readonly string[]): Config | 'help' {
  const parsed = parseArgs({
    args: [...argv],
    options: {
      role: { type: 'string', default: 'loopback' },
      group: { type: 'string', default: DEFAULT_GROUP },
      port: { type: 'string', default: String(DEFAULT_PORT) },
      ttl: { type: 'string', default: String(DEFAULT_TTL) },
      'session-tag': { type: 'string' },
      'interval-ms': { type: 'string', default: String(DEFAULT_SENDER_INTERVAL_MS) },
      count: { type: 'string', default: '0' },
      'deadline-ms': { type: 'string' },
      'seen-cache': { type: 'string', default: String(DEFAULT_SEEN_CACHE_CAPACITY) },
      strict: { type: 'string', default: 'true' },
      json: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false },
    },
    strict: true,
    allowPositionals: false,
  })
  if (parsed.values.help) return 'help'

  const role = parsed.values.role as string
  if (role !== 'loopback' && role !== 'sender' && role !== 'receiver' && role !== 'selftest') {
    throw new UsageError(`--role must be loopback|sender|receiver|selftest, got "${role}"`)
  }

  const port = parsePositiveInt('port', parsed.values.port as string)
  if (port > 65535) throw new UsageError('--port must be <= 65535')
  const ttl = parsePositiveInt('ttl', parsed.values.ttl as string, true)
  if (ttl > 255) throw new UsageError('--ttl must be <= 255')

  const loopbackDefault = DEFAULT_LOOPBACK_DEADLINE_MS
  const deadlineMs =
    parsed.values['deadline-ms'] === undefined
      ? role === 'loopback'
        ? loopbackDefault
        : 0
      : parsePositiveInt('deadline-ms', parsed.values['deadline-ms'] as string, true)

  return {
    role,
    group: parsed.values.group as string,
    port,
    ttl,
    sessionTag: (parsed.values['session-tag'] as string | undefined) ?? randomUUID(),
    intervalMs: parsePositiveInt('interval-ms', parsed.values['interval-ms'] as string),
    count: parsePositiveInt('count', parsed.values.count as string, true),
    deadlineMs,
    seenCacheCapacity: parsePositiveInt('seen-cache', parsed.values['seen-cache'] as string),
    strict: parseBool('strict', parsed.values.strict as string),
    json: parsed.values.json as boolean,
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 12 · main  (single exit path — every branch resolves to an ExitCode)
// ═══════════════════════════════════════════════════════════════════════════════

async function main(argv: readonly string[]): Promise<ExitCode> {
  let config: Config
  try {
    const parsed = parseConfig(argv)
    if (parsed === 'help') {
      printHelp()
      return ExitCode.Success
    }
    config = parsed
  } catch (err) {
    if (err instanceof UsageError) {
      process.stderr.write(`[usage] ${err.message}\n`)
      printHelp()
      return ExitCode.UsageError
    }
    throw err
  }

  const logger = makeLogger(config.json)
  logger.info('main.start', {
    role: config.role,
    group: config.group,
    port: config.port,
    ttl: config.ttl,
    sessionTag: config.sessionTag,
    pid: process.pid,
    node: process.version,
  })

  if (config.role === 'selftest') {
    return runSelftest(logger)
  }

  const transport = new MulticastTransport(config, logger)
  const abort = new AbortController()

  const onSignal = (signame: NodeJS.Signals) => {
    logger.info('signal', { signame, stats: transport.stats })
    abort.abort()
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    let code: ExitCode
    if (config.role === 'loopback') {
      code = await runLoopback(transport, config, logger, abort.signal)
    } else if (config.role === 'sender') {
      code = await runSender(transport, config, logger, abort.signal)
    } else {
      code = await runReceiver(transport, config, logger, abort.signal)
    }
    return code
  } catch (err) {
    logger.error('main.uncaught', { message: (err as Error).message })
    return ExitCode.RuntimeFailure
  } finally {
    transport.close()
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// SECTION 13 · Entry point
// ═══════════════════════════════════════════════════════════════════════════════

main(process.argv.slice(2))
  .then((code) => {
    process.exit(code)
  })
  .catch((err: unknown) => {
    process.stderr.write(
      `[fatal] ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    )
    process.exit(ExitCode.RuntimeFailure)
  })
