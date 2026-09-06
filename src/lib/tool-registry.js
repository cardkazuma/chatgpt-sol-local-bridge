import { z } from "zod";
import { BRIDGE_PROFILE, ENABLED_TOOLS, HOST_WORKSPACE_INDEX_FILE, HOST_WORKTREE_ROOT } from "./config.js";
import { HostWorkspaceIndex, withHostWorkspace } from "./host-workspaces.js";

export const hostWorkspaceIndex = new HostWorkspaceIndex({ stateFile: HOST_WORKSPACE_INDEX_FILE, worktreeRoot: HOST_WORKTREE_ROOT });
const CONTEXT_FREE = new Set(["bridge_instructions", "workspace_list", "workspace_create", "workspace_resume", "workspace_status", "workspace_checkpoint", "workspace_recover", "health"]);

// All registration sites go through this gate.  A disabled implementation is
// not registered and therefore is absent from MCP tools/list, rather than
// appearing as a tool that only fails after invocation.
export function registerEnabledTool(server, name, definition, handler) {
  if (!ENABLED_TOOLS.has(name)) return false;
  if (BRIDGE_PROFILE !== "host" || CONTEXT_FREE.has(name)) {
    server.registerTool(name, definition, handler);
    return true;
  }
  const inputSchema = { ...(definition.inputSchema || {}), workspaceId: z.string().regex(/^ws_[a-f0-9]{16}$/) };
  server.registerTool(name, { ...definition, inputSchema }, async (args = {}, extra) => {
    const { workspaceId, ...rest } = args;
    return withHostWorkspace(hostWorkspaceIndex, workspaceId, { mutating: definition.annotations?.readOnlyHint !== true }, () => handler(rest, extra));
  });
  return true;
}
