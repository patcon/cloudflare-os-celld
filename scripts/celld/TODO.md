# celld TODO

- [ ] Report or fix upstream: celld's `ctx.exports` exposes a migrated Durable Object class as a
  namespace only when the class also has a `durable_objects` binding; workerd does it for every
  migrated class. See `__ctxExports` in celld's `crates/celld/js/harness.js` (`namespaceKeys`).
  Once fixed, drop the binding workaround in `make-config.ts`.
