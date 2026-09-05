const MAX_DIAGNOSTIC_BODY_LENGTH = 512;

export class TunnelReadinessProtocolError extends Error {
  constructor(message) {
    super(message);
    this.name = "TunnelReadinessProtocolError";
  }
}

export function parseTunnelReadinessResponse(status, body) {
  if (!Number.isInteger(status) || status < 100 || status > 599) {
    throw new TunnelReadinessProtocolError(`tunnel-client /readyz returned an invalid HTTP status: ${String(status)}`);
  }

  const trimmedBody = String(body ?? "").trim();
  const diagnosticBody = sanitizeReadinessBody(trimmedBody);

  if (status === 200) {
    if (trimmedBody === "ready") {
      return { ready: true, status, body: "ready", diagnostic: "HTTP 200: ready" };
    }
    throw new TunnelReadinessProtocolError(
      `unexpected tunnel-client /readyz response: HTTP 200: ${formatDiagnosticBody(diagnosticBody)}`,
    );
  }

  return {
    ready: false,
    status,
    body: diagnosticBody,
    diagnostic: `HTTP ${status}: ${formatDiagnosticBody(diagnosticBody)}`,
  };
}

export function sanitizeReadinessBody(body) {
  const sanitized = String(body ?? "")
    .replace(/Bearer\s+\S+/gi, "Bearer <redacted>")
    .replace(/sk-[A-Za-z0-9_-]+/g, "sk-<redacted>")
    .replace(/(CONTROL_PLANE_API_KEY|OPENAI_API_KEY)=\S+/gi, "$1=<redacted>");
  if (sanitized.length <= MAX_DIAGNOSTIC_BODY_LENGTH) return sanitized;
  return `${sanitized.slice(0, MAX_DIAGNOSTIC_BODY_LENGTH)}…`;
}

export function parseTunnelControlPlaneHealthReport(exitStatus, report) {
  if (!Number.isInteger(exitStatus)) {
    throw new TunnelReadinessProtocolError(`tunnel-client health returned an invalid exit status: ${String(exitStatus)}`);
  }
  if (!report || typeof report !== "object" || Array.isArray(report)) {
    throw new TunnelReadinessProtocolError("tunnel-client health --json returned a non-object report");
  }

  const diagnostic = [
    `result=${String(report.result ?? "missing")}`,
    `healthz=${endpointDiagnostic(report.healthz)}`,
    `readyz=${endpointDiagnostic(report.readyz)}`,
    `control-plane-poll=${metricDiagnostic(report.control_plane_poll)}`,
  ].join(", ");

  const ready = report.result === "ok"
    && report.healthz?.ok === true
    && report.readyz?.ok === true
    && report.control_plane_poll?.ok === true;
  if (exitStatus === 0) {
    if (!ready) {
      throw new TunnelReadinessProtocolError(`tunnel-client health exited 0 with an unexpected report: ${diagnostic}`);
    }
    return { ready: true, diagnostic };
  }
  if (exitStatus === 2) return { ready: false, diagnostic };
  throw new TunnelReadinessProtocolError(`tunnel-client health exited ${exitStatus}: ${diagnostic}`);
}

function formatDiagnosticBody(body) {
  return body === "" ? "<empty body>" : JSON.stringify(body);
}

function endpointDiagnostic(endpoint) {
  if (!endpoint || typeof endpoint !== "object") return "missing";
  const status = Number.isInteger(endpoint.status) ? endpoint.status : "no-status";
  const body = sanitizeReadinessBody(String(endpoint.body ?? "").trim());
  return `${endpoint.ok === true ? "ok" : "fail"}/${status}/${body || "<empty body>"}`;
}

function metricDiagnostic(metric) {
  if (!metric || typeof metric !== "object") return "missing";
  const detail = metric.ok === true ? String(metric.value ?? "ok") : String(metric.error ?? "failed");
  return `${metric.ok === true ? "ok" : "fail"}/${sanitizeReadinessBody(detail)}`;
}
