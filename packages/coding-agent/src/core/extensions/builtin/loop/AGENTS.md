# builtin/loop

Fork-only builtin extension porting Claude Code's `/loop`: recurring (fixed-interval)
and self-paced (dynamic) scheduled prompts inside one session. A loop re-delivers a
prompt or a loop-file sentinel on a cadence; dynamic loops pick their own next delay
through the `schedule_wakeup` tool. Everything ships in this directory plus one
registration line in `builtin/index.ts`.

## FILES

```
loop/
├── index.ts        # Extension entry: real timers, store wiring, tick dispatch, lifecycle
├── command.ts      # /loop command registration: routes parsed invocations to the scheduler
├── types.ts        # Single type home: LoopState, CronEntry, lifecycle, payloads, sentinels
├── store.ts        # Atomic versioned per-session sidecar (temp file + rename, fail closed)
├── parse.ts        # Pure /loop argument grammar (subcommands, interval forms, prompt)
├── cron-planner.ts # normalizeInterval / describeCron / computeNextFireAt (pure)
├── loopfile.ts     # Loop-file resolution + content fingerprint (injected fs)
├── tick-prompt.ts  # buildTickMessage: sentinel expansion, full-vs-reminder decision (pure)
├── tools.ts        # schedule_wakeup: the only model-callable surface (flat TypeBox schema)
├── scheduler.ts    # Pure state machine: arm/fire/settle/pause/resume/stop/suspend/restore
└── status.ts       # Footer presenter: formatLoopStatus + 1s LoopStatusTicker
```

## PURITY SEAM

`scheduler.ts`, `parse.ts`, `cron-planner.ts`, `tick-prompt.ts`, and `status.ts`
(formatting) are pure. The scheduler never calls `Date.now` or `setTimeout`: a
`LoopClock` supplies `now` and a `LoopTimerPort` owns the single armed timeout per loop,
both injected by `index.ts`. `loopfile.ts` takes an injected `fs`/`path`/`cwd` bundle.
Only `index.ts` and `store.ts` touch the real world (timers, disk, extension events,
message dispatch). Every scheduling invariant is therefore testable with a fake clock and
zero real waiting. `types.ts` is the canonical type home; other modules re-export from it
rather than redeclaring.

## PERSISTENCE

`store.ts` mirrors the goal store's discipline: one sidecar file per session, strict
`version: 1` validation, atomic write via temp file + rename, and a promise tail
serializing every mutation so command, timer, tool, and lifecycle writes cannot
interleave. It FAILS CLOSED: unparseable or wrong-version state returns a typed error,
arms nothing, and never silently resets. Session custom entries are deliberately not the
authoritative store (a globally scanned "latest" entry can come from an abandoned
branch); the `loop-tick` entry exists only for attribution and noop folding.

## SCHEDULING INVARIANTS

- Coalescing: at most ONE queued or running tick per loop. A fire that lands while one
  is in flight sets `coalescedFirePending` instead of enqueuing a second delivery, so a
  sleeping laptop or a long turn never produces a tick storm. `nextFireAt` is always
  recomputed from `now`, never from the stale due time, so missed occurrences collapse
  into exactly one catch-up tick.
- 5-loop cap: at most `MAX_ACTIVE_LOOPS` (5) active loops per session; a further
  creation returns a typed rejection and leaves existing loops armed.
- Max-ticks valve: each loop carries a dispatched-tick budget (`DEFAULT_MAX_TICKS`,
  2000); exhausting it ends the loop with `tick_budget_exhausted` so a forgotten fast
  loop cannot spend without bound.
- Expiry: loops live at most 7 days from `createdAt`, checked at arm, fire, re-entry,
  and restore; a new wakeup never extends it.
- Keepalive: a two-strike device on dynamic loops only. When an attributed dynamic
  iteration ends without calling `schedule_wakeup`, the first omission burns one
  keepalive credit and arms a fallback wakeup (`SENPI_LOOP_KEEPALIVE_SECONDS`, default
  1200s, clamped 60-3600); the second consecutive omission ends the loop with
  `keepalive_exhausted`. Keepalive never applies after an ordinary user turn, and a user
  abort PAUSES the loop rather than ending it or counting as an omission.
- Provider/turn errors are never terminal for a loop.

## TICK DELIVERY

A tick never steers. When the session is idle, `index.ts` dispatches through
`sendUserMessage` with `expandPromptTemplates: true` so a slash payload reaches the real
command path; a busy session receives the tick as a follow-up. Sentinel payloads (the
four `<<...>>` loop/loop-file forms) follow a cache-friendly full-vs-reminder rule: the
long instruction block is delivered once as an anchor, and later ticks send a short
reminder pointing back at that anchored delivery, keeping the cached message prefix
stable. A changed loop-file fingerprint (content hash from `loopfile.ts`) re-anchors
with a fresh full delivery. Verbatim `prompt` payloads are always sent as-is.

## LIFECYCLE

Shutdown SUSPENDS, it never terminates: every senpi shutdown reason
(`quit|reload|new|resume|fork`) leaves the session resumable, so `onShutdown` cancels
timers, disposes the status ticker, and persists the snapshot without a terminal reason.
There is deliberately no `session_closed` end reason in `LoopEndReason`; the terminal
reasons are exactly `stopped | keepalive_exhausted | expired | tick_budget_exhausted |
error`. `restore` re-arms suspended loops on the next session start, re-checking expiry.
A store failure is not swallowed: affected loops end with `error` and the user is told,
because a schedule that cannot be persisted must not keep running.

## MODEL SURFACE

`schedule_wakeup` (`tools.ts`) is the only model-callable surface. Its TypeBox schema is
a flat object with no root union (several provider conversions rebuild schemas from
top-level `properties`, so a root `anyOf` would arrive empty; same reasoning as
`terminal/tools/monitor.ts`), and `delaySeconds` carries no schema bounds because the
executor clamps out-of-range integers (60-3600s) instead of rejecting them. All effects
go through an injected scheduler port; the tool mutates no state directly.
