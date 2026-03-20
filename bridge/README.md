# Bridge Contracts

This folder stores protocol-level contracts shared by UI/CLI integrations.

- Transport: JSON-RPC 2.0 over Windows named pipe (`\\.\\pipe\\wincmux-rpc`)
- Framing: newline-delimited JSON messages
- Eventing: server push events reserved under `event.*` methods (MVP currently request/response only)

See `schema/jsonrpc.request.schema.json` for request shape and required fields.
