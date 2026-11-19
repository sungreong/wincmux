const { test } = require('node:test');
const assert = require('node:assert/strict');
const { workspaceFolderEntries, workspacePathKey, workspaceFolderNameKey } = require('../renderer/workspace-folder-groups.js');

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
