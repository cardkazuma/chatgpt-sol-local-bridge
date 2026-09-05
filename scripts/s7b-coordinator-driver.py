#!/usr/bin/env python3
"""Controller-owned one-shot driver for the installed Work Coordinator.

The S6 container never receives this process, its selected store, or any host
credentials. The host broker supplies a narrow, structured request and this
driver constructs the package protocol with the immutable GitHub repository ID
from its allow-listed environment.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
import sys

from work_coordinator.adapters.chatgpt_local_bridge.attestation import sealed_repository_contract_attestation
from work_coordinator.adapters.chatgpt_local_bridge.contract import (
    BridgeContext,
    acquire_claim_request,
    attest_capabilities_request,
    check_before_mutation_request,
    declare_intent_request,
    observe_resource_request,
    register_session_request,
)
from work_coordinator.adapters.chatgpt_local_bridge.mapping import ENABLED_MUTATION_PATHS
from work_coordinator.infrastructure.git.stable_repository_identity import VerifiedGitHubRepositoryIdentity
from work_coordinator.application.runtime_dispatcher import AdapterCoverageRegistry, SelectedStoreDispatcher
from work_coordinator.protocol.stdio import dispatch_protocol_request


REPOSITORY_HOST = "github.com"
PROVIDER = "chatgpt_local_bridge"
SCHEMA = "1.0"
COMMON_KEYS = frozenset({"action", "request_id", "context"})


def _nonempty(value: object, label: str) -> str:
    if type(value) is not str or not value or "\0" in value:
        raise ValueError(f"{label} is invalid")
    return value


def _context(value: object) -> BridgeContext:
    if type(value) is not dict:
        raise ValueError("context is invalid")
    required = {
        "project_id", "task_id", "session_id", "agent_id", "workspace_id",
        "worktree_id", "branch", "base_sha", "local_repository_instance_id",
    }
    if set(value) != required:
        raise ValueError("context fields are ambiguous")
    repository_id = os.environ.get("S7B_COORDINATOR_REPOSITORY_ID")
    if not repository_id or not repository_id.isdigit() or int(repository_id) <= 0:
        raise ValueError("trusted repository identity is unavailable")
    return BridgeContext(
        **{key: _nonempty(value[key], key) for key in required},
        repository=VerifiedGitHubRepositoryIdentity(
            repository_id=int(repository_id),
            verification_source="trusted_controller",
            host=REPOSITORY_HOST,
        ),
    )


def _path(value: object) -> str:
    value = _nonempty(value, "repository-relative path")
    if value.startswith("/") or "//" in value or any(part in {"", ".", ".."} for part in value.split("/")):
        raise ValueError("repository-relative path is invalid")
    return value


def _request(value: dict[str, object]) -> bytes:
    action = value.get("action")
    request_id = _nonempty(value.get("request_id"), "request id")
    context = _context(value.get("context"))
    attestation = sealed_repository_contract_attestation()
    if action == "register_session":
        if set(value) != COMMON_KEYS:
            raise ValueError("register request is ambiguous")
        return register_session_request(context, request_id)
    if action == "attest_capabilities":
        if set(value) != COMMON_KEYS:
            raise ValueError("attestation request is ambiguous")
        return attest_capabilities_request(context, request_id, attestation)
    if action == "declare_intent":
        if set(value) != COMMON_KEYS | {"resources"} or type(value["resources"]) is not list or not value["resources"]:
            raise ValueError("intent request is invalid")
        resources = []
        for item in value["resources"]:
            if type(item) is not dict or set(item) != {"path"}:
                raise ValueError("intent resource is invalid")
            resources.append(context.file_resource(_path(item["path"]), "mutate"))
        return declare_intent_request(context, request_id, resources)
    if action == "observe_resource":
        if set(value) != COMMON_KEYS | {"path", "observation"} or type(value["observation"]) is not dict:
            raise ValueError("observation request is invalid")
        return observe_resource_request(
            context, request_id, context.file_resource(_path(value["path"]), "mutate"), value["observation"],
        )
    if action == "acquire_claim":
        if set(value) != COMMON_KEYS | {"path"}:
            raise ValueError("claim request is invalid")
        return acquire_claim_request(
            context, request_id, context.file_resource(_path(value["path"]), "mutate"), attestation,
        )
    if action == "check_before_mutation":
        allowed = COMMON_KEYS | {"path", "current"}
        if set(value) not in (allowed, allowed | {"fence"}) or type(value["current"]) is not dict:
            raise ValueError("mutation check request is invalid")
        fence = value.get("fence")
        if fence is not None and type(fence) is not dict:
            raise ValueError("mutation fence is invalid")
        return check_before_mutation_request(
            context,
            request_id,
            context.file_resource(_path(value["path"]), "mutate"),
            attestation,
            value["current"],
            fence,
        )
    raise ValueError("unsupported controller coordinator action")


def main() -> int:
    raw = sys.stdin.read()
    if not raw or raw.count("\n") > 1:
        raise ValueError("driver accepts exactly one JSON request")
    value = json.loads(raw)
    if type(value) is not dict:
        raise ValueError("driver request must be an object")
    request = _request(value)
    environment = dict(os.environ)
    dispatcher = SelectedStoreDispatcher(
        environment,
        AdapterCoverageRegistry({PROVIDER: ENABLED_MUTATION_PATHS}),
    )
    result, _exit_code = dispatch_protocol_request(request, schema=SCHEMA, dispatcher=dispatcher)
    sys.stdout.write(json.dumps(result, ensure_ascii=False, sort_keys=True, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as error:  # stdout remains a single sanitized protocol result on success only.
        sys.stderr.write(f"coordinator driver failed: {error}\n")
        raise SystemExit(1)
