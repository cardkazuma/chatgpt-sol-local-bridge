#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { nativeStatus, renderNativePackage, SERVER_LABEL, TUNNEL_LABEL, verifyNativeArtifact } from "./native-package.mjs";
import { keychainUsabilityStatus } from "./s5-credential.mjs";

const [action, ...raw] = process.argv.slice(2);
const args = Object.fromEntries(raw.map((item) => { const [key, ...value] = item.replace(/^--/, "").split("="); return [key, value.join("=") || true]; }));
if (action === "render") {
  verifyNativeArtifact({ binary: args.tunnel });
  const tunnel = JSON.parse(fs.readFileSync(path.join(args.repo, "config", "s5-tunnel.json"), "utf8"));
  console.log(JSON.stringify(renderNativePackage({ outputDir: args.output, repoRoot: args.repo, nodePath: args.node, tunnelPath: args.tunnel, tunnelId: tunnel.tunnelId }), null, 2));
} else if (["start", "stop", "recover", "status"].includes(action)) {
  const configPath = path.resolve(String(args.config || ""));
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  const domain = `gui/${process.getuid()}`;
  const labels = action === "recover" && args.component ? [labelFor(args.component)] : [SERVER_LABEL, TUNNEL_LABEL];
  if (action === "status") {
    const loaded = Object.fromEntries(labels.map((label) => [label, spawnSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" }).status === 0]));
    const recovery = Object.fromEntries(["server", "tunnel"].map((component) => [component, readJson(path.join(config.stateRoot, `${component}-recovery.json`))]));
    const components = await nativeStatus({
      catalogProbe: async () => {
        try {
          const response = await fetch(`http://127.0.0.1:${config.port}/readyz`, { signal: AbortSignal.timeout(2_000) });
          const value = await response.json();
          return { ready: response.ok && value.ready === true, catalogVersion: value.catalogVersion, reason: response.ok ? "catalog mismatch" : `HTTP ${response.status}` };
        } catch (error) { return { ready: false, reason: String(error.message).slice(0, 300) }; }
      },
      tunnelProbe: async () => {
        const result = spawnSync(config.tunnelPath, ["health", "--port", "8080", "--json", "--require-control-plane-poll"], { encoding: "utf8", timeout: 5_000 });
        return { ready: result.status === 0, reason: result.status === 0 ? "ready" : "health/control-plane poll unavailable" };
      },
      keychainProbe: keychainUsabilityStatus,
    });
    console.log(JSON.stringify({ installed: labels.every((label) => fs.existsSync(path.join(process.env.HOME, "Library", "LaunchAgents", `${label}.plist`))), loaded, components, recovery }, null, 2));
  } else if (action === "stop") {
    for (const label of labels.reverse()) spawnSync("launchctl", ["bootout", `${domain}/${label}`], { stdio: "inherit" });
  } else {
    for (const label of labels) {
      if (action === "recover") { try { fs.unlinkSync(path.join(config.stateRoot, `${args.component}-recovery.json`)); } catch {} }
      const plist = path.join(process.env.HOME, "Library", "LaunchAgents", `${label}.plist`);
      if (!fs.existsSync(plist)) throw new Error(`LaunchAgent is not installed: ${label}`);
      if (spawnSync("launchctl", ["print", `${domain}/${label}`], { stdio: "ignore" }).status !== 0) spawnSync("launchctl", ["bootstrap", domain, plist], { stdio: "inherit" });
      const result = spawnSync("launchctl", ["kickstart", "-k", `${domain}/${label}`], { stdio: "inherit" });
      if (result.status !== 0) process.exitCode = result.status;
    }
  }
} else {
  console.error("Usage: native-runtime.mjs render --output=... --repo=... --node=... --tunnel=... | {status|start|stop|recover} --config=... [--component=server|tunnel]");
  process.exitCode = 2;
}

function labelFor(component) {
  if (component === "server") return SERVER_LABEL;
  if (component === "tunnel") return TUNNEL_LABEL;
  throw new Error("recover component must be server or tunnel");
}
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; } }
