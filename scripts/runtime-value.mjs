#!/usr/bin/env node
import fs from "node:fs";
import dotenv from "dotenv";

const [file, key] = process.argv.slice(2);
const allowed = new Set(["HOST", "PORT", "TUNNEL_PROFILE", "TUNNEL_HEALTH_PORT"]);
if (!file || !allowed.has(key)) process.exit(2);
const parsed = dotenv.parse(fs.readFileSync(file));
const defaults = { HOST: "127.0.0.1", PORT: "8765", TUNNEL_PROFILE: "sol-local-bridge", TUNNEL_HEALTH_PORT: "8766" };
process.stdout.write(parsed[key] || defaults[key]);
