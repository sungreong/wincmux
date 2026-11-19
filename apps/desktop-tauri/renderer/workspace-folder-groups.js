// Windows treats folder names and paths as case-insensitive for workspace grouping.
function workspacePathKey(path) {
  const parts = String(path ?? "").trim().replace(/\//g, "\\")
    .replace(/^\\\\\?\\/, "").split("\\").filter(Boolean);
  const normalized = [];
  for (const part of parts) {
    if (part === ".") continue;
    if (part === "..") {
      if (normalized.length > 1) normalized.pop();
      continue;
    }
    normalized.push(part.toLocaleLowerCase("en-US"));
  }
  return normalized.join("\\");
}

function workspaceFolderNameKey(path) {
  return workspacePathKey(path).split("\\").at(-1) ?? "";
}

function workspaceFolderEntries(workspaces) {
  const folders = workspaces.map((workspace) => workspaceFolderNameKey(workspace.path));
  const members = new Map();
  for (let index = 0; index < workspaces.length; index += 1) {
    const folder = folders[index];
    if (!folder) continue;
    const list = members.get(folder) ?? [];
    list.push(index);
    members.set(folder, list);
  }

  const entries = [];
  for (let index = 0; index < workspaces.length; index += 1) {
    const folder = folders[index];
    const list = members.get(folder);
    if (!list || list.length === 1) {
      entries.push({ type: "workspace", workspace: workspaces[index], index });
      continue;
    }
    if (index !== list[0]) continue;
    const paths = [...new Set(list.map((member) => workspaces[member].path))];
    entries.push({
      type: "folder",
      key: `folder:${folder}`,
      path: paths.join("\n"),
      label: String(workspaces[index].path).replace(/[\\/]+$/, "").split(/[\\/]/).at(-1),
      members: list.map((member) => ({ workspace: workspaces[member], index: member }))
    });
  }
  return entries;
}

if (typeof module !== "undefined") module.exports = { workspacePathKey, workspaceFolderNameKey, workspaceFolderEntries };
