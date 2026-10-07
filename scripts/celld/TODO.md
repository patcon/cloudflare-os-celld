# celld TODO

Experiment: run Cloudflare OS on [celld](https://celld.dev). Status: the backend boots under
`celld dev` and signup works; it stops at cross-isolate RPC stubs.

## 0. Review prior art

- [x] Assessed mohamedalichelbi's `portability/celld-mvp` branch (Aug 2026, against celld v0.3.0):
  https://github.com/cloudflare/cloudflare-os/compare/main...mohamedalichelbi:cloudflare-os:portability/celld-mvp
  - The final diff is only `mise.toml` tasks + `.env.example` that `celld deploy` the unmodified
    backend and router into a GCS bucket using his celld fork. An earlier KV/R2 shim was dropped.
    Little to take beyond the router + backend fleet-deploy recipe (useful for step 4).
  - The real work is in his celld fork, https://github.com/mohamedalichelbi/celld (PRs #1-#6):
    - #1, #2 WebSocket upgrades across service bindings / from Workers: covered upstream by now
      (our `/api` WebSocket connects on 0.6.1).
    - #6 nested storage transactions: upstream has an equivalent (root `_transactionSerial`).
    - **#3 "route durable object RPC targets across isolates"**: not upstream; tracked as open
      denoland/celld#174. Routes calls on a stub back to the Durable Object that owns it. He
      validated newGadget, getMetadata, newChat and sendChatMessage with it.
      Limit: stubs created outside a Durable Object (e.g. the browser subscriber passed through
      the session Worker in `subscribeConnectedAccounts`) still fail.
      Commit `2498103b`; a trial cherry-pick onto 0.6.1 (`main-patcon`) gives one conflict hunk
      in each of `js.rs`, `js/harness.js`, `main.rs`.
  - Not proposed upstream by him (no PRs from him on denoland/celld).
- [x] Port #3 onto celld 0.6.1: branch `rpc-targets-cross-isolate` on patcon/celld, versioned
  `0.6.1-rpc-targets.1` (`run-local:celld` warns when `celld --version` lacks it)
- [x] Green release build of that branch (run 37556612470, all four platforms)
- [x] Rerun `pnpm run-local:celld` with the patched binary. Creating a workspace now works
  (`overseer.open()` returns, and calls into the Overseer DO arrive), but the workspace page
  hangs at "Loading workspace…": `subscribeToMetadata` delivers the first metadata only via
  `callback(metadata)` (`overseer.ts`, `OverseerClientInterface`), and that callback is the
  browser's, forwarded through the session Worker, so it has no Durable Object owner.
  `__remoteStubOp` rejects it, and `.catch(unsubscribe)` swallows the error.
- [x] Extend the patch to stubs owned by a stateless (non-DO) isolate: route the call back to the
  isolate *and* the live request context that exported it. This is the remaining part of
  denoland/celld#174, and it's needed for every subscription (metadata, connected accounts,
  chat streaming). Done in patcon/celld `c6df64b` + `1f7076f`, released as
  `0.6.1-rpc-targets.3` (run 37561530298; `.1` and `.2` kept beside it in `~/.local/bin`):
  - A stateless owner's marker carries its heap id (`h`); `__stub_rpc_call_heap` runs the call
    as a new `WorkerJob::StubRpc` event on that isolate's slot (same pattern as the Worker
    Loader RPC op), under the exporting request's JS context. Same-node only; a gone or
    retiring isolate errors.
  - Second bug found on the way: capnweb disposes stubs passed in params when the call returns,
    relying on workerd's `rpc_params_dup_stubs` (default since 2026-01-20; the app is on
    2026-09-04). celld doesn't do that, so the Overseer got `This RpcImportHook was already
    disposed.` The lift now keeps a `dup()` of a target that has its own `dup()`.
  - Verified on `.5`: existing workspaces open (by reload or from the sidebar), and a Gemini chat
    turn completes (`agent.run.finished outcome=ok`).
  - Not yet verified: connected accounts (`subscriber.ready is not a function`), live streaming
    of text deltas, live sidebar updates after rename/delete.
- [ ] A workspace created by sending the first message from Home hangs on "Loading workspace…";
  a reload shows it. Not the subscription routing above: opening an existing workspace in the
  same session works.
- [x] `tracing` (`ctx.tracing` and `cloudflare:workers`) was missing, so every agent turn failed
  with `Cannot read properties of undefined (reading 'enterSpan')`. celld `e5878e3` adds a no-op
  API (untraced spans).
- [x] `Invalid reader mode 'byob'` on gadget creation: `readReleasePack` reads
  `new Blob([pack]).stream()` with a BYOB reader, and celld's `Blob.stream()` was a plain stream.
  celld `31456c8` (`0.6.1-rpc-targets.5`) makes it a byte stream; gadgets now get created. Packs
  received over RPC from a gatekeeper (`git-cache.ts` `consumePack`) will still fail: celld can't
  carry RPC streams across isolates yet.
- [ ] Gadget preview shows "Failed to connect gadget to server": the server throws
  `this.ctx.restore is not a function` (`getGadgetFacet`, `overseer.ts:4394`). celld had no
  persistent stubs. celld `13eb098` (`0.6.1-rpc-targets.6`, building) adds the `restore` symbol
  and a `DurableObjectState.restore(params)` that calls `[restore](params)` at once and returns
  a live stub. Still missing: storing such a stub and reviving it later (hooks), and
  `ctx.restore` on a `WorkerEntrypoint` (`RESTORE_FORGER_HARNESS`).
- Anthropic keys that aren't workspace-scoped get a 400 asking for `anthropic-workspace-id`;
  use a workspace-scoped key (unrelated to celld).
  - Note: `celld dev` self-fences with exit 3 (`SELF-FENCE: node lease not renewed`) when the
    Mac idle-sleeps; that's the lease watchdog, not this patch.

### Handoff: routing callbacks owned by a stateless isolate

Goal: a best-effort patch on patcon/celld `rpc-targets-cross-isolate` (not aiming for upstream
acceptance), offered to others. Installed locally as `celld 0.6.1-rpc-targets.1`; the previous
binary is `~/.local/bin/celld-0.6.1-main-patcon`.

Failing case: browser callback (capnweb) → session Worker (stateless isolate,
`AuthenticatedApiImpl` in `server.ts`) → Overseer DO. The DO's `callback(metadata)` rejects in
`__remoteStubOp` because the marker's scope `s` is `undefined`. Repro: `pnpm run-local:celld`,
log in as `celldtest` / `correct-horse-battery-staple`, open any workspace: it hangs at
"Loading workspace…" with no error (`.catch(unsubscribe)` in `subscribeToMetadata`).

How the existing (DO-owned) path works, in celld:
- `crates/celld/js/harness.js`: `__stubLift` writes a marker `{__celld$stub: id, t: isolate,
  c: callable, s: scope}`; `s` comes from the stub entry's `scope`, which `__newEntry` sets from
  `__currentActorScope() || undefined`, so it's `undefined` outside a DO. `__stubRevive` turns a
  marker from another isolate into `__foreignStub(s, id, c, t)`; `__remoteStubOp` calls
  `__stub_rpc_call(scope, id, pathJson, args)`. The owner side runs
  `__celld.__dispatchStubRpc(id, pathJson, args)` (a null path disposes).
- `crates/celld/js.rs`: `op_stub_rpc_call` sends a `StubRpcReq` (`host_channels.rs`) on
  `STUB_RPC_TX`; `CellJob::StubRpc` runs `__dispatchStubRpc` as a cell event.
- `crates/celld/main.rs`: `dispatch_stub_rpc` routes by cell scope through `app.request()` /
  `local_request()` into `RuntimeManager::stub_rpc` (`runtime.rs`); `Route::Remote` errors.

What's missing: an address for a *stateless* owner. Sketch:
1. When lifting in a stateless isolate, record which isolate and which live I/O context owns the
   entry (the entry already keeps `ctx`). Something like `t` plus an isolate/pool slot id and a
   context id, instead of `s`.
2. Add a second request kind (or extend `StubRpcReq` with an enum owner: `Cell(scope)` |
   `Stateless{isolate, context}`) and route it to that isolate in the stateless pool
   (`generation.rs` `service()` / `StatelessRuntime`, `pool.rs`), running `__dispatchStubRpc`
   inside the still-open request context rather than as a cell event.
3. Fail with a clear error when the context has ended (the WebSocket session closed) or the owner
   is on another node; same-node only is fine for a best-effort patch.
4. Check the reverse hop too: once the session Worker gets the call, it must forward it to the
   browser's capnweb stub, which is already same-isolate and should just work.

Verify with the repro above: the workspace should load and connected-accounts onboarding should
stop logging `subscriber.ready is not a function`. Build via
`gh workflow run release.yml -R patcon/celld --ref rpc-targets-cross-isolate` (~12 min; a second
dispatch cancels a running one; bump the `-rpc-targets.N` version in `crates/celld/Cargo.toml`
and `Cargo.lock` for each build you want to tell apart). No local Rust toolchain on this machine.
- [ ] After testing the port, post on denoland/celld#174 (update the draft with results first;
  drop or confirm the unverified code-mode guess). Draft:

  > For reference, there's a partial implementation of this in @mohamedalichelbi's fork:
  > mohamedalichelbi/celld@2498103b ("fix: route durable object RPC targets across isolates",
  > merged there as mohamedalichelbi/celld#3, against v0.3.0). It was not proposed upstream.
  >
  > It covers RPC targets owned by a Durable Object. The stub marker records the owning DO's
  > scope, and calls and disposal on the receiving side are routed back to that DO
  > (`__dispatchStubRpc`). Stubs created outside a DO, for example in a stateless Worker, still
  > throw "RPC stubs without a Durable Object owner cannot cross isolate boundaries yet." It might
  > therefore cover the code-mode case when the loader is driven from a DO, but not when it's
  > driven from a stateless Worker. I haven't verified either case.
  >
  > It came out of getting Cloudflare OS running on celld (mohamedalichelbi/cloudflare-os#1).
  > There, the session Worker gets a live workspace `RpcTarget` back from a Durable Object. On
  > 0.6.1, creating a workspace fails with `'newChat' is not a function` because that target
  > arrives as a dead marker. The commit doesn't apply cleanly to 0.6.1; there's one conflict
  > each in `js.rs`, `js/harness.js` and `main.rs`.
  >
  > 🤖 Generated with [Claude Code](https://claude.com/claude-code) (~200 words of LLM output
  > from ~60 words of human prompt)

## 1. Upstream the `ctx.exports` namespace gap

- [ ] Report or fix upstream: celld's `ctx.exports` exposes a migrated Durable Object class as a
  namespace only when the class also has a `durable_objects` binding; workerd does it for every
  migrated class. See `__ctxExports` in celld's `crates/celld/js/harness.js` (`namespaceKeys`).
- [ ] Once fixed, drop the binding workaround in `make-config.ts`.

## 2. Map how much depends on cross-isolate RPC stubs

celld throws "RPC stubs cannot cross isolate boundaries yet"; the session Worker and each Durable
Object run in separate isolates.

- [x] Signup, login, onboarding, home, blueprint listing: work
- [x] Connected accounts: subscription fails (`subscriber.ready is not a function`;
  `server.ts:374` passes the browser's stub into the user DO, `user.ts:1475`)
- [x] Create or open a workspace: fails (`'newChat' is not a function`; `overseer.open()` returns
  the workspace session RpcTarget from the Overseer DO, `server.ts:291`)
- [x] Chat, gadgets (`LOADER`), facets: unreachable, since all go through the Overseer stub
- [x] Static inventory: of 56 `AuthenticatedApi` methods, `openGadget`, `newGadget`,
  `subscribeConnectedAccounts`, `getAdminApi` and one more `RpcStub<Overseer>` method cross
  isolates; the whole `Overseer` interface (the workspace) sits behind them

Conclusion: the shell of the app works, but no workspace feature does until celld carries stubs
across isolates.

## 3. Assess cross-isolate stub support in celld

- [ ] Read how same-isolate stubs travel (`__stubLift` in `harness.js`)
- [ ] Judge whether stubs could be proxied across isolates and nodes over celld's peer RPC
- [ ] Decide: propose upstream, contribute, or stop here

## 4. Gatekeepers in fleet mode (only if 3 looks viable)

- [ ] Run a local S3 (e.g. MinIO) as the fleet bucket
- [ ] Generate celld configs for each gatekeeper with `make-config.ts`
- [ ] `celld deploy` the gatekeepers and the backend, run one node
- [ ] Exercise service bindings, gatekeeper handoff, and facets

## 5. Tooling (only if 3 looks viable)

- [x] `pnpm run-local:celld`: build the worker, generate the config, copy frontend assets, start celld
- [ ] Decide on Browser Rendering (optional export path) and Cloudflare Access replacement
