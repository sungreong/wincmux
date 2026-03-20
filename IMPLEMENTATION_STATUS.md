# Implementation Status (MVP)

Implemented now:
- Electron desktop shell (`apps/desktop`)
- Node core engine (`packages/core`) with named pipe JSON-RPC
- Workspace/session/notification/layout handlers with SQLite storage
- `node-pty` based session runtime (ConPTY on Windows)
- Layout snapshot persistence + 3s Git polling
- Node-based CI workflow and core integration tests

Deferred to Phase 2:
- Embedded browser engine (WebView2-equivalent panel strategy)
- Advanced automation event streaming and external daemon mode
- Process supervisor hardening (job object parity and deeper orphan guarantees)

Current runtime path:
- Active: Electron + Node
- Legacy fallback: `legacy-dotnet/`
