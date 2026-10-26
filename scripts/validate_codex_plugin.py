#!/usr/bin/env python3
"""Validate the Basic Memory Codex plugin layout."""

from __future__ import annotations

import argparse
import json
import os
import re
from pathlib import Path
from typing import Any

from validate_skills import parse_frontmatter


REQUIRED_SKILLS = (
    "bm-setup",
    "bm-orient",
    "bm-checkpoint",
    "bm-decide",
    "bm-remember",
    "bm-writing",
    "bm-share",
    "bm-status",
    "bm-capture",
)
# Check machine contracts rather than translated prose so localized skills can
# evolve without making the package validator depend on a particular language.
REQUIRED_SKILL_TEXT: dict[str, tuple[str, ...]] = {
    "bm-setup": (
        "checkpointOnCompact",
        "captureEvents",
        "semanticCapture",
        "sessionProfile",
        "coding-session.md",
        'default_tools_approval_mode = "approve"',
    ),
    "bm-status": ("hook status --harness codex", "memory_review.py", "pending", "expired"),
    "bm-orient": ("codex_session", "coding_session", "repository"),
    "bm-checkpoint": ("session_id", "overwrite=False", 'output_format="json"', "## Relations"),
    "bm-decide": ("codex/decisions",),
    "bm-remember": ("codex/remember",),
    "bm-writing": ("## Observations", "## Relations"),
    "bm-capture": ("receipt", "saved", "no_memory", "pending", "drafts"),
}
REQUIRED_SCHEMAS = ("codex-session.md", "coding-session.md", "decision.md", "task.md")
REQUIRED_HOOKS = {
    "SessionStart": "hooks/session_start.py",
    "PreCompact": "hooks/pre_compact.py",
    "UserPromptSubmit": "hooks/memory_review.py",
    "Stop": "hooks/memory_review.py",
    "SessionEnd": "hooks/session_end_capture.py",
}
REQUIRED_HOOK_EVENTS = tuple(REQUIRED_HOOKS)
# Lifecycle shims use the pinned core; semantic review is a local, standard-library script.
REQUIRED_HOOK_SCRIPTS = tuple(dict.fromkeys(REQUIRED_HOOKS.values()))
REQUIRED_SKILL_AGENT_FILES = ("agents/openai.yaml", "assets/icon.svg")
REQUIRED_INTERFACE_ASSETS = {
    "composerIcon": "assets/app-icon.png",
    "logo": "assets/logo.png",
}
HOOK_SCRIPT_PATH_RE = re.compile(r"\$\{PLUGIN_ROOT\}/(hooks/[A-Za-z0-9_./-]+\.py)")
HOOK_DEPENDENCY_RE = re.compile(
    r'"basic-memory @ git\+https://github\.com/'
    r'[^/]+/basic-memory@([^"]+)"'
)


def read_json(path: Path) -> dict[str, Any]:
    try:
        payload = json.loads(path.read_text())
    except FileNotFoundError:
        raise SystemExit(f"Missing JSON file: {path}") from None
    except json.JSONDecodeError as exc:
        raise SystemExit(f"{path}: invalid JSON: {exc}") from None
    if not isinstance(payload, dict):
        raise SystemExit(f"{path}: expected a JSON object")
    return payload


def require_path(path: Path, label: str) -> None:
    if not path.exists():
        raise SystemExit(f"Missing {label}: {path}")


