const TAURI_OUTPUT_BATCH_BYTES = 24_576;

function wincmuxTauriRestoreOutput(view) {
  if (!view.sessionId || !state.useStream) return;
  if (view.tauriOutput?.session !== view.sessionId) {
    view.tauriOutput = {
      session: view.sessionId, cursor: 0, wanted: 0, force: true,
      loading: false, queued: null, waiters: []
    };
  } else {
    view.tauriOutput.force = true;
    if (!view.outputQueueLength) view.tauriOutput.queued = null;
  }
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
    || (!flow.force && flow.cursor >= flow.wanted)) return;
  flow.force = false;
  flow.loading = true;
  const wantedAtStart = flow.wanted;
  let retry = false;
  try {
    const result = await rpc("session.tail", {
      session_id: flow.session,
      after_offset: flow.cursor,
      max_bytes: TAURI_OUTPUT_BATCH_BYTES
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
      view.term.reset();
      output = "\r\n[WinCMux] 출력 일부가 보관 한도를 넘어 생략되었습니다.\r\n" + output;
      state.metrics.dropped_frames += 1;
    }
    flow.queued = result.end_offset;
    enqueueStreamOutput(view.paneId, output, { sessionId: flow.session, source: "tail" });
  } catch (err) {
    if (activeTauriOutput(view, flow)) setStatus(`Terminal read error: ${err?.message ?? err}`, true);
  } finally {
    flow.loading = false;
    if (retry || flow.force) void pumpTauriOutput(view);
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
