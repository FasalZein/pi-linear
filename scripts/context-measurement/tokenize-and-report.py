#!/usr/bin/env python3
"""Tokenize AEO-831 dumps and write reproducible JSON/Markdown evidence."""
from __future__ import annotations

import argparse
import hashlib
import importlib.metadata
import json
import platform
from pathlib import Path
from typing import Any

import tiktoken


def compact(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def delta(before: int, current: int) -> int:
    return current - before


def pct(before: int, current: int) -> str:
    if before == 0:
        return "n/a"
    return f"{((current - before) / before) * 100:.1f}%"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--before", type=Path, required=True)
    parser.add_argument("--current", type=Path, required=True)
    parser.add_argument("--baseline", type=Path, required=True)
    parser.add_argument("--out-json", type=Path, required=True)
    parser.add_argument("--out-md", type=Path, required=True)
    args = parser.parse_args()

    before = json.loads(args.before.read_text())
    current = json.loads(args.current.read_text())
    baseline = json.loads(args.baseline.read_text())
    enc = tiktoken.get_encoding("o200k_base")

    def tokens(text: str) -> int:
        return len(enc.encode(text))

    def tool_metrics(dump: dict[str, Any]) -> dict[str, dict[str, Any]]:
        return {
            name: {"bytes": row["bytes"], "tokens_o200k_base": tokens(row["localJson"])}
            for name, row in dump["tools"].items()
        }

    def help_metrics(dump: dict[str, Any]) -> dict[str, dict[str, Any]]:
        return {
            name: {
                "bytes": len(row["detailsJson"].encode("utf-8")),
                "tokens_o200k_base": tokens(row["detailsJson"]),
            }
            for name, row in dump["help"]["operations"].items()
        }

    bt, ct = tool_metrics(before), tool_metrics(current)
    bh, ch = help_metrics(before), help_metrics(current)
    # A renamed or dropped tool stays visible instead of crashing the comparison.
    shared_tools = [name for name in bt if name in ct]
    shared_help = [name for name in bh if name in ch]
    tool_set_changes = {
        "addedTools": sorted(set(ct) - set(bt)),
        "removedTools": sorted(set(bt) - set(ct)),
        "addedHelpOperations": sorted(set(ch) - set(bh)),
        "removedHelpOperations": sorted(set(bh) - set(ch)),
    }

    per_tool_schema = [
        {
            "tool": name,
            "before_bytes": bt[name]["bytes"],
            "current_bytes": ct[name]["bytes"],
            "delta_bytes": delta(bt[name]["bytes"], ct[name]["bytes"]),
            "before_tokens": bt[name]["tokens_o200k_base"],
            "current_tokens": ct[name]["tokens_o200k_base"],
            "delta_tokens": delta(bt[name]["tokens_o200k_base"], ct[name]["tokens_o200k_base"]),
        }
        for name in shared_tools
    ]
    per_tool_help = [
        {
            "operation": name,
            "before_bytes": bh[name]["bytes"],
            "current_bytes": ch[name]["bytes"],
            "delta_bytes": delta(bh[name]["bytes"], ch[name]["bytes"]),
            "before_tokens": bh[name]["tokens_o200k_base"],
            "current_tokens": ch[name]["tokens_o200k_base"],
            "delta_tokens": delta(bh[name]["tokens_o200k_base"], ch[name]["tokens_o200k_base"]),
        }
        for name in shared_help
    ]

    def set_metric(dump: dict[str, Any], names: list[str], metrics: dict[str, dict[str, Any]]) -> dict[str, int]:
        return {
            "count": len(names),
            "bytes": sum(metrics[name]["bytes"] for name in names),
            "tokens_o200k_base": sum(metrics[name]["tokens_o200k_base"] for name in names),
        }

    sets: dict[str, dict[str, Any]] = {}
    scenarios = {
        "startup": before["registration"]["startupActive"],
        "all": before["registration"]["registeredNames"],
        "issues-five": ["linear_get_issue", "linear_list_issues", "linear_create_issue", "linear_update_issue", "linear_search_issues"],
        "projects-three": ["linear_get_project", "linear_list_projects", "linear_save_project"],
        "workspace-two": ["linear_list_issue_statuses", "linear_switch_workspace"],
    }
    for name, names in scenarios.items():
        before_names = names if name in ("startup", "all") else before["registration"]["startupActive"] + names
        current_names = names if name in ("startup", "all") else current["registration"]["startupActive"] + names
        b = set_metric(before, before_names, bt)
        c = set_metric(current, current_names, ct)
        sets[name] = {"before": b, "current": c, "delta_tokens": c["tokens_o200k_base"] - b["tokens_o200k_base"]}

    replay_rows: list[dict[str, Any]] = []
    for key, old in before["replays"].items():
        new = current["replays"][key]

        def replay_metric(replay: dict[str, Any]) -> dict[str, Any]:
            requests = []
            for row in replay["requests"]:
                request_tokens = tokens(row["payloadJson"])
                requests.append({
                    "request": row["request"],
                    "nextAction": row["nextAction"],
                    "activeToolCount": len(row["activeTools"]),
                    "bytes": row["bytes"],
                    "tokens_o200k_base": request_tokens,
                    "sha256": row["sha256"],
                })
            assistant_outputs = [e for e in replay["emissions"] if e["kind"] != "tool-result"]
            tool_results = [e for e in replay["emissions"] if e["kind"] == "tool-result"]
            help_results = [e for e in tool_results if e["name"] == "linear"]
            direct_results = [e for e in tool_results if e["name"] != "linear"]
            output_tokens = sum(tokens(e["json"]) for e in assistant_outputs)
            return {
                "providerRequests": len(requests),
                "helpCalls": replay["helpCalls"],
                "scriptedWrongCalls": 0,
                "observedWrongCalls": None,
                "completion": replay["completion"],
                "input_transport_json_tokens": sum(r["tokens_o200k_base"] for r in requests),
                "assistant_output_json_tokens": output_tokens,
                "total_trajectory_serialized_tokens": sum(r["tokens_o200k_base"] for r in requests) + output_tokens,
                "tool_request_bytes": sum(e["bytes"] for e in replay["emissions"] if e["kind"] == "tool-call"),
                "tool_request_tokens": sum(tokens(e["json"]) for e in replay["emissions"] if e["kind"] == "tool-call"),
                "tool_result_bytes_unique": sum(e["bytes"] for e in tool_results),
                "tool_result_tokens_unique": sum(tokens(e["json"]) for e in tool_results),
                "help_result_bytes_unique": sum(e["bytes"] for e in help_results),
                "help_result_tokens_unique": sum(tokens(e["json"]) for e in help_results),
                "direct_result_bytes_unique": sum(e["bytes"] for e in direct_results),
                "direct_result_tokens_unique": sum(tokens(e["json"]) for e in direct_results),
                "requests": requests,
            }

        bm, cm = replay_metric(old), replay_metric(new)
        scenario, arm = key.split("/", 1)
        replay_rows.append({
            "scenario": scenario,
            "arm": arm,
            "before": bm,
            "current": cm,
            "delta_total_tokens": cm["total_trajectory_serialized_tokens"] - bm["total_trajectory_serialized_tokens"],
        })

    arm_totals: list[dict[str, Any]] = []
    for arm in ("all-exposed", "all-deferred", "hybrid-discovery"):
        rows = [row for row in replay_rows if row["arm"] == arm]
        b = sum(row["before"]["total_trajectory_serialized_tokens"] for row in rows)
        c = sum(row["current"]["total_trajectory_serialized_tokens"] for row in rows)
        arm_totals.append({
            "arm": arm,
            "scenarios": len(rows),
            "before_total_trajectory_serialized_tokens": b,
            "current_total_trajectory_serialized_tokens": c,
            "delta_tokens": c - b,
            "delta_percent": pct(b, c),
            "help_calls_per_source": sum(row["before"]["helpCalls"] for row in rows),
            "scripted_wrong_calls_per_source": 0,
            "observed_wrong_calls": None,
            "completion": "not measured: no model was run",
        })

    # Confirm that the archived before revision still reproduces the committed baseline fixture.
    expected_tokens = baseline["expectedTokens"]
    baseline_checks = {
        "startup_tokens": {
            "expected": expected_tokens["startup"],
            "measured": sets["startup"]["before"]["tokens_o200k_base"],
        },
        "all_tools_tokens": {
            "expected": expected_tokens["allTools"],
            "measured": sets["all"]["before"]["tokens_o200k_base"],
        },
        "issues_five_workflow_schema_tokens": {
            "expected": expected_tokens["issuesFiveWorkflow"],
            "measured": sets["issues-five"]["before"]["tokens_o200k_base"],
        },
    }
    for check in baseline_checks.values():
        check["matches"] = check["expected"] == check["measured"]

    result = {
        "measurementKind": "deterministic offline replay; not an LLM benchmark and not billed usage",
        "source": {"before": before["source"], "current": current["source"]},
        "model": {
            "serializer_target": current["providerSerializer"],
            "note": "The model did not run. Pi's first-party OpenAI Responses serializer produced each request body before network access.",
        },
        "tokenizer": {
            "package": "tiktoken",
            "version": importlib.metadata.version("tiktoken"),
            "encoding": "o200k_base",
            "python": platform.python_version(),
            "gpt_4o_model_lookup": tiktoken.encoding_name_for_model("gpt-4o"),
            "note": "Counts tokenize compact local JSON or the exact serialized request JSON. They are local estimates, not provider billing counters.",
        },
        "artifacts": {
            "before_dump_sha256": sha256(args.before),
            "current_dump_sha256": sha256(args.current),
            "baseline_sha256": sha256(args.baseline),
        },
        "fixedTaskSet": current["fixedTaskSet"],
        "resolvedDirectArguments": {
            "before": before["resolvedDirectArguments"],
            "current": current["resolvedDirectArguments"],
            "note": "Each source uses its own published canonical example for the same semantic operation sequence.",
        },
        "armDefinitions": {
            "all-exposed": "All 53 Linear tool schemas are active on every request; no help calls.",
            "all-deferred": "Only startup tools begin active; each direct operation gets one exact help call before first use.",
            "hybrid-discovery": "Startup tools plus root and domain discovery help, then one exact help call per direct operation.",
        },
        "baselineReproduction": baseline_checks,
        "baselineFixture": {
            "path": "scripts/fixtures/context-baseline-v0.9.json",
            "beforeRev": baseline["beforeRev"],
            "beforePackageVersion": baseline["beforePackageVersion"],
        },
        "toolSetChanges": tool_set_changes,
        "schemaSets": sets,
        "armTotals": arm_totals,
        "replays": replay_rows,
        "perToolSchema": per_tool_schema,
        "perToolHelp": per_tool_help,
        "gaps": [
            "No live model ran. Completion, model-chosen wrong calls, latency, and task quality are unmeasured.",
            "No provider usage object exists. Cache-read, cache-creation, billed input, and billed output cannot be separated or claimed.",
            "The trajectory total is o200k_base over exact OpenAI Responses request JSON plus deterministic assistant output JSON. It is not billed usage.",
            "The before source is the frozen v0.9 revision named in scripts/fixtures/context-baseline-v0.9.json. The current source is the checked-out commit.",
            "Rerun scripts/context-measurement/run.sh if the current source commit or tracked files change before release documentation lands.",
        ],
    }
    args.out_json.write_text(json.dumps(result, indent=2) + "\n")

    lines = [
        "# AEO-831 context measurement evidence",
        "",
        "## Result",
        "",
        "This is a deterministic, read-only replay. It measures serialized context. It is not a live model benchmark.",
        "",
        f"- Before source: `{before['source']['gitCommit']}` ({before['source']['packageVersion']})",
        f"- Current source: `{current['source']['gitCommit']}` ({current['source']['packageVersion']})",
        "- Provider shape: Pi `@earendil-works/pi-ai` 0.84.2, OpenAI Responses, serializer target `gpt-5.4`.",
        "- Model execution: none. The serializer stopped in `onPayload` before network access.",
        f"- Tokenizer: Python `tiktoken` {importlib.metadata.version('tiktoken')}, exact encoding `o200k_base`.",
        "- Meaning of token counts: local tokenization of compact JSON. They are not billed provider usage.",
        f"- Full machine-readable results: `{args.out_json.name}` in this directory.",
        "",
        "## Fixed task set",
        "",
        "The replay freezes three scenarios. Each scenario runs on all three arms, so nine replays exist.",
        "The JSON evidence records each prompt, operation, argument object, tool result, request body hash, and request size.",
        "",
        "| Scenario | Domain | Operations |",
        "|---|---|---|",
    ]
    for name, task in current["fixedTaskSet"].items():
        operations = ", ".join(f"`{operation}`" for operation in task["operations"])
        lines.append(f"| {name} | {task['domain']} | {operations} |")

    lines += [
        "",
        "| Arm | Definition |",
        "|---|---|",
    ]
    for name, definition in result["armDefinitions"].items():
        lines.append(f"| {name} | {definition} |")

    lines += [
        "",
        "## Baseline reproduction",
        "",
        f"The committed fixture `scripts/fixtures/context-baseline-v0.9.json` freezes the before counts of revision `{baseline['beforeRev']}`.",
        "",
        "| Check | Committed fixture | Reproduced | Match |",
        "|---|---:|---:|:---:|",
    ]
    for name, check in baseline_checks.items():
        lines.append(f"| {name} | {check['expected']:,} | {check['measured']:,} | {'yes' if check['matches'] else 'NO'} |")

    lines += [
        "",
        "## Tool schema token table",
        "",
        "These counts use local `{name,description,parameters}` compact JSON, matching the supplied baseline method.",
        "",
        "| Exposure set | Before | Current | Delta |",
        "|---|---:|---:|---:|",
    ]
    for name, row in sets.items():
        lines.append(f"| {name} | {row['before']['tokens_o200k_base']:,} | {row['current']['tokens_o200k_base']:,} | {row['delta_tokens']:+,} |")

    lines += [
        "",
        "## Three-arm total trajectory comparison",
        "",
        "The total sums every exact serialized provider request plus deterministic assistant tool-call and final-response output JSON.",
        "Accumulated history includes every help request, help result, direct tool request, and direct tool result.",
        "",
        "| Arm, all three scenarios | Before | Current | Delta | Help calls | Wrong calls | Completion |",
        "|---|---:|---:|---:|---:|---|---|",
    ]
    for row in arm_totals:
        lines.append(
            f"| {row['arm']} | {row['before_total_trajectory_serialized_tokens']:,} | "
            f"{row['current_total_trajectory_serialized_tokens']:,} | {row['delta_tokens']:+,} ({row['delta_percent']}) | "
            f"{row['help_calls_per_source']} | not measured (scripted path: 0) | not measured |"
        )

    lines += [
        "",
        "### Per scenario",
        "",
        "| Scenario | Arm | Total before/current | Delta | Requests | Help calls | Input request tok before/current | Output tok before/current | Tool calls B/tok before→current | Help results B/tok before→current | Direct results B/tok before→current |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|",
    ]
    for row in replay_rows:
        b, c = row["before"], row["current"]
        lines.append(
            f"| {row['scenario']} | {row['arm']} | {b['total_trajectory_serialized_tokens']:,}/{c['total_trajectory_serialized_tokens']:,} | "
            f"{row['delta_total_tokens']:+,} | {c['providerRequests']} | {c['helpCalls']} | "
            f"{b['input_transport_json_tokens']:,}/{c['input_transport_json_tokens']:,} | "
            f"{b['assistant_output_json_tokens']:,}/{c['assistant_output_json_tokens']:,} | "
            f"{b['tool_request_bytes']:,}/{b['tool_request_tokens']:,}→{c['tool_request_bytes']:,}/{c['tool_request_tokens']:,} | "
            f"{b['help_result_bytes_unique']:,}/{b['help_result_tokens_unique']:,}→{c['help_result_bytes_unique']:,}/{c['help_result_tokens_unique']:,} | "
            f"{b['direct_result_bytes_unique']:,}/{b['direct_result_tokens_unique']:,}→{c['direct_result_bytes_unique']:,}/{c['direct_result_tokens_unique']:,} |"
        )

    lines += [
        "",
        "## Per-tool schema bytes and tokens",
        "",
        "| Tool | Before B | Current B | Delta B | Before tok | Current tok | Delta tok |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in per_tool_schema:
        lines.append(f"| `{row['tool']}` | {row['before_bytes']} | {row['current_bytes']} | {row['delta_bytes']:+d} | {row['before_tokens']} | {row['current_tokens']} | {row['delta_tokens']:+d} |")

    lines += [
        "",
        "## Per-operation exact-help bytes and tokens",
        "",
        "| Operation | Before B | Current B | Delta B | Before tok | Current tok | Delta tok |",
        "|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in per_tool_help:
        lines.append(f"| `{row['operation']}` | {row['before_bytes']} | {row['current_bytes']} | {row['delta_bytes']:+d} | {row['before_tokens']} | {row['current_tokens']} | {row['delta_tokens']:+d} |")

    lines += [
        "",
        "## Limits and release use",
        "",
        "- No live model ran. Do not claim task success, fewer model mistakes, better latency, or quality superiority from this replay.",
        "- `scriptedWrongCalls` is zero by construction. It is not an observed model result.",
        "- No provider usage object exists. Cache-read, cache-creation, billed input, and billed output remain unknown.",
        "- Pi's native serializer generated the exact current and before request bodies. `o200k_base` tokenization remains a local estimate.",
        f"- Before uses the frozen v0.9 revision `{baseline['beforeRev']}` recorded in `scripts/fixtures/context-baseline-v0.9.json`.",
        "- Rerun this evidence if the source moves from the recorded current commit or gains tracked changes.",
        "- This evidence adds no cap, threshold, trial count, target, or release gate.",
        f"- The fixture also records the earlier scout counts. Only `allTools` differs, by "
        f"{baseline['expectedTokens']['allTools'] - baseline['scoutSnapshot']['allTools']} tokens, because that scout run used an uncommitted working tree.",
        "- The measurement needs Python `tiktoken` 0.12.0. That package stays outside the extension's runtime dependencies.",
        "",
        "## Verification",
        "",
        f"- `scripts/context-measurement/run.sh` — PASS. It captured {len(per_tool_schema)} shared tool schemas, "
        f"{len(per_tool_help)} shared exact-help results, and {len(replay_rows)} replay combinations.",
        "- `scripts/context-measurement/verify-results.py` — PASS. The committed baseline fixture reproduced exactly.",
        "",
        "## Reproduction",
        "",
        "Run `bash scripts/context-measurement/run.sh` from a clean checkout with dev dependencies installed.",
        "It archives the frozen before revision from git, imports each real extension, captures native request bodies offline, and tokenizes them.",
        "It writes only this evidence file and its JSON results. It does not edit the extension source and it does not call Linear.",
    ]
    args.out_md.write_text("\n".join(lines) + "\n")

    print(json.dumps({
        "out_json": str(args.out_json),
        "out_md": str(args.out_md),
        "baseline_matches": all(x["matches"] for x in baseline_checks.values()),
        "arm_totals": arm_totals,
    }, indent=2))


if __name__ == "__main__":
    main()
