// Ask before changing project hook settings when launching an agent in the UI.
(() => {
  const byId = (id) => document.getElementById(id);
  let queue = Promise.resolve();

  async function ask(workspace, provider) {
    const name = provider === 'claude' ? 'Claude Code' : 'Codex';
    const relative = provider === 'claude' ? '.claude/settings.local.json' : '.codex/hooks.json';
    let status = null;
    let statusError = null;
    try {
      status = await rpc('workspace.hooks.status', { workspace_id: workspace.id, provider });
      if (status.registered) return 'registered';
    } catch (error) { statusError = error; }

    const dialog = byId('workspaceHookDialog');
    const help = byId('workspaceHookHelp');
    const statusLine = byId('workspaceHookState');
    const errorBox = byId('workspaceHookError');
    const errorText = byId('workspaceHookErrorText');
    const prompt = byId('workspaceHookPrompt');
    const register = byId('workspaceHookRegister');
    const copy = byId('workspaceHookCopy');
    const controller = new AbortController();
    const { signal } = controller;
    byId('workspaceHookTitle').textContent = `${name} 훅 등록`;
    help.textContent = `${workspace.name} (${workspace.path})에서 ${name}을 시작합니다. 훅을 등록하면 승인 대기와 작업 완료 상태를 직접 받을 수 있습니다. 기존 설정과 훅은 유지됩니다.`;
    statusLine.textContent = status
      ? `현재 ${status.events}/${status.total}개 등록 · 훅 없이 시작하면 터미널 출력으로 상태를 추정합니다.`
      : '훅 상태를 읽지 못했습니다. 등록을 다시 시도하거나 출력 기반 감지로 시작할 수 있습니다.';
    errorBox.hidden = true;
    register.disabled = false;
    copy.textContent = '프롬프트 복사';

    const showFailure = (error) => {
      const reason = String(error?.message ?? error);
      errorText.textContent = reason;
      prompt.value = `WinCMux에서 ${name} 훅을 등록하려고 했지만 실패했습니다.\n워크스페이스: ${workspace.path}\n설정 파일: ${relative}\n오류: ${reason}\n기존 설정과 다른 훅을 보존하면서 등록 실패 원인을 확인하고, 이 워크스페이스에 WinCMux 상태 감지 훅을 추가해 주세요. 수정 후 설정 파일과 등록된 이벤트를 확인해 주세요.`;
      errorBox.hidden = false;
      statusLine.textContent = `${name} 훅 등록 실패 · 훅 없이 시작하거나 아래 문제 해결 프롬프트를 복사할 수 있습니다.`;
      setStatus(`${name} Hook 등록 실패: ${reason}`, true);
    };
    if (statusError) showFailure(statusError);
    copy.addEventListener('click', async () => {
      try {
        await window.wincmux.clipboardWrite(prompt.value);
        copy.textContent = '복사됨';
      } catch (error) { setStatus(`프롬프트 복사 실패: ${error?.message ?? error}`, true); }
    }, { signal });
    register.addEventListener('click', async () => {
      register.disabled = true;
      statusLine.textContent = `${name} 훅 등록 중…`;
      try {
        const result = await rpc('workspace.hooks.ensure', { workspace_id: workspace.id, provider });
        if (!result.registered) throw new Error('등록 결과에 필요한 이벤트가 모두 포함되지 않았습니다.');
        const verified = await rpc('workspace.hooks.status', { workspace_id: workspace.id, provider });
        if (!verified.registered) throw new Error('설정 파일을 다시 확인했지만 훅이 완전히 등록되지 않았습니다.');
        setStatus(`${workspace.name}: ${name} Hook 등록 완료 (${verified.events}/${verified.total})`, false, { priority: 100, holdMs: 8000 });
        if (!byId('workspaceViewer').hidden && state.selectedWorkspaceId === workspace.id) byId('viewerRefresh').click();
        dialog.close('registered');
      } catch (error) { showFailure(error); register.disabled = false; }
    }, { signal });
    byId('workspaceHookWithout').addEventListener('click', () => {
      setStatus(`${name} 훅 없이 시작 · 터미널 출력에서 상태를 추정합니다.`, false, { priority: 100, holdMs: 8000 });
      dialog.close('fallback');
    }, { signal });
    byId('workspaceHookCancel').addEventListener('click', () => dialog.close('cancel'), { signal });
    dialog.returnValue = 'cancel';
    return await new Promise((resolve) => {
      dialog.addEventListener('close', () => {
        controller.abort();
        resolve(['registered', 'fallback'].includes(dialog.returnValue) ? dialog.returnValue : 'cancel');
      }, { once: true });
      dialog.showModal();
      register.focus();
    });
  }

  function promptForLaunch(workspace, provider) {
    if (!workspace?.id || !['claude', 'codex'].includes(provider)) return Promise.resolve('fallback');
    const task = queue.then(() => ask(workspace, provider));
    queue = task.catch(() => {});
    return task;
  }

  window.wincmuxHookRegistration = { promptForLaunch };
})();
