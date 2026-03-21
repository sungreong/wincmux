import { z } from "zod";

export const workspaceCreateSchema = z.object({
  name: z.string().min(1),
  path: z.string().min(1),
  backend: z.string().min(1)
});

export const workspaceRenameSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1)
});

export const workspaceDeleteSchema = z.object({
  id: z.string().uuid()
});

export const workspacePinSchema = z.object({
  id: z.string().uuid(),
  pinned: z.boolean()
});

export const workspaceReorderSchema = z.object({
  id: z.string().uuid(),
  sort_order: z.number().int()
});

export const workspaceDescribeSchema = z.object({
  id: z.string().uuid(),
  description: z.string()
});

export const sessionRunSchema = z.object({
  workspace_id: z.string().uuid(),
  cmd: z.string().min(1),
  args: z.array(z.string()).default([]),
  cwd: z.string().optional()
});

export const sessionWriteSchema = z.object({
  session_id: z.string().uuid(),
  data: z.string()
});

export const sessionReadSchema = z.object({
  session_id: z.string().uuid(),
  max_bytes: z.number().int().positive().optional()
});

export const streamTopicSchema = z.enum(["session", "notify"]);

export const sessionStreamSubscribeSchema = z
  .object({
    workspace_id: z.string().uuid().optional(),
    session_id: z.string().uuid().optional(),
    topics: z.array(streamTopicSchema).default(["session"])
  })
  .refine((value) => {
    if (value.topics.includes("notify")) {
      return true;
    }
    return Boolean(value.workspace_id || value.session_id);
  }, {
    message: "workspace_id or session_id is required unless topics includes notify"
  });

export const sessionStreamUnsubscribeSchema = z.object({
  subscription_id: z.string().uuid()
});

export const sessionListSchema = z.object({
  workspace_id: z.string().uuid()
});

export const sessionCloseSchema = z.object({
  session_id: z.string().uuid()
});

export const sessionDeleteSchema = z.object({
  session_id: z.string().uuid()
});

export const sessionResizeSchema = z.object({
  session_id: z.string().uuid(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive()
});

export const notifyLevelSchema = z.enum(["info", "success", "warning", "error"]);
export const notificationKindSchema = z.enum([
  "assistant_prompt",
  "task_done",
  "task_error",
  "system"
]);
export const notificationSourceKindSchema = z.enum([
  "hook",
  "osc",
  "pattern",
  "cli",
  "system"
]);

export const notifyPushSchema = z.object({
  workspace_id: z.string().uuid(),
  session_id: z.string().uuid().nullable().optional(),
  pane_id: z.string().uuid().nullable().optional(),
  kind: notificationKindSchema.default("system"),
  source_kind: notificationSourceKindSchema.default("cli"),
  title: z.string().min(1),
  body: z.string().default(""),
  level: notifyLevelSchema.default("info"),
  source: z.string().min(1).optional(),
  dedup_key: z.string().min(1).max(200).optional()
});

export const notifyDeliveryAckSchema = z.object({
  notification_id: z.string().uuid(),
  delivered: z.boolean().default(false),
  suppressed: z.boolean().default(false)
});

export const notifyUnreadSchema = z
  .object({
    workspace_id: z.string().uuid().optional()
  })
  .optional();

export const notificationReadSchema = z.object({
  notification_id: z.string().uuid()
});

export const notifyClearSchema = z
  .object({
    workspace_id: z.string().uuid().optional()
  })
  .optional();

export const layoutSplitSchema = z.object({
  workspace_id: z.string().uuid(),
  pane_id: z.string().uuid(),
  direction: z.enum(["horizontal", "vertical"])
});

export const layoutFocusSchema = z.object({
  workspace_id: z.string().uuid(),
  pane_id: z.string().uuid()
});

export const layoutCloseSchema = z.object({
  workspace_id: z.string().uuid(),
  pane_id: z.string().uuid()
});

export const layoutListSchema = z.object({
  workspace_id: z.string().uuid()
});

export const paneSessionBindSchema = z.object({
  workspace_id: z.string().uuid(),
  pane_id: z.string().uuid(),
  session_id: z.string().uuid()
});

export const workspaceIdSchema = z.object({
  workspace_id: z.string().uuid()
});
