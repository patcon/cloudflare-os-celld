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
- [ ] Extend the patch to stubs owned by a stateless (non-DO) isolate: route the call back to the
  isolate *and* the live request context that exported it. This is the remaining part of
  denoland/celld#174, and it's needed for every subscription (metadata, connected accounts,
  chat streaming).

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
