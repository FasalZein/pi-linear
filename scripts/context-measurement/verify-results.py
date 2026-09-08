#!/usr/bin/env python3
"""Fail-closed checks for the AEO-831 evidence bundle.

These checks protect the identity and honesty of the measurement: named model
serializer, named tokenizer, frozen before revision, reproduced baseline, and
the "not measured" fields that no live model produced. They set no performance
threshold, target, or release gate.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

repo = Path(__file__).resolve().parents[2]
path = Path(sys.argv[1]) if len(sys.argv) > 1 else repo / "docs/v10-context-measurement-results.json"
baseline = json.loads((repo / "scripts/fixtures/context-baseline-v0.9.json").read_text())
data = json.loads(path.read_text())

assert data["measurementKind"].startswith("deterministic offline replay")
assert data["tokenizer"]["package"] == "tiktoken"
assert data["tokenizer"]["version"] == baseline["tokenizer"]["version"]
assert data["tokenizer"]["encoding"] == baseline["tokenizer"]["encoding"]
assert data["model"]["serializer_target"]["package"] == "@earendil-works/pi-ai"
assert data["model"]["serializer_target"]["version"] == "0.84.2"
assert data["model"]["serializer_target"]["model"] == "gpt-5.4"
assert data["model"]["serializer_target"]["network"] is False
assert data["source"]["before"]["gitCommit"] == baseline["beforeRev"]
assert data["source"]["before"]["packageVersion"] == baseline["beforePackageVersion"]
assert all(row["matches"] for row in data["baselineReproduction"].values())
assert data["baselineReproduction"]["startup_tokens"]["measured"] == baseline["expectedTokens"]["startup"]
assert data["baselineReproduction"]["all_tools_tokens"]["measured"] == baseline["expectedTokens"]["allTools"]
assert (
    data["baselineReproduction"]["issues_five_workflow_schema_tokens"]["measured"]
    == baseline["expectedTokens"]["issuesFiveWorkflow"]
)
assert data["toolSetChanges"]["removedTools"] == []
assert data["toolSetChanges"]["removedHelpOperations"] == []
assert len(data["perToolSchema"]) == baseline["expectedCounts"]["tools"]
assert len(data["perToolHelp"]) == baseline["expectedCounts"]["helpOperations"]
assert len(data["replays"]) == baseline["expectedCounts"]["replays"]
assert {row["arm"] for row in data["armTotals"]} == {"all-exposed", "all-deferred", "hybrid-discovery"}
assert all(row["completion"].startswith("not measured") for row in data["armTotals"])
assert all(row["observed_wrong_calls"] is None for row in data["armTotals"])
assert all(row[side]["completion"].startswith("not measured") for row in data["replays"] for side in ("before", "current"))
assert all(row[side]["observedWrongCalls"] is None for row in data["replays"] for side in ("before", "current"))
assert all(row[side]["total_trajectory_serialized_tokens"] > 0 for row in data["replays"] for side in ("before", "current"))
assert all(
    request["sha256"] and request["bytes"] > 0
    for row in data["replays"]
    for side in ("before", "current")
    for request in row[side]["requests"]
)
print(
    f"PASS: {path} — {len(data['perToolSchema'])} tool schemas, "
    f"{len(data['perToolHelp'])} exact-help results, {len(data['replays'])} deterministic replays"
)
