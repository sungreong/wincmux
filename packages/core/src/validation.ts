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

export const sessionStreamSubscribeSchema = z
  .object({
    workspace_id: z.string().uuid().optional(),
    session_id: z.string().uuid().optional()
  })
  .refine((value) => Boolean(value.workspace_id || value.session_id), {
    message: "workspace_id or session_id is required"
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

export const sessionResizeSchema = z.object({
  session_id: z.string().uuid(),
  cols: z.number().int().positive(),
  rows: z.number().int().positive()
});

export const notifyPushSchema = z.object({
  workspace_id: z.string().uuid(),
  title: z.string().min(1),
  body: z.string(),
  level: z.string().min(1),
  source: z.string().min(1).optional()
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
