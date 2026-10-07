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
- [ ] Get a green release build of that branch (`gh workflow run release.yml -R patcon/celld
  --ref rpc-targets-cross-isolate`), install its binary, and rerun `pnpm run-local:celld`
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
