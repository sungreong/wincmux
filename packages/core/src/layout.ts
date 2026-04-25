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

  move(
    workspaceId: string,
    sourcePaneId: string,
    targetPaneId: string,
    placement: "left" | "right" | "above" | "below"
  ): void {
    if (sourcePaneId === targetPaneId) {
      return;
    }

    const layout = this.ensure(workspaceId);
    const source = layout.panes[sourcePaneId];
    const target = layout.panes[targetPaneId];
    if (!source || !target) {
      throw new Error("pane not found");
    }
    if (source.split || target.split) {
      throw new Error("can only move leaf panes");
    }
    if (!source.parent_id) {
      throw new Error("cannot move last pane");
    }

    this.detachLeaf(layout, sourcePaneId);

    const refreshedSource = layout.panes[sourcePaneId];
    const refreshedTarget = layout.panes[targetPaneId];
    if (!refreshedSource || !refreshedTarget) {
      throw new Error("pane not found after detach");
    }

    const containerId = randomUUID();
    const targetParentId = refreshedTarget.parent_id;
    const direction = placement === "left" || placement === "right" ? "horizontal" : "vertical";
    const sourceFirst = placement === "left" || placement === "above";

    layout.panes[containerId] = {
      pane_id: containerId,
      parent_id: targetParentId,
      split: {
        direction,
        first: sourceFirst ? sourcePaneId : targetPaneId,
        second: sourceFirst ? targetPaneId : sourcePaneId
      },
      is_focused: false
    };

    if (!targetParentId) {
      layout.root_pane_id = containerId;
    } else {
      this.replaceChild(layout, targetParentId, targetPaneId, containerId);
    }

    refreshedSource.parent_id = containerId;
    refreshedTarget.parent_id = containerId;
  }

  swap(workspaceId: string, firstPaneId: string, secondPaneId: string): void {
    if (firstPaneId === secondPaneId) {
      return;
    }
    const layout = this.ensure(workspaceId);
    const first = layout.panes[firstPaneId];
    const second = layout.panes[secondPaneId];
    if (!first || !second) {
      throw new Error("pane not found");
    }
    if (first.split || second.split) {
      throw new Error("can only swap leaf panes");
    }

    const firstParentId = first.parent_id;
    const secondParentId = second.parent_id;

    if (!firstParentId || !secondParentId) {
      if (firstParentId || secondParentId) {
        throw new Error("invalid root swap state");
      }
      return;
    }

    const firstParent = layout.panes[firstParentId];
    const secondParent = layout.panes[secondParentId];
    if (!firstParent?.split || !secondParent?.split) {
      throw new Error("invalid parent split state");
    }

    if (firstParentId === secondParentId) {
      if (firstParent.split.first === firstPaneId && firstParent.split.second === secondPaneId) {
        firstParent.split.first = secondPaneId;
        firstParent.split.second = firstPaneId;
        return;
      }
      if (firstParent.split.first === secondPaneId && firstParent.split.second === firstPaneId) {
        firstParent.split.first = firstPaneId;
        firstParent.split.second = secondPaneId;
        return;
      }
      throw new Error("pane not linked from parent");
    }

    this.replaceChild(layout, firstParentId, firstPaneId, secondPaneId);
    this.replaceChild(layout, secondParentId, secondPaneId, firstPaneId);
    first.parent_id = secondParentId;
    second.parent_id = firstParentId;
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

  private replaceChild(layout: WorkspaceLayout, parentId: string, from: string, to: string): void {
    const parent = layout.panes[parentId];
    if (!parent?.split) {
      throw new Error("invalid parent split state");
    }
    if (parent.split.first === from) {
      parent.split.first = to;
      return;
    }
    if (parent.split.second === from) {
      parent.split.second = to;
      return;
    }
    throw new Error("pane not linked from parent");
  }

  private detachLeaf(layout: WorkspaceLayout, paneId: string): void {
    const target = layout.panes[paneId];
    if (!target) {
      throw new Error("pane not found");
    }
    if (target.split) {
      throw new Error("cannot detach non-leaf pane");
    }
    if (!target.parent_id) {
      throw new Error("cannot detach root pane");
    }

    const parent = layout.panes[target.parent_id];
    if (!parent?.split) {
      throw new Error("invalid parent split state");
    }

    const siblingId = parent.split.first === paneId ? parent.split.second : parent.split.first;
    const sibling = layout.panes[siblingId];
    if (!sibling) {
      throw new Error("sibling pane not found");
    }

    const grandParentId = parent.parent_id;
    delete layout.panes[parent.pane_id];
    sibling.parent_id = grandParentId;
    target.parent_id = null;

    if (!grandParentId) {
      layout.root_pane_id = siblingId;
      return;
    }

    this.replaceChild(layout, grandParentId, parent.pane_id, siblingId);
  }
}
