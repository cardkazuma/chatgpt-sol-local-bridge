import crypto from "node:crypto";
import net from "node:net";

const CAPABILITY = /^[a-f0-9]{64}$/;
const BROKER_CAPABILITY = crypto.randomBytes(32).toString("hex");
let brokerRegistered = false;
let registrationPromise = null;
let testBrokerRequest = null;

const COORDINATED_ROUTES = new Set(["write_file", "edit_file", "apply_patch"]);
const RELATIVE_PATH = /^(?!\/)(?!.*(?:^|\/)\.\.\/?)(?!.*(?:^|\/)\.(?:\/|$))(?!.*\/\/)[^\0]+$/;
export const S6_BROKER_RESPONSE_MAX_BYTES = 128 * 1024;

/**
 * Parse one complete broker frame only.  The caller retains partial input
 * until a newline arrives; an oversized frame is a fail-closed channel error,
 * never a reason to accept truncated JSON or wait for a misleading close.
 */
export function consumeS6BrokerResponse(response) {
  if (Buffer.byteLength(response) > S6_BROKER_RESPONSE_MAX_BYTES) {
    throw new Error("S6 broker response exceeded bounded response limit");
  }
  const newline = response.indexOf("\n");
  if (newline < 0) return null;
  try {
    return JSON.parse(response.slice(0, newline));
  } catch {
    throw new Error("S6 broker returned malformed evidence");
  }
}

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

export function s6BrokerCoordinateMutation(route, repositoryRelativePath, observedContentSha256 = undefined) {
  if (!COORDINATED_ROUTES.has(route)) throw new Error("S7-B coordinator route is not covered by the Bridge adapter");
  if (typeof repositoryRelativePath !== "string" || !RELATIVE_PATH.test(repositoryRelativePath)) {
    throw new Error("S7-B coordinator path must be a normalized repository-relative path");
  }
  if (observedContentSha256 !== undefined && observedContentSha256 !== null && !/^[0-9a-f]{64}$/.test(observedContentSha256)) {
    throw new Error("S7-B coordinator observed content version is invalid");
  }
  return requestBroker({ operation: "coordinate-mutation", route, path: repositoryRelativePath, ...(observedContentSha256 !== undefined ? { observedContentSha256 } : {}) });
}

export function s6BrokerObserveResource(repositoryRelativePath, contentSha256) {
  if (typeof repositoryRelativePath !== "string" || !RELATIVE_PATH.test(repositoryRelativePath)) {
    throw new Error("S7-B coordinator path must be a normalized repository-relative path");
  }
  if (contentSha256 !== null && !/^[0-9a-f]{64}$/.test(String(contentSha256 || ""))) {
    throw new Error("S7-B coordinator observed content version is invalid");
  }
  return requestBroker({ operation: "coordinate-observe", path: repositoryRelativePath, contentSha256 });
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
    (requestKeys.join(",") !== "operation,path,route" && requestKeys.join(",") !== "observedContentSha256,operation,path,route")
    || !COORDINATED_ROUTES.has(request.route)
    || typeof request.path !== "string"
    || !RELATIVE_PATH.test(request.path)
    || (Object.hasOwn(request, "observedContentSha256") && request.observedContentSha256 !== null && !/^[0-9a-f]{64}$/.test(String(request.observedContentSha256 || "")))
  )) throw new Error("invalid S7-B coordinator request");
  if (!registration && request.operation === "coordinate-observe" && (
    requestKeys.join(",") !== "contentSha256,operation,path"
    || typeof request.path !== "string"
    || !RELATIVE_PATH.test(request.path)
    || (request.contentSha256 !== null && !/^[0-9a-f]{64}$/.test(String(request.contentSha256 || "")))
  )) throw new Error("invalid S7-B coordinator observation request");
  const body = JSON.stringify({
    capability,
    operation: request.operation,
    ...(request.sha ? { sha: request.sha } : {}),
    ...(request.route ? { route: request.route } : {}),
    ...(request.path ? { path: request.path } : {}),
    ...(Object.hasOwn(request, "observedContentSha256") ? { observed_content_sha256: request.observedContentSha256 } : {}),
    ...(Object.hasOwn(request, "contentSha256") ? { content_sha256: request.contentSha256 } : {}),
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
      let parsed;
      try { parsed = consumeS6BrokerResponse(response); } catch (error) { return finish(error); }
      if (parsed === null) return;
      if (parsed?.error) return finish(new Error(String(parsed.error)));
      finish(null, parsed);
    });
    socket.on("error", (error) => finish(new Error(`S6 broker request failed: ${error.code || error.message}`)));
    socket.on("close", () => { if (!settled) finish(new Error("S6 broker closed the request")); });
  });
}
