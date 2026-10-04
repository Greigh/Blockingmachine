# The Unbound reachability check, against real resolvers

The Deploy Hub's Unbound pane ends in a check whose entire claim is empirical: *a resolver
that loaded the compiled drop-in answers NXDOMAIN for a domain inside it, and that domain
still resolves on a second resolver.* Nothing in the repository established that. The 28 unit
tests in `unboundReachability.test.ts` were written by the same person who wrote the
classifier, and every answer in them is a hand-built object that agrees with the claim —
including the `nxdomain` one. A suite in which the evidence is authored next to the
assertion cannot fail in the way this can fail.

So: four genuinely configured Unbound instances, built from this project's own artifacts, on
real sockets, and the shipping code asked to classify them.

```
scripts/unbound-reachability-live.sh            # containerised, Ubuntu, Unbound 1.19.2
scripts/unbound-reachability-live.sh --native   # the same, against native Unbound on this host
```

Both exit 0. The rig leaves nothing behind.

## The four resolvers

Everything except the one line under test is held constant — same image, same `forward-zone`,
same `access-control`, same canary. A verdict that changes because the resolver was
configured differently is a verdict about the rig, not about the check.

| resolver | loaded | canary `24.eu` | control `example.com` |
|---|---|---|---|
| `ub-live` | core's drop-in | `NXDOMAIN` | `NOERROR` |
| `ub-notloaded` | nothing — served and fetched, never included | `NOERROR` (95.217.58.108) | `NOERROR` |
| `ub-cli` | the CLI's own drop-in | `NOERROR` (0.0.0.0) | `NOERROR` |
| `ub-swallow` | `local-zone: "com" always_nxdomain` | `NOERROR` (95.217.58.108) | `NXDOMAIN` |

Those two columns are `dig`, run before a line of application code exists. Everything below is
what the check made of them.

`ub-swallow` is the one that matters most. It answers `NOERROR` for the canary and `NXDOMAIN`
for the control, and no single query distinguishes it from a resolver that never loaded
anything. The check asks the control question *first*, and it is the only reason the canary
answer can be trusted.

## What the check said

| scenario | state | tone | what it claimed |
|---|---|---|---|
| `ub-live`, canary confirmed on `ub-notloaded` | `live` | ok | the drop-in is loaded and the resolver is blocking |
| `ub-live`, fetch older than the last compile | `stale` | warn | blocking is live, the copy is not |
| `ub-live`, no reference resolver | `canary-unconfirmed` | warn | NXDOMAIN with nothing to confirm the name is not a pass |
| `ub-notloaded` | `not-loaded` | warn | served and fetched, but the include never took |
| `ub-cli` | `not-loaded` | warn | **wrong — see below** |
| `ub-swallow` | `inconclusive` | warn | refuses names that should resolve |
| `127.0.0.1:1` | `resolver-unreachable` | off | the control query never came back |
| an AdGuard list served as the drop-in | `feed-invalid` | off | loads without error, blocks nothing |
| served, never queried | `unverified` | warn | no resolver has been asked |

```
live×1  stale×1  canary-unconfirmed×1  not-loaded×2  inconclusive×1
resolver-unreachable×1  feed-invalid×1  unverified×1
```

Eight of nine are what they should be. The ninth is the finding.

## Identical on two Unbound versions, seven releases apart

Run natively against **Unbound 1.26.1** and in a container against **Unbound 1.19.2**. Diffing
the two verdict sections with addresses and the ephemeral feed port normalised away leaves
nothing but millisecond timings:

```
live×1  stale×1  canary-unconfirmed×1  not-loaded×2  inconclusive×1
resolver-unreachable×1  feed-invalid×1  unverified×1
```

Every state, tone, headline, detail, next step and row value is byte-identical. Nothing in the
check depends on a version-specific behaviour, which is the one thing a two-version run can
prove that a single run cannot.

## Finding (now fixed): the project's two Unbound formatters disagreed, and the check only knew one of them

> **Resolved 2026-10-01.** The CLI's formatter now delegates to core's, so there is one
> `always_nxdomain` artifact rather than two — and `isSinkholedAnswer` in
> [unboundReachability.ts](../packages/electron-app/src/unboundReachability.ts) reads a
> NOERROR answer carrying a sinkhole address as *blocking*, so a deployment already running the
> old `redirect` artifact is reported `live` rather than `not-loaded`. The table and the quoted
> verdict below are kept as written on the day of the run: they are what the defect looked like,
> and the `cli-artifact` scenario in the rig is kept precisely so this can be re-measured.

The project shipped two Unbound artifacts and they were not the same file.

