# S7-B review-fix fixture setup

`s7b-review-fixes.test.js` is an explicit real broker/driver integration
fixture. It does not discover or read the production Bridge configuration
under `~/Library/Application Support/ChatGPT Local Bridge`.

Provision a dedicated interpreter that already contains the accepted
`work-coordinator==0.2.0` installation, then run:

```sh
S7B_REVIEW_COORDINATOR_PYTHON=/absolute/path/to/provisioned/work-coordinator-0.2.0/bin/python \
S7B_REVIEW_COORDINATOR_ARTIFACT_SHA256=3e528011ce130797af25aeca2f1bb1faea294cd46838cfbadffc488cd9463f96 \
HOME="$(mktemp -d)" TMPDIR=/tmp \
node --test tests/unit/s7b-review-fixes.test.js
```

The test requires both variables, verifies the interpreter exposes version
`0.2.0`, clears `PYTHONPATH`/user-site lookup for that probe, and fails
explicitly when a prerequisite is missing. Each fixture initializes one
owner-only SQLite database under a temporary test root with the explicit
interpreter, then exercises the real coordinator driver and broker. No
production store, Bridge config, or success mock is used.
