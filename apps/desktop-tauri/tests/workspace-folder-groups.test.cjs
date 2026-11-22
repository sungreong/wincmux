const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workspaceFolderEntries, workspacePathKey, workspaceFolderNameKey, paginateWorkspaceEntries } = require('../renderer/workspace-folder-groups.js');

test('groups only workspaces with exactly the same folder name', () => {
  const rows = [
    { id: 'todo', name: 'WinTodoList', path: 'C:\\app\\WinTodoList' },
    { id: 'issue164', name: '164-meeting', path: 'C:\\project\\issues\\164-meeting' },
    { id: 'issue165', name: '165-model', path: 'C:\\project\\issues\\165-model' },
    { id: 'parent', name: 'agdd-workbench-test', path: 'C:\\app\\agdd-workbench-test' },
    { id: 'nested', name: 'agdd-workbench', path: 'C:\\app\\agdd-workbench-test\\agdd-workbench' },
    { id: 'copy', name: 'Another workbench', path: 'D:/other/AGDD-WORKBENCH/' },
  ];
  const entries = workspaceFolderEntries(rows);
  assert.deepEqual(entries.map(entry => entry.type), ['workspace', 'workspace', 'workspace', 'workspace', 'folder']);
  assert.deepEqual(entries[4].members.map(item => item.workspace.id), ['nested', 'copy']);
  assert.equal(entries[4].label, 'agdd-workbench');
  assert.equal(entries[4].key, 'folder:agdd-workbench');
});

test('normalizes Windows path spelling for duplicate folder confirmation', () => {
  assert.equal(workspacePathKey('C:/App/Project/'), workspacePathKey('c:\\app\\.\\Project\\'));
  assert.equal(workspacePathKey('C:\\app\\temp\\..\\Project'), workspacePathKey('c:\\app\\project'));
  assert.notEqual(workspacePathKey('C:\\app\\Project'), workspacePathKey('D:\\app\\Project'));
  assert.equal(workspaceFolderNameKey('C:\\app\\Project'), workspaceFolderNameKey('D:\\other\\project'));
  assert.notEqual(workspaceFolderNameKey('C:\\app\\Project'), workspaceFolderNameKey('D:\\other\\project-copy'));
  const duplicate = workspaceFolderEntries([
    { id: 'first', name: 'First', path: 'C:\\app\\Project' },
    { id: 'second', name: 'Second', path: 'c:/APP/project/' }
  ]);
  assert.equal(duplicate.length, 1);
  assert.deepEqual(duplicate[0].members.map(item => item.workspace.id), ['first', 'second']);
});

test('pagination keeps a folder together even when it crosses a page boundary', () => {
  const rows = [
    ...Array.from({ length: 14 }, (_, index) => ({ id: `single-${index}`, path: `C:\\unique-${index}` })),
    ...Array.from({ length: 4 }, (_, index) => ({ id: `group-${index}`, path: `C:\\parent-${index}\\shared` })),
    { id: 'last', path: 'C:\\last' }
  ];
  const pages = paginateWorkspaceEntries(workspaceFolderEntries(rows), 15);
  assert.deepEqual(pages.map(page => page.reduce((count, entry) => count + (entry.members?.length ?? 1), 0)), [14, 5]);
  assert.deepEqual(pages[1][0].members.map(({ workspace }) => workspace.id), ['group-0', 'group-1', 'group-2', 'group-3']);
  assert.equal(paginateWorkspaceEntries([], 15).length, 0);
});
