import crypto from "node:crypto";
import net from "node:net";

const CAPABILITY = /^[a-f0-9]{64}$/;
const BROKER_CAPABILITY = crypto.randomBytes(32).toString("hex");
let brokerRegistered = false;
let registrationPromise = null;
let testBrokerRequest = null;

const COORDINATED_ROUTES = new Set(["write_file", "edit_file", "apply_patch"]);
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.\/?)(?!.*(?:^|\/)\.(?:\/|$))(?!.*\/\/)[^\0]+$/;

export function s6BrokerConfigured() {
  return Boolean(testBrokerRequest || (process.env.S6_BROKER_SOCKET && brokerRegistered));
}

/** Test-only transport seam; production requests always use the fixed socket. */
export function setS6BrokerRequestForTests(requester = null) {
  if (requester !== null && typeof requester !== "function") throw new TypeError("S6 broker test requester must be a function or null");
  testBrokerRequest = requester;
}

export function initializeS6Broker() {
  if (!process.env.S6_BROKER_SOCKET) return Promise.resolve(false);
  if (brokerRegistered) return Promise.resolve(true);
  if (!registrationPromise) {
    registrationPromise = requestBroker({ operation: "register", capability: BROKER_CAPABILITY }, { registration: true })
      .then((result) => {
        if (result?.registered !== true) throw new Error("S6 broker registration was not acknowledged");
        brokerRegistered = true;
        return true;
      });
  }
  return registrationPromise;
}

export function s6BrokerAttestCommit(sha) {
  return requestBroker({ operation: "attest", sha });
}

export function s6BrokerPreflightCommit() {
  return requestBroker({ operation: "preflight-commit" });
}

export function s6BrokerPublishBranch() {
  return requestBroker({ operation: "publish" });
}

export function s6BrokerCoordinateMutation(route, repositoryRelativePath) {
  if (!COORDINATED_ROUTES.has(route)) throw new Error("S7-B coordinator route is not covered by the Bridge adapter");
  if (typeof repositoryRelativePath !== "string" || !RELATIVE_PATH.test(repositoryRelativePath)) {
    throw new Error("S7-B coordinator path must be a normalized repository-relative path");
  }
  return requestBroker({ operation: "coordinate-mutation", route, path: repositoryRelativePath });
}

function requestBroker(request, { registration = false } = {}) {
  if (!registration && testBrokerRequest) return Promise.resolve(testBrokerRequest(request));
  const socketPath = String(process.env.S6_BROKER_SOCKET || "");
  if (socketPath !== "/transport/s6-broker.sock") throw new Error("S6 broker channel identity is invalid");
  if (!registration && !brokerRegistered) throw new Error("S6 broker attestation channel is not registered");
  const capability = registration ? String(request.capability || "") : BROKER_CAPABILITY;
  if (!CAPABILITY.test(capability)) throw new Error("S6 broker capability is invalid");
  const requestKeys = Object.keys(request).filter((key) => key !== "capability").sort();
  if (registration && (requestKeys.join(",") !== "operation" || request.operation !== "register")) throw new Error("invalid S6 broker registration request");
  if (!registration && request.operation === "publish" && requestKeys.join(",") !== "operation") throw new Error("invalid S6 publish request");
  if (!registration && request.operation === "preflight-commit" && requestKeys.join(",") !== "operation") throw new Error("invalid S6 commit preflight request");
  if (!registration && request.operation === "attest" && (requestKeys.join(",") !== "operation,sha" || !/^[0-9a-f]{40}$/.test(String(request.sha || "")))) throw new Error("invalid S6 attestation request");
  if (!registration && request.operation === "coordinate-mutation" && (
    requestKeys.join(",") !== "operation,path,route"
    || !COORDINATED_ROUTES.has(request.route)
    || typeof request.path !== "string"
    || !RELATIVE_PATH.test(request.path)
  )) throw new Error("invalid S7-B coordinator request");
  const body = JSON.stringify({
    capability,
    operation: request.operation,
    ...(request.sha ? { sha: request.sha } : {}),
    ...(request.route ? { route: request.route } : {}),
    ...(request.path ? { path: request.path } : {}),
  });
  return new Promise((resolve, reject) => {
    let settled = false;
    let response = "";
    const socket = net.createConnection({ path: socketPath });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error); else resolve(value);
    };
    socket.setEncoding("utf8");
    socket.setTimeout(120_000, () => finish(new Error("S6 broker request timed out")));
    socket.on("connect", () => socket.end(`${body}\n`));
    socket.on("data", (chunk) => {
      response += chunk;
      if (Buffer.byteLength(response) > 128 * 1024 || !response.includes("\n")) return;
      let parsed;
      try { parsed = JSON.parse(response.slice(0, response.indexOf("\n"))); } catch { return finish(new Error("S6 broker returned malformed evidence")); }
      if (parsed?.error) return finish(new Error(String(parsed.error)));
      finish(null, parsed);
    });
    socket.on("error", (error) => finish(new Error(`S6 broker request failed: ${error.code || error.message}`)));
    socket.on("close", () => { if (!settled) finish(new Error("S6 broker closed the request")); });
  });
}
