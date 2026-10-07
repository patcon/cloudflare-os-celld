# celld TODO

Experiment: run Cloudflare OS on [celld](https://celld.dev). Status: the backend boots under
`celld dev` and signup works; it stops at cross-isolate RPC stubs.

## 0. Review prior art

- [ ] Assess what's useful in mohamedalichelbi's `portability/celld-mvp` branch:
  https://github.com/cloudflare/cloudflare-os/compare/main...mohamedalichelbi:cloudflare-os:portability/celld-mvp
  (compare with `make-config.ts`; check whether it works around cross-isolate stubs)

## 1. Upstream the `ctx.exports` namespace gap

- [ ] Report or fix upstream: celld's `ctx.exports` exposes a migrated Durable Object class as a
  namespace only when the class also has a `durable_objects` binding; workerd does it for every
  migrated class. See `__ctxExports` in celld's `crates/celld/js/harness.js` (`namespaceKeys`).
- [ ] Once fixed, drop the binding workaround in `make-config.ts`.

## 2. Map how much depends on cross-isolate RPC stubs

celld throws "RPC stubs cannot cross isolate boundaries yet"; the session Worker and each Durable
Object run in separate isolates.

- [x] Signup and login (works)
- [ ] Onboarding: connected-accounts subscription fails (`subscriber.ready is not a function`,
  `server.ts:374` → `user.ts:1475`)
- [ ] Open or create a workspace (`overseer.open()` takes a `notifyClosed` function stub and
  returns a session RpcTarget, `server.ts:291`)
- [ ] Chat in a workspace (needs a model configured)
- [ ] Gadget load via `LOADER` and facets
- [ ] Static inventory: list every session/DO method that takes or returns a stub

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

- [ ] `pnpm run-celld`: build the worker, generate the config, copy frontend assets, start celld
- [ ] Decide on Browser Rendering (optional export path) and Cloudflare Access replacement
