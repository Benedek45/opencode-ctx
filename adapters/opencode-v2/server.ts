// PolyForm Noncommercial License 1.0.0 — see LICENSE
//
// OpenCode V2 server-plugin entrypoint. Exactly one export: the default
// `{ id, setup }` plugin definition (what `Plugin.define()` returns).
//
// OpenCode V2 requires a configured plugin `package` path to be a DIRECTORY and
// loads its `server` module (falling back to `index`). Point the host config at
// the COMPILED adapter directory, which contains this file as `server.js`:
//
//   "plugins": [{
//     "package": "/abs/path/clean-impl/dist/adapters/opencode-v2",
//     "options": { "ctx": { ... } }
//   }]
//
// A path to this file itself is rejected by the host ("configured plugin path
// must be a directory").

import { CtxV2Plugin } from "./plugin.js";

export default CtxV2Plugin;
