import { createHash, randomUUID } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

// Explicit operator input; never discover a normal checkout or create a session.
const statePath = process.argv[2];
if (!statePath || process.argv[3] !== "--run-disposable-proof") throw new Error("usage: node scripts/s7b-live-mutation-proof.mjs /absolute/runtime/state.json --run-disposable-proof");
const state = JSON.parse(readFileSync(statePath, "utf8"));
if (state.kind !== "s6-runtime" || state.phase !== "running" || !/^s6-[a-z0-9]+-[0-9a-f]{16}$/.test(state.sessionId)) throw new Error("expected active S6 disposable runtime");
const session = state.sessionId;
const workspace = state.managerRoot + "/sessions/" + session;
const relay = state.resources.relayName;
const handoff = workspace + "/HANDOFF.md";
const relativePath = "HANDOFF.md";
const digest = (value) => createHash("sha256").update(value).digest("hex");
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const runner = [
  "import http from \"node:http\";",
  "let params=JSON.parse(process.env.MCP_PARAMS||\"{}\");",
  "if(process.env.MCP_STDIN_MODE===\"content\"){const chunks=[];for await(const chunk of process.stdin)chunks.push(chunk);params={...params,arguments:{...(params.arguments||{}),content:Buffer.concat(chunks).toString(\"utf8\")}};}",
  "const payload=JSON.stringify({jsonrpc:\"2.0\",id:1,method:\"tools/call\",params});",
  "const request=http.request({host:\"127.0.0.1\",port:Number(process.env.S3_RELAY_PORT||8081),path:\"/mcp\",method:\"POST\",headers:{host:\"localhost\",accept:\"application/json, text/event-stream\",\"content-type\":\"application/json\",\"content-length\":Buffer.byteLength(payload),authorization:\"Bearer \"+process.env.S3_RELAY_TOKEN}},response=>{let body=\"\";response.setEncoding(\"utf8\");response.on(\"data\",chunk=>body+=chunk);response.on(\"end\",()=>{const messages=body.split(/\\r?\\n/).map(line=>line.startsWith(\"data: \")?line.slice(6):line).map(line=>{try{return JSON.parse(line)}catch{return null}}).filter(Boolean);const message=messages.find(value=>value.id===1)||messages.at(-1)||{};const text=(message.result?.content||[]).filter(value=>value.type===\"text\").map(value=>value.text).join(\"\\n\");process.stdout.write(JSON.stringify({status:response.statusCode,isError:Boolean(message.error||message.result?.isError||message.id!==1||!Array.isArray(message.result?.content)),text,rawSize:Buffer.byteLength(JSON.stringify(message)),closed:body.includes(\"S6 broker closed the request\")}));});});",
  "request.on(\"error\",error=>{console.error(error.stack);process.exit(1)});request.end(payload);",
].join("\n");
function git(args) {
  return execFileSync("git", ["-C", workspace, ...args], { encoding: "utf8", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } }).trim();
}
function fingerprints() {
  const status = git(["status", "--porcelain=v1", "--untracked-files=all"]);
  const diff = git(["diff", "--binary"]);
  const staged = git(["diff", "--cached", "--binary"]);
  return { head: git(["rev-parse", "HEAD"]), branch: git(["branch", "--show-current"]), status: digest(status), unstaged: digest(diff), staged: digest(staged), indexEntries: digest(git(["ls-files", "--stage"])) };
}
function assert(value, message) { if (!value) throw new Error(message); }
function mcp(tool, args, content) {
  const params = { name: tool, arguments: args };
  const command = ["exec", "-i", "-e", "MCP_PARAMS=" + JSON.stringify(params)];
  if (content !== undefined) command.push("-e", "MCP_STDIN_MODE=content");
  command.push(relay, "node", "--input-type=module", "-e", runner);
  const run = spawnSync("docker", command, { encoding: "utf8", input: content, env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" } });
  if (run.status !== 0) throw new Error("MCP transport failed: " + String(run.stderr).trim());
  return JSON.parse(run.stdout);
}
function publicSummary(result) {
  return { status: result.status, isError: result.isError, serializedBytes: result.rawSize, hasBrokerClosedError: result.closed, hasInternalProjection: result.text.includes("s7b-mutation-result-v1") };
}
function read() {
  const result = mcp("read_file", { path: relativePath });
  assert(result.status === 200 && !result.isError, "actual MCP read_file failed");
  const snapshot = JSON.parse(result.text);
  const returned = Buffer.from(snapshot.content || "", snapshot.encoding === "base64" ? "base64" : "utf8");
  assert(!snapshot.truncated && digest(returned) === digest(readFileSync(handoff)), "actual MCP read differs from target bytes");
  return publicSummary(result);
}
function write(bytes) {
  const result = mcp("write_file", { path: relativePath }, bytes);
  assert(result.status === 200 && !result.isError && !result.closed, "actual MCP write_file failed");
  return publicSummary(result);
}

const baseline = readFileSync(handoff);
const baselineHash = digest(baseline);
const baselineFingerprints = fingerprints();
assert(git(["status", "--porcelain=v1", "--untracked-files=all"]) === "", "proof requires clean disposable baseline");
let restored = false;
try {
  assert(existsSync(handoff), "session A workspace/HANDOFF disappeared");
  const anchor = baseline.toString("utf8").split("\n").find(line => line.length > 24 && !line.startsWith("#"));
  assert(anchor, "no harmless HANDOFF anchor");

  const editMarker = "<!-- s7b-edit-" + randomUUID() + " -->";
  const initialRead = read();
  const edit = mcp("edit_file", { path: relativePath, oldText: anchor, newText: anchor + "\n" + editMarker });
  assert(edit.status === 200 && !edit.isError && !edit.closed, "actual MCP edit_file failed");
  const afterEditRead = read();
  const edited = readFileSync(handoff, "utf8");
  assert(edited.split(editMarker).length === 2, "edit marker was not added exactly once");
  // Git generates context and correct hunk offsets; preserve its final newline.
  const diff = execFileSync("git", ["-C", workspace, "diff", "--no-ext-diff", "--no-textconv", "-R", "--", relativePath], {encoding:"utf8"});
  assert(diff.startsWith("diff --git b/HANDOFF.md a/HANDOFF.md\n"), "expected contextual Git restoration diff");
  const applied = mcp("apply_patch", { diff });
  assert(applied.status === 200 && !applied.isError && !applied.closed, "actual MCP apply_patch failed: " + applied.text.slice(0,500));
  const afterPatchRead = read();
  assert(digest(readFileSync(handoff)) === baselineHash && same(fingerprints(), baselineFingerprints), "reversible edit/apply_patch did not restore baseline");

  console.log(JSON.stringify({checkpoint:"reversible",edit:publicSummary(edit),applyPatch:publicSummary(applied),restoredExactly:true}));
  const staleObservationRead = read();
  const competitor = Buffer.concat([baseline, Buffer.from("\n<!-- s7b-reread-competitor-" + randomUUID() + " -->\n")]);
  writeFileSync(handoff, competitor);
  const stale = mcp("write_file", { path: relativePath }, baseline);
  assert(stale.status === 200 && stale.isError && /REFRESH|STALE_OBSERVATION/.test(stale.text) && !stale.closed, "stale mutation was not REFRESH/no-write: " + stale.text.slice(0,500));
  assert(digest(readFileSync(handoff)) === digest(competitor), "stale mutation wrote over competing content");
  const reread = read();
  const rereadValidWrite = write(competitor);
  assert(digest(readFileSync(handoff)) === digest(competitor), "valid mutation after reread failed");
  const restore = write(baseline);
  const finalRead = read();
  assert(digest(readFileSync(handoff)) === baselineHash && readFileSync(handoff).length === baseline.length && same(fingerprints(), baselineFingerprints), "reread recovery did not restore exact baseline");
  restored = true;
  console.log(JSON.stringify({ session, baseline: { sha256: baselineHash, bytes: baseline.length }, reversible: { initialRead, edit: publicSummary(edit), afterEditRead, applyPatch: publicSummary(applied), afterPatchRead, restoredExactly: true }, rereadRecovery: { staleObservationRead, stale: publicSummary(stale), reread, rereadValidWrite, restore, finalRead, restoredExactly: true }, fingerprints: fingerprints() }));
} catch(error) { console.error("PROOF_FAILURE", error.message); throw error; } finally {
  if (!restored && digest(readFileSync(handoff)) !== baselineHash) writeFileSync(handoff, baseline);
  assert(digest(readFileSync(handoff)) === baselineHash && same(fingerprints(), baselineFingerprints), "final cleanup failed to restore exact baseline");
}