| | `local-zone` | blocking mechanism | size |
|---|---|---|---|
| core `generateFilterList(…, 'unbound')` | 110,506 | `always_nxdomain` (110,463) | 5.79 MB |
| CLI `exportFormat('unbound', …)` | 110,506 | `redirect` + `local-data "…" A 0.0.0.0` | 9.67 MB |

Both block. Neither does it the way the check expects. `always_nxdomain` answers **NXDOMAIN**;
`redirect` with a `local-data` answer of **NOERROR carrying 0.0.0.0** — the classic sinkhole
answer, which is just as effective and completely different on the wire.

The check read the second as `not-loaded`:

> The resolver is not using the drop-in
> It answered `resolves to 0.0.0.0` for 24.eu, which the file it was told to load blocks. The
> file is served correctly and was last fetched just now, so the gap is the include or the
> reload.

It is not the gap. `ub-cli` has the include, the drop-in loaded, and 110,463 domains blocked.
A user deploying the CLI's artifact is told to go and check their `include:` line and reload,
which will change nothing, and they will not learn that the file they deployed is working.

There was a second instance of the same drift on the command path, and it was worse:
`blockingmachine export -f unbound` never reached the formatter at all. `ExportCommand`'s
`switch` listed `privoxy`, `bind`, `bind-null`, `domains` and `plain`; `unbound` was not among
them, so it fell to the `default` arm, which writes the AdGuard `!` header and then the raw
rule lines verbatim:

```
! Title: Blockingmachine Filter List
…
||ads.example.com^
@@||child.parent.example^
```

`unbound-checkconf` on that file: **43 errors**, including `unknown keyword '||ads.example.com^'`.
The command reports `success: true`. The `lib/export.ts` formatter that does know Unbound is
only reached through a different entry point, so the one a user types produces nothing
loadable.

Both are open flags, not fixes — the format question is a decision about what "the Unbound
artifact" means, and it should not be settled inside a verification run.

## Finding: an address the parser accepts is an address the probe cannot use

```
unbound.lan:5335     -> host=unbound.lan  port=5335  THREW ERR_INVALID_IP_ADDRESS
::1:5353             -> host=::1:5353     port=53    answered: canary=refused control=refused
```

`dns.Resolver.setServers` takes an IP address only. `parseUnboundResolverAddress` accepts a
hostname — deliberately, with the rationale that a user pasting `unbound.lan:5335` should not
have to be told to strip it — and the `setServers` call in `queryUnboundResolver` sits
**outside** the `try`, so the throw escapes `classifyLookupFailure`, escapes
`probeUnboundResolver`, and leaves the IPC handler as an exception rather than a verdict. A
router-hosted Unbound is the single most likely thing for someone to type.

The unbracketed IPv6 case is quieter and just as wrong: `::1:5353` has four colon-separated
parts, so the `host:port` branch does not match and the whole string becomes the host with
port 53. `[::1]:5353` parses correctly. The mis-parse does not throw — it queries a host that
cannot exist and reports `refused`, which the check reports as an unreachable resolver.

Also open flags. Both are recorded in [open-flags.md](open-flags.md) 23 and 24.

## Two rig bugs worth keeping

Neither was a product defect, and both produced a confidently wrong answer, which is the
failure mode this kind of rig exists to catch.

**The readiness gate is not optional.** The first container run reported the working
deployment as `not-loaded`. The resolver had loaded a half-written 5.8 MB drop-in — a
partially-parsed file blocks some zones and not others, which is indistinguishable from a
resolver that loaded nothing. The rig now refuses to record any verdict until `ub-live`
answers NXDOMAIN for the canary, and the drop-ins are staged into the volume *before* any
resolver starts.

**The daemon cannot see the host.** Docker here runs in a Colima VM. The harness is compiled
into the repository (which the VM shares) rather than `/tmp` (which it does not), and the
drop-ins are bind-mounted in rather than read by host path — a container handed a host path
finds nothing there. Both were found by the rig failing, not by reasoning about it.

## The part that stays

`scripts/unbound-reachability-live.sh` needs a container, a 5.8 MB artifact and about four
minutes, so it is not a gate. The rig is. `packages/electron-app/src/__tests__/unboundReachabilityLive.test.ts`
is the same experiment as a suite — it reads a drop-in and resolver addresses from the
environment and skips cleanly when they are unset, so CI costs nothing and anyone with an
Unbound can run it:

```
UNBOUND_LIVE_DROPIN=… UNBOUND_LIVE_DEPLOYED=127.0.0.1:53 \
UNBOUND_LIVE_BARE=… UNBOUND_LIVE_SWALLOW=… \
  npx jest src/__tests__/unboundReachabilityLive.test.ts
```

Ten tests, all against real sockets, none of which can be satisfied by a hand-built answer.