"use strict";
for (const [id, command] of [
  ["openSshWorkspace", "open_ssh_workspace"],
  ["openDockerWorkspace", "open_docker_workspace"],
]) {
  document.getElementById(id).addEventListener("click", async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      await window.__TAURI__.core.invoke(command);
    } catch (error) {
      document.getElementById("statusBar").textContent = String(error);
    } finally {
      button.disabled = false;
    }
  });
}