def validate_plugin(plugin_dir: Path) -> None:
    plugin_dir = plugin_dir.resolve()

    # --- Manifest ---
    manifest_path = plugin_dir / ".codex-plugin" / "plugin.json"
    manifest = read_json(manifest_path)
    if manifest.get("name") != "codex":
        raise SystemExit(f"{manifest_path}: expected name=codex")
    if manifest.get("skills") != "./skills/":
        raise SystemExit(f"{manifest_path}: expected skills=./skills/")
    if manifest.get("mcpServers") != "./.mcp.json":
        raise SystemExit(f"{manifest_path}: expected mcpServers=./.mcp.json")
    interface = manifest.get("interface")
    if not isinstance(interface, dict):
        raise SystemExit(f"{manifest_path}: missing interface object")
    if not isinstance(interface.get("displayName"), str) or not interface["displayName"].strip():
        raise SystemExit(f"{manifest_path}: unexpected interface.displayName")
    for field, expected_path in REQUIRED_INTERFACE_ASSETS.items():
        if interface.get(field) != f"./{expected_path}":
            raise SystemExit(f"{manifest_path}: expected interface.{field}=./{expected_path}")
        require_path(plugin_dir / expected_path, f"interface.{field} asset")

    # --- MCP ---
    mcp = read_json(plugin_dir / ".mcp.json")
    servers = mcp.get("mcpServers")
    if not isinstance(servers, dict) or "basic-memory" not in servers:
        raise SystemExit(".mcp.json: expected mcpServers.basic-memory")
    basic_memory = servers["basic-memory"]
    if not isinstance(basic_memory, dict):
        raise SystemExit(".mcp.json: basic-memory server must be an object")
    if basic_memory.get("command") not in {"uvx", "basic-memory", "bm"}:
        raise SystemExit(".mcp.json: basic-memory server uses an unexpected command")

    # --- Hooks ---
    hooks_json = read_json(plugin_dir / "hooks" / "hooks.json")
    hooks = hooks_json.get("hooks")
    if not isinstance(hooks, dict):
        raise SystemExit("hooks/hooks.json: expected hooks object")
    if set(hooks) != set(REQUIRED_HOOK_EVENTS):
        raise SystemExit(
            "hooks/hooks.json: expected exactly these hook events: "
            + ", ".join(REQUIRED_HOOK_EVENTS)
        )
    for event, expected_script in REQUIRED_HOOKS.items():
        matcher_groups = hooks[event]
        if not isinstance(matcher_groups, list) or len(matcher_groups) != 1:
            raise SystemExit(f"hooks/hooks.json: {event} must define exactly one matcher group")
        matcher_group = matcher_groups[0]
        command_hooks = matcher_group.get("hooks") if isinstance(matcher_group, dict) else None
        if not isinstance(command_hooks, list) or len(command_hooks) != 1:
            raise SystemExit(f"hooks/hooks.json: {event} must define exactly one command hook")
        command_hook = command_hooks[0]
        if not isinstance(command_hook, dict) or command_hook.get("type") != "command":
            raise SystemExit(f"hooks/hooks.json: {event} hook must have type=command")
        command = command_hook.get("command")
        if not isinstance(command, str):
            raise SystemExit(f"hooks/hooks.json: {event} hook must define a command")
        if event in {"UserPromptSubmit", "Stop"}:
            verb = "prompt" if event == "UserPromptSubmit" else "stop"
            if command_hook.get("async", False) is not False or not command.endswith(f" {verb}"):
                raise SystemExit(f"hooks/hooks.json: {event} requires synchronous {verb}")
        if event == "SessionEnd" and command_hook.get("async", False) is not False:
            raise SystemExit("hooks/hooks.json: SessionEnd must run synchronously")
        script_refs = HOOK_SCRIPT_PATH_RE.findall(command)
        if script_refs != [expected_script]:
            raise SystemExit(f"hooks/hooks.json: {event} must reference exactly {expected_script}")
    hook_files = {
        f"hooks/{path.name}"
        for path in (plugin_dir / "hooks").iterdir()
        if path.is_file() and path.name != "hooks.json" and not path.name.startswith("test_")
    }
    if hook_files != set(REQUIRED_HOOK_SCRIPTS):
        raise SystemExit(
            "hooks/: expected exactly these non-test hook scripts: "
            + ", ".join(REQUIRED_HOOK_SCRIPTS)
        )
    dependency_refs: set[str] = set()
    for rel in REQUIRED_HOOK_SCRIPTS:
        script = plugin_dir / rel
        require_path(script, "hook script")
        if not os.access(script, os.X_OK):
            raise SystemExit(f"Hook script is not executable: {script}")
        text = script.read_text(encoding="utf-8")
        if rel in {"hooks/memory_review.py", "hooks/session_end_capture.py"}:
            if "# /// script" not in text or "# dependencies = []" not in text:
                raise SystemExit(f"Hook must be a dependency-free uv script: {script}")
            continue
        dependency_match = HOOK_DEPENDENCY_RE.search(text)
        if "# /// script" not in text or dependency_match is None:
            raise SystemExit(f"Hook script missing pinned Basic Memory Git dependency: {script}")
        dependency_refs.add(dependency_match.group(0))
    if len(dependency_refs) != 1:
        raise SystemExit("Codex hook scripts must use the same Basic Memory Git ref")

    # --- Skills ---
    skills_root = plugin_dir / "skills"
    require_path(skills_root, "skills directory")
    present = {path.name for path in skills_root.iterdir() if path.is_dir()}
    for skill_name in REQUIRED_SKILLS:
        if skill_name not in present:
            raise SystemExit(f"Missing required skill: skills/{skill_name}/SKILL.md")
    for skill_dir in sorted(path for path in skills_root.iterdir() if path.is_dir()):
        skill_file = skill_dir / "SKILL.md"
        require_path(skill_file, "skill file")
        frontmatter = parse_frontmatter(skill_file)
        if frontmatter.get("name") != skill_dir.name:
            raise SystemExit(f"{skill_file}: name must match directory")
        if not frontmatter.get("description"):
            raise SystemExit(f"{skill_file}: missing description")
        skill_text = skill_file.read_text(encoding="utf-8")
        for required_text in REQUIRED_SKILL_TEXT.get(skill_dir.name, ()):
            if required_text not in skill_text:
                raise SystemExit(f"{skill_file}: missing plugin contract text {required_text!r}")
        for rel in REQUIRED_SKILL_AGENT_FILES:
            require_path(skill_dir / rel, f"skill {rel}")

    # --- Schemas ---
    schemas_root = plugin_dir / "schemas"
    require_path(schemas_root, "schemas directory")
    for schema_name in REQUIRED_SCHEMAS:
        schema_file = schemas_root / schema_name
        require_path(schema_file, "schema")
        frontmatter = parse_frontmatter(schema_file)
        if frontmatter.get("type") != "schema":
            raise SystemExit(f"{schema_file}: expected type: schema")
        if not frontmatter.get("entity"):
            raise SystemExit(f"{schema_file}: missing entity")

    readme = (plugin_dir / "README.md").read_text(encoding="utf-8")
    for required_text in (
        "lifecycle trace stays local",
        "post-compaction `SessionStart`",
        "note is agent-authored",
        '[plugins."codex@basic-memory".mcp_servers.basic-memory]',
        "[mcp_servers.basic-memory]",
        'default_tools_approval_mode = "approve"',
    ):
        if required_text not in readme:
            raise SystemExit(f"README.md: missing schema ownership text {required_text!r}")

    print(f"validated Codex plugin in {plugin_dir}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("plugin_dir", nargs="?", default="plugins/codex")
    args = parser.parse_args()
    validate_plugin(Path.cwd() / args.plugin_dir)


if __name__ == "__main__":
    main()
