const TAURI_OUTPUT_BATCH_BYTES = 24_576;

function wincmuxTauriRestoreOutput(view) {
  if (!view.sessionId || !state.useStream) return;
  if (view.tauriOutput?.session !== view.sessionId) {
    view.tauriOutput = {
      session: view.sessionId, cursor: 0, wanted: 0, force: true,
      loading: false, queued: null, waiters: [], snapshotNeeded: true
    };
  } else {
    view.tauriOutput.force = true;
    if (!view.outputQueueLength) view.tauriOutput.queued = null;
  }
  if (view.tauriOutput.snapshotNeeded) view.restoringSnapshot = true;
  void pumpTauriOutput(view);
}

function activeTauriOutput(view, flow) {
  return Boolean(flow && view.tauriOutput === flow && view.sessionId === flow.session
    && state.useStream && !view.disposed && isPaneViewAttached(view)
    && state.paneViews.get(view.paneId) === view);
}

async function pumpTauriOutput(view) {
  const flow = view.tauriOutput;
  if (!activeTauriOutput(view, flow) || flow.loading || flow.queued || view.outputWriteInFlight
    || flow.resizePaused || (!flow.snapshotNeeded && flow.resizeLimit != null && flow.cursor >= flow.resizeLimit)
    || (!flow.force && flow.cursor >= flow.wanted)) return;
  flow.force = false;
  flow.loading = true;
  const wantedAtStart = flow.wanted;
  let retry = false;
  try {
    if (flow.snapshotNeeded) {
      const snapshot = await rpc("session.snapshot", { session_id: flow.session });
      if (!activeTauriOutput(view, flow)) return;
      view.restoringSnapshot = true;
      view.term.options.windowsPty = snapshot.windows_pty ?? { backend: "conpty" };
      view.term.reset();
      view.term.resize(snapshot.cols, snapshot.rows);
      await new Promise((resolve) => view.term.write((snapshot.history ?? "") + snapshot.screen, resolve));
      if (!activeTauriOutput(view, flow)) return;
      view.hasOutput = true;
      hidePaneOverlay(view);
      flow.cursor = snapshot.end_offset;
      flow.wanted = Math.max(flow.wanted, snapshot.end_offset);
      flow.snapshotNeeded = false;
      view.restoringSnapshot = false;
      // A snapshot can have different dimensions even when its host did not move.
      schedulePaneFit(view, { force: true });
      completeTauriOutputWaiters(view, flow);
    }
    if (flow.resizeLimit != null && flow.cursor >= flow.resizeLimit) return;
    const result = await rpc("session.tail", {
      session_id: flow.session,
      after_offset: flow.cursor,
      max_bytes: flow.resizeLimit == null ? TAURI_OUTPUT_BATCH_BYTES
        : Math.min(TAURI_OUTPUT_BATCH_BYTES, flow.resizeLimit - flow.cursor)
    });
    if (!activeTauriOutput(view, flow)) return;
    flow.wanted = Math.max(flow.wanted, result.available_end_offset);
    if (!result.output) {
      retry = flow.wanted > Math.max(wantedAtStart, result.available_end_offset);
      // A closed session may have already discarded its history.
      if (!retry && !result.available_end_offset) flow.wanted = flow.cursor;
      completeTauriOutputWaiters(view, flow);
      return;
    }
    let output = result.output;
    if (result.start_offset > flow.cursor) {
      flow.snapshotNeeded = true;
      flow.force = true;
      return;
    }
    flow.queued = result.end_offset;
    enqueueStreamOutput(view.paneId, output, { sessionId: flow.session, source: "tail" });
  } catch (err) {
    if (activeTauriOutput(view, flow)) {
      if (String(err).includes("PTY session not attached")) { flow.snapshotNeeded = false; flow.force = true; }
      else setStatus(`Terminal read error: ${err?.message ?? err}`, true);
    }
  } finally {
    view.restoringSnapshot = false;
    flow.loading = false;
    if (retry || flow.force) void pumpTauriOutput(view);
  }
}

