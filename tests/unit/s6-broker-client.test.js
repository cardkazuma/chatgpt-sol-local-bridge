import test from "node:test";
import assert from "node:assert/strict";
import { consumeS6BrokerResponse, S6_BROKER_RESPONSE_MAX_BYTES } from "../../src/lib/s6-broker-client.js";

test("S6 broker client rejects an oversized response immediately without accepting partial JSON", () => {
  const oversized = `${JSON.stringify({ decision: "ALLOW", evidence: "x".repeat(S6_BROKER_RESPONSE_MAX_BYTES) })}\n`;
  assert.throws(
    () => consumeS6BrokerResponse(oversized),
    /S6 broker response exceeded bounded response limit/,
  );
  assert.doesNotThrow(() => consumeS6BrokerResponse('{"decision":"ALLOW"}'));
  assert.equal(consumeS6BrokerResponse('{"decision":"ALLOW"}'), null, "an unterminated response must not be parsed as a valid result");
});
