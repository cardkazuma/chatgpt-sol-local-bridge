import * as darwin from "./darwin.js";
import * as linux from "./linux.js";
import * as win32 from "./win32.js";

const adapters = { darwin, linux, win32 };
export const platformAdapter = adapters[process.platform] || linux;

export function platformSummary() {
  return {
    platform: process.platform,
    adapter: platformAdapter.name,
    capabilities: platformAdapter.capabilities(),
  };
}
