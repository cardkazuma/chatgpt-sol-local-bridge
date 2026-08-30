#!/usr/bin/env node

// The product-surface proof is intentionally a separate, operator-run gate.
// This repository script never opens a browser or desktop application and
// therefore cannot claim ordinary-chat execution.
console.log(JSON.stringify({
  proof: "s5-ordinary-chat-edit-test-local-commit",
  pass: false,
  blocker: "ordinary chatgpt.com interaction was not run because browser/desktop automation is prohibited for this session",
  safeFallback: "s5-runtime-proof provides the disposable host-fixture workflow only; it is not ordinary-Chat evidence",
  requiredInvocation: "activate @ChatGPT Local Bridge in a new ordinary chat and use only the disposable fixture",
}, null, 2));
process.exitCode = 2;
