# Agent lifecycle improvements

## Existing behavior

The Rust core owns each ConPTY and already survives UI exit. `Conversation` reads OSC 7501 and terminal patterns. It treats output silence as `unknown`, not completion. Reminders notify a person; they never write to a terminal. Saved Codex and Claude conversations can be resumed manually after a core restart.

## Implementation sequence

1. **Signals and status.** Give each live PTY a random session binding, inherited by its child. Accept bounded Codex/Claude hook metadata through the current-user core pipe. Map prompt submission, permission request, turn stop, and failed turn to the existing agent states. A hook-confirmed turn boundary wins over display patterns; a fresh session or absent hook continues to use OSC/pattern detection. Keep terminal process status separate from agent turn status.
2. **Hook health.** Expose each pane's hook receipt count, last event, and last receipt time. A configured hook is not reported healthy until an event reaches the core. Reject unknown events, mismatched session bindings and malformed payloads. Keep content such as prompts, tool inputs and assistant replies out of the signal envelope. Document opt-in hook setup and how to verify it without modifying user-owned agent configuration automatically.
3. **Follow-up input.** Add an explicit, per-session scheduled prompt with an independent setting from quota reminders. Bind it to a session UUID and provider. At delivery, require a hook-observed idle turn and the same live agent process; recheck immediately before submit. Persist a claim before input and never replay an uncertain delivery. Expose pause, cancel, and delivery result. Do not treat an ordinary shell, an inferred idle pattern, or a stale hook as safe for unattended input.
4. **Verification.** Unit-test status precedence and hook receipt health. Exercise the hook client against a real core with a fake agent. Test that a running, blocked, exited or replaced session never receives a scheduled prompt; test successful one-shot delivery and crash/uncertain-delivery deduplication. Run lint, Rust tests and the existing runtime integration tests.

## Boundaries

No automatic edits to `~/.codex/config.toml` or Claude settings. No automatic follow-up from an existing quota reminder. Existing manual terminal input and conversation resume keep their current behavior.

## Open-source checks

- [wmux](https://github.com/openwong2kim/wmux) treats hook events as agent lifecycle signals. WinCMux applies the same event boundary idea to its existing ConPTY core, while keeping terminal process status separate from agent turn status.
- [cmux hook integration](https://github.com/manaflow-ai/cmux/blob/main/docs/agent-hooks.md) binds a hook to the terminal that launched it and distinguishes actual hook receipt from mere configuration. WinCMux passes an ephemeral per-session binding into the child and validates the hook process ancestry before accepting a signal. Its setup UI generates configuration for the running core executable and waits for a received event before showing hook health.
- [ccmux adapter notes](https://github.com/epilande/ccmux/blob/main/docs/agent-adapters.md) document false idle/approval matches and Codex's leading `!` shell mode. WinCMux gives hook events precedence over text patterns, invalidates an old `Stop` on manual Enter, and rejects unattended `!` and `/` commands.
- [agent-talk's Codex auto-receive notes](https://github.com/xhluca/agent-talk/blob/main/docs/codex-auto-receive.md) show that a Stop hook alone cannot wake an already idle CLI. WinCMux uses its existing live ConPTY writer for scheduled input, guarded by a hook-confirmed idle state, a matching live agent process and a DB claim before delivery.
