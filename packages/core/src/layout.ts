import { randomUUID } from "node:crypto";
import type { PaneNode } from "./types";

interface WorkspaceLayout {
  root_pane_id: string;
  panes: Record<string, PaneNode>;
}

export class LayoutStore {
  private readonly byWorkspace = new Map<string, WorkspaceLayout>();

  ensure(workspaceId: string): WorkspaceLayout {
    const existing = this.byWorkspace.get(workspaceId);
    if (existing) {
      return existing;
    }

    const root = randomUUID();
    const layout: WorkspaceLayout = {
      root_pane_id: root,
      panes: {
        [root]: {
          pane_id: root,
          parent_id: null,
          split: null,
          is_focused: true
        }
      }
    };
    this.byWorkspace.set(workspaceId, layout);
    return layout;
  }

  split(workspaceId: string, paneId: string, direction: "horizontal" | "vertical"): [string, string] {
    const layout = this.ensure(workspaceId);
    const target = layout.panes[paneId];
    if (!target) {
      throw new Error("pane not found");
    }

    const first = randomUUID();
    const second = randomUUID();
    const wasFocused = target.is_focused;

    target.split = { direction, first, second };
    target.is_focused = false;

    layout.panes[first] = {
      pane_id: first,
      parent_id: paneId,
      split: null,
      is_focused: wasFocused
    };
    layout.panes[second] = {
      pane_id: second,
      parent_id: paneId,
      split: null,
      is_focused: false
    };

    return [first, second];
  }

  focus(workspaceId: string, paneId: string): void {
    const layout = this.ensure(workspaceId);
    if (!layout.panes[paneId]) {
      throw new Error("pane not found");
    }

    for (const pane of Object.values(layout.panes)) {
      pane.is_focused = false;
    }
    layout.panes[paneId].is_focused = true;
  }

  close(workspaceId: string, paneId: string): string {
    const layout = this.ensure(workspaceId);
    const target = layout.panes[paneId];
    if (!target) {
      throw new Error("pane not found");
    }
    if (target.split) {
      throw new Error("cannot close non-leaf pane");
    }
    if (!target.parent_id) {
      throw new Error("cannot close last pane");
    }

    const parent = layout.panes[target.parent_id];
    if (!parent || !parent.split) {
      throw new Error("invalid parent split state");
    }

    const siblingId = parent.split.first === paneId ? parent.split.second : parent.split.first;
    const sibling = layout.panes[siblingId];
    if (!sibling) {
      throw new Error("sibling pane not found");
    }

    const grandParentId = parent.parent_id;
    delete layout.panes[paneId];
    delete layout.panes[parent.pane_id];

    sibling.parent_id = grandParentId;
    if (!grandParentId) {
      layout.root_pane_id = siblingId;
    } else {
      const grandParent = layout.panes[grandParentId];
      if (!grandParent || !grandParent.split) {
        throw new Error("invalid grandparent split state");
      }
      if (grandParent.split.first === parent.pane_id) {
        grandParent.split.first = siblingId;
      } else if (grandParent.split.second === parent.pane_id) {
        grandParent.split.second = siblingId;
      } else {
        throw new Error("parent pane not linked from grandparent");
      }
    }

    const focusLeaf = this.firstLeaf(layout, siblingId);
    for (const pane of Object.values(layout.panes)) {
      pane.is_focused = false;
    }
    const focusNode = layout.panes[focusLeaf];
    if (!focusNode) {
      throw new Error("focus pane not found");
    }
    focusNode.is_focused = true;
    return focusLeaf;
  }

  list(workspaceId: string): PaneNode[] {
    const layout = this.ensure(workspaceId);
    return Object.values(layout.panes);
  }

  rootPaneId(workspaceId: string): string {
    return this.ensure(workspaceId).root_pane_id;
  }

  serialize(workspaceId: string): string {
    return JSON.stringify(this.ensure(workspaceId));
  }

  hydrate(workspaceId: string, payload: string): void {
    const parsed = JSON.parse(payload) as WorkspaceLayout;
    if (!parsed || !parsed.root_pane_id || !parsed.panes) {
      return;
    }
    this.byWorkspace.set(workspaceId, parsed);
  }

  private firstLeaf(layout: WorkspaceLayout, paneId: string): string {
    const node = layout.panes[paneId];
    if (!node) {
      throw new Error("pane not found");
    }
    if (!node.split) {
      return paneId;
    }
    return this.firstLeaf(layout, node.split.first);
  }
}
