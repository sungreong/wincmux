# Bridge contracts

The Rust core exposes JSON-RPC 2.0 to the local Windows user running WinCMux and SYSTEM.

- Pipe: `\\.\pipe\wincmux-tauri-rpc`
- Framing: newline-delimited UTF-8 JSON.
- Events: subscribe with `session.stream.subscribe` for session output, lifecycle events, and notifications.

See [method documentation](API.md) and the [request schema](schema/jsonrpc.request.schema.json).