// Keep pre-resize bytes at the old dimensions, then switch before the repaint.
async function wincmuxTauriResizeOutput(view, cols, rows) {
  const flow = view.tauriOutput;
  if (!activeTauriOutput(view, flow)) return false;
  flow.resizePaused = true;
  let resized = false;
  try {
    const deadline = performance.now() + 5000;
    // A tail response already in flight must finish before we obtain a boundary.
    while (flow.loading || flow.queued || view.outputWriteInFlight || view.outputQueueLength) {
      if (!activeTauriOutput(view, flow)) return false;
      if (performance.now() > deadline) throw new Error("Terminal resize drain timed out");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const result = await rpc("session.resize", { session_id: flow.session, cols, rows });
    resized = true;
    if (!activeTauriOutput(view, flow)) return false;
    if (!Number.isSafeInteger(result.before_offset)) {
      // Older background cores cannot supply a boundary. Restore their current
      // screen instead of interpreting buffered bytes at the wrong dimensions.
      flow.snapshotNeeded = true;
    } else {
      flow.resizeLimit = result.before_offset;
      flow.wanted = Math.max(flow.wanted, flow.resizeLimit);
      if (flow.cursor < flow.resizeLimit) {
        await new Promise((resolve, reject) => {
          const waiter = { end: flow.resizeLimit, finish() { clearTimeout(timer); resolve(); } };
          const timer = setTimeout(() => {
            flow.waiters = flow.waiters.filter((item) => item !== waiter);
            reject(new Error("Terminal resize boundary timed out"));
          }, 5000);
          flow.waiters.push(waiter);
          flow.resizePaused = false;
          flow.force = true;
          void pumpTauriOutput(view);
        });
      }
    }
    if (!activeTauriOutput(view, flow)) return false;
    view.term.resize(cols, rows);
    return true;
  } catch (err) {
    if (resized) flow.snapshotNeeded = true;
    throw err;
  } finally {
    flow.resizePaused = false;
    flow.resizeLimit = null;
    if (activeTauriOutput(view, flow)) {
      flow.force = true;
      void pumpTauriOutput(view);
    }
  }
}

function wincmuxTauriBeginOutput(view) {
  const flow = view.tauriOutput;
  if (!flow?.queued || view.outputQueueLength > 0) return null;
  const receipt = { flow, end: flow.queued };
  flow.queued = null;
  return receipt;
}

function wincmuxTauriFinishOutput(view, receipt, parsed) {
  if (receipt && parsed) {
    receipt.flow.cursor = receipt.end;
    completeTauriOutputWaiters(view, receipt.flow);
  }
  if (parsed) void pumpTauriOutput(view);
}

function completeTauriOutputWaiters(view, flow) {
  for (const waiter of [...flow.waiters]) {
    if (flow.cursor >= waiter.end || !activeTauriOutput(view, flow)) waiter.finish();
  }
}

function wincmuxTauriStreamEvent(event, dispatch) {
  const params = event?.params ?? {};
  if (event?.method === "session.output_ready") {
    const pane = visiblePaneForSessionFast(params.session_id);
    const view = state.paneViews.get(pane);
    const flow = view?.tauriOutput;
    if (flow?.session === params.session_id) {
      flow.wanted = Math.max(flow.wanted, params.end_offset);
      void pumpTauriOutput(view);
    }
    return;
  }

  if ((event?.method === "session.exit" || event?.method === "session.state_changed")
    && params.end_offset > 0) {
    const view = state.paneViews.get(visiblePaneForSessionFast(params.session_id));
    const flow = view?.tauriOutput;
    if (flow?.session === params.session_id && activeTauriOutput(view, flow) && flow.cursor < params.end_offset) {
      flow.wanted = Math.max(flow.wanted, params.end_offset);
      const waiter = {
        end: params.end_offset,
        finish() {
          clearTimeout(timer);
          flow.waiters = flow.waiters.filter((item) => item !== waiter);
          dispatch(event);
        }
      };
      const timer = setTimeout(waiter.finish, 5000);
      flow.waiters.push(waiter);
      void pumpTauriOutput(view);
      return;
    }
  }
  dispatch(event);
}
