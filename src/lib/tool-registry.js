import { ENABLED_TOOLS } from "./config.js";

// All registration sites go through this gate.  A disabled implementation is
// not registered and therefore is absent from MCP tools/list, rather than
// appearing as a tool that only fails after invocation.
export function registerEnabledTool(server, name, definition, handler) {
  if (!ENABLED_TOOLS.has(name)) return false;
  server.registerTool(name, definition, handler);
  return true;
}
