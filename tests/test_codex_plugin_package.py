import json
import re
import shutil
import subprocess
import sys
from pathlib import Path


def test_codex_plugin_mcp_config_is_tracked_and_not_ignored() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    rel_path = "plugins/codex/.mcp.json"

    ignored = subprocess.run(
        ["git", "check-ignore", "--quiet", rel_path],
        cwd=repo_root,
        check=False,
    )
    assert ignored.returncode == 1

    tracked = subprocess.run(
        ["git", "ls-files", "--error-unmatch", rel_path],
        cwd=repo_root,
        check=False,
        capture_output=True,
        text=True,
    )
    assert tracked.returncode == 0, tracked.stderr


def test_codex_plugin_lifecycle_shims_and_semantic_review_wiring() -> None:
    # Lifecycle launchers use the pinned core; semantic hooks ship with the plugin.
    repo_root = Path(__file__).resolve().parents[1]
    hooks_dir = repo_root / "plugins/codex/hooks"

    assert not (hooks_dir / "session-start.sh").exists()
    assert not (hooks_dir / "pre-compact.sh").exists()
    dependency_refs: set[str] = set()
    for script, verb in (
        ("session_start.py", "session-start"),
        ("pre_compact.py", "pre-compact"),
    ):
        text = (hooks_dir / script).read_text(encoding="utf-8")
        assert "# /// script" in text
        refs = re.findall(
            r'"basic-memory @ git\+https://github\.com/'
            r'[^/]+/basic-memory@([^"]+)"',
            text,
        )
        assert len(refs) == 1
        dependency_refs.add(refs[0])
        assert f'VERB = "{verb}"' in text
        assert 'HARNESS = "codex"' in text
    assert len(dependency_refs) == 1
    assert not (hooks_dir / "stop.py").exists()

    hooks = json.loads((hooks_dir / "hooks.json").read_text(encoding="utf-8"))["hooks"]
    assert set(hooks) == {
        "SessionStart",
        "PreCompact",
        "UserPromptSubmit",
        "Stop",
        "SessionEnd",
    }
    for event, verb in (("UserPromptSubmit", "prompt"), ("Stop", "stop")):
        handler = hooks[event][0]["hooks"][0]
        assert handler.get("async", False) is False
        assert "memory_review.py" in handler["command"]
        assert handler["command"].endswith(f" {verb}")
    session_end = hooks["SessionEnd"][0]["hooks"][0]
    assert session_end.get("async", False) is False
    assert session_end["command"].endswith('session_end_capture.py"')


def test_codex_plugin_validator_rejects_unsupported_hook_wiring(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[1]

    for case in ("retired-event", "wrong-script", "duplicate-command", "retired-script"):
        plugin_dir = tmp_path / case
        shutil.copytree(repo_root / "plugins/codex", plugin_dir)
        hooks_path = plugin_dir / "hooks" / "hooks.json"
        payload = json.loads(hooks_path.read_text(encoding="utf-8"))

        if case == "retired-event":
            payload["hooks"]["UnsupportedEvent"] = payload["hooks"]["PreCompact"]
        elif case == "wrong-script":
            command_hook = payload["hooks"]["PreCompact"][0]["hooks"][0]
            command_hook["command"] = command_hook["command"].replace("pre_compact.py", "stop.py")
        elif case == "duplicate-command":
            command_hooks = payload["hooks"]["PreCompact"][0]["hooks"]
            command_hooks.append(command_hooks[0].copy())
        else:
            (plugin_dir / "hooks" / "stop.py").write_text("# retired hook\n", encoding="utf-8")
        hooks_path.write_text(json.dumps(payload), encoding="utf-8")

        result = subprocess.run(
            [
                sys.executable,
                str(repo_root / "scripts" / "validate_codex_plugin.py"),
                str(plugin_dir),
            ],
            cwd=repo_root,
            check=False,
            capture_output=True,
            text=True,
        )

        assert result.returncode != 0
        assert "hooks/" in result.stderr


def test_release_recipes_pin_codex_hooks_to_the_release_tag() -> None:
    justfile = (Path(__file__).resolve().parents[1] / "justfile").read_text(encoding="utf-8")

    assert justfile.count('just set-codex-hook-version "{{version}}"') == 2
    assert 'just set-codex-hook-version "$(git rev-parse HEAD)"' not in justfile
    assert "plugins/codex/hooks/stop.py" not in justfile


def test_codex_plugin_marketplace_identity() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    marketplace = json.loads(
        (repo_root / ".agents/plugins/marketplace.json").read_text(encoding="utf-8")
    )

    assert marketplace["name"] == "basic-memory"
    assert marketplace["interface"]["displayName"] == "Basic Memory"
    assert marketplace["plugins"][0]["name"] == "codex"


def test_codex_plugin_docs_explain_global_install_and_repo_mapping() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    readme = (repo_root / "plugins/codex/README.md").read_text(encoding="utf-8")
    root_readme = (repo_root / "README.md").read_text(encoding="utf-8")

    assert "## Install" in readme
    assert 'codex plugin marketplace add "$(git rev-parse --show-toplevel)"' in readme
    assert "codex plugin add codex@basic-memory" in readme
    assert "Plugin installation is user-level in Codex" in readme
    assert "Selecting only `plugins/codex` omits" in readme
    assert "marketplace file should not" in readme
    assert "Configuration can live at user level in `~/.codex/basic-memory.json`" in readme
    assert "the nearest project file overrides only the keys it declares" in readme
    assert '"checkpointOnCompact": true' in readme
    assert '"rememberFolder": "codex/remember"' in readme
    assert "Checkpoint prompting is on by default" in readme
    assert "Decision notes default to `codex/decisions`" in readme
    assert "keep both the profile and checkout-specific repository" in readme
    assert "## Checkpoint and Resume" in readme
    assert "targets the configured `primaryProject`" in readme
    assert "disables overwrite" in readme
    assert "then file path, then title" in readme
    assert '$bm-orient "<exact checkpoint identifier>"' in readme
    assert "directly from the configured `primaryProject`" in readme
    assert "Recovered notes are" in readme
    assert "There are two supported approval choices" in readme
    assert "Pre-approve eligible Basic Memory MCP tools" in readme
    assert "writes, edits, and deletes may still" in readme
    assert "writes, edits, moves" not in readme
    assert '[plugins."codex@basic-memory".mcp_servers.basic-memory]' in readme
    assert "[mcp_servers.basic-memory]" in readme
    assert 'default_tools_approval_mode = "approve"' in readme
    assert 'approval_policy = "never"' in readme
    assert 'default_tools_approval_mode = "approve"' in root_readme
    assert "plugin-scoped configuration" in root_readme


def test_user_level_coding_profile_stays_with_repository_override() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    readme = (repo_root / "plugins/codex/README.md").read_text(encoding="utf-8")
    setup = (repo_root / "plugins/codex/skills/bm-setup/SKILL.md").read_text(encoding="utf-8")

    readme_blocks = re.findall(r"```json\n(.*?)\n```", readme, flags=re.DOTALL)
    shared_settings = json.loads(readme_blocks[0])["basicMemory"]
    project_settings = next(
        settings
        for settings in (json.loads(block)["basicMemory"] for block in readme_blocks[1:])
        if "sessionProfile" in settings
    )

    assert "sessionProfile" not in shared_settings
    assert project_settings == {
        "sessionProfile": "coding",
        "repository": "owner/repo",
    }
    assert "不要在共用用户文件写入 `sessionProfile`" in setup
    assert '"sessionProfile": "coding",\n    "repository": "owner/name"' in setup


def test_bm_setup_offers_default_or_server_wide_mcp_trust() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    setup = (repo_root / "plugins/codex/skills/bm-setup/SKILL.md").read_text(encoding="utf-8")

    for contract in (
        "请用户从以下两种方式中明确选择一种",
        "保留 Codex 默认审批方式",
        "预先批准 Basic Memory MCP server 的合格工具",
        "不要提供按单个工具或只放行写入操作的信任方案",
        "破坏性操作",
        '[plugins."codex@basic-memory".mcp_servers.basic-memory]',
        "[mcp_servers.basic-memory]",
        'default_tools_approval_mode = "approve"',
        '不得设置 `approval_policy = "never"`',
    ):
        assert contract in setup


def test_codex_manual_capture_defaults_share_codex_tree() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    setup = (repo_root / "plugins/codex/skills/bm-setup/SKILL.md").read_text(encoding="utf-8")
    decide = (repo_root / "plugins/codex/skills/bm-decide/SKILL.md").read_text(encoding="utf-8")
    remember = (repo_root / "plugins/codex/skills/bm-remember/SKILL.md").read_text(encoding="utf-8")

    assert '"rememberFolder": "codex/remember"' in setup
    assert "决策默认放 `codex/decisions`" in setup
    assert "否则使用 `codex/decisions`" in decide
    assert "`rememberFolder`，默认 `codex/remember`" in remember


def test_coding_session_schema_is_shared_across_host_plugins() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    codex_schema = (repo_root / "plugins/codex/schemas/coding-session.md").read_text(
        encoding="utf-8"
    )
    claude_schema = (repo_root / "plugins/claude-code/schemas/coding-session.md").read_text(
        encoding="utf-8"
    )

    assert codex_schema == claude_schema


def test_coding_checkpoint_skills_quote_pull_request_numbers() -> None:
    repo_root = Path(__file__).resolve().parents[1]

    for plugin in ("codex", "claude-code"):
        skill = (repo_root / "plugins" / plugin / "skills/bm-checkpoint/SKILL.md").read_text(
            encoding="utf-8"
        )
        assert 'pull_request_number: "123"' in skill


def test_bm_checkpoint_tells_a_story_and_uses_graph_semantics() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    skill = (repo_root / "plugins/codex/skills/bm-checkpoint/SKILL.md").read_text(encoding="utf-8")
    writing = (repo_root / "plugins/codex/skills/bm-writing/SKILL.md").read_text(encoding="utf-8")
    decide = (repo_root / "plugins/codex/skills/bm-decide/SKILL.md").read_text(encoding="utf-8")
    remember = (repo_root / "plugins/codex/skills/bm-remember/SKILL.md").read_text(encoding="utf-8")
    schema = (repo_root / "plugins/codex/schemas/codex-session.md").read_text(encoding="utf-8")

    assert ".github/basic-memory" not in skill
    for contract in (
        "每次调用都创建新检查点",
        "不得编辑、替换或追加到旧检查点",
        "overwrite=False",
        'output_format="json"',
        "write_note_overwrite_default",
        "action: created",
        "ALREADY_EXISTS",
        "session_id",
        "agent: codex",
        "codex_session_id",
        "字段冲突时拒绝匹配",
        "不得仅凭仓库、分支、主题、时间戳或生命周期信封推测",
        "## Relations",
        "continues [[",
        "relates_to [[",
        "[next_step]",
        "## References",
        "未推送",
        "permalink",
        "file_path",
    ):
        assert contract in skill
    for authored in (skill, decide, remember):
        assert "bm-writing" in authored
    for contract in ("## Observations", "## Relations", "relation_type", "不得编造"):
        assert contract in writing
    assert "username?: string" in schema
    assert "hostname?: string" in schema


def test_codex_checkpoint_has_no_plugin_redaction_gate() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    plugin_files = (
        repo_root / "plugins/codex/README.md",
        repo_root / "plugins/codex/skills/bm-checkpoint/SKILL.md",
        repo_root / "plugins/codex/skills/bm-setup/SKILL.md",
        repo_root / "plugins/codex/skills/bm-status/SKILL.md",
    )

    for path in plugin_files:
        text = path.read_text(encoding="utf-8")
        assert "checkpointPrivacyReview" not in text
        assert "redactKeys" not in text
        assert "redactPaths" not in text

    checkpoint = plugin_files[1].read_text(encoding="utf-8")
    assert "## Optional Privacy Review" not in checkpoint
    assert "Scrub **every string** passed to `write_note`" not in checkpoint


def test_bm_orient_supports_exact_topic_and_current_repo_routes() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    skill = (repo_root / "plugins/codex/skills/bm-orient/SKILL.md").read_text(encoding="utf-8")

    for contract in (
        "准确检查点",
        "按主题发现",
        "当前仓库",
        "primaryProject",
        "secondary",
        "repository",
        "省略 `coding_session` 结果",
        "最多展示三个",
        "不要将任意文件系统路径",
        "历史上下文",
        "不要写笔记、修改状态、提交或 stash",
    ):
        assert contract in skill


def test_infographics_skill_keeps_weekly_contract_and_bm_style_pool() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    skill = (repo_root / ".agents/skills/infographics/SKILL.md").read_text(encoding="utf-8")
    style_balance = (
        repo_root / ".agents/skills/infographics/references/style-balance.md"
    ).read_text(encoding="utf-8")
    prompt_blueprint = (
        repo_root / ".agents/skills/infographics/references/prompt-blueprint.md"
    ).read_text(encoding="utf-8")
    skill_flat = " ".join(skill.split())

    assert "Weekly image" in skill
    assert "2-Week Retro window" in skill
    assert "docs/assets/infographics/<year>-w<start-week>-w<end-week>.webp" in skill
    assert (
        "docs/assets/infographics/<start-year>-w<start-week>-<end-year>-w<end-week>.webp" in skill
    )
    assert "computer science college textbooks" in skill
    assert "classic literature subjects" in skill
    assert "Metal, Hard Rock, Punk, techno, soul, reggae" in skill
    assert "Star Wars inspired knockoff" in skill
    assert "WWII propaganda posters" in skill
    assert "Italian movie posters" in skill
    assert "space exploration and astronomy" in skill
    assert "paintings" in skill
    assert "abstract painting" in skill
    assert "classical landscape" in skill
    assert "Remington-inspired" in skill
    assert "Rembrandt-inspired" in skill
    assert "classic black-and-white photography" in skill
    assert "documentary" in skill
    assert "editorial photo essay" in skill
    assert "80's action movies" in skill
    assert "practical explosions" in skill
    assert "no direct actor likenesses" in skill
    assert "poster, scene, tableau, cover image" in skill_flat
    assert "image-first" in skill
    assert "--print-prompt" in skill
    assert "--dry-run" in skill
    assert "--visual-format" not in skill
    assert "--provenance-output" in skill
    assert "BM_INFOGRAPHIC_PROVENANCE:start" in skill
    assert "Image prompt sent to" not in skill
    assert "revised prompt" not in skill
    assert "star charts" in style_balance
    assert "editorial scene" in style_balance
    assert "painting, photograph" in style_balance
    assert "copyrighted characters, logos, or named fictional universes" in skill
    assert "retro game or classic app aesthetic" not in skill
    assert "BM style category" in style_balance
    assert "Chosen image form" in prompt_blueprint
    assert "Chosen BM style category" in prompt_blueprint


def test_pr_create_skill_delegates_to_current_pr_workflow() -> None:
    repo_root = Path(__file__).resolve().parents[1]
    skill = (repo_root / ".agents/skills/pr-create/SKILL.md").read_text(encoding="utf-8")
    skill_flat = " ".join(skill.split())

    assert "## Compatibility" in skill
    assert "## Workflow" in skill
    assert "$pr-create" in skill
    assert "`pull-request`" in skill
    assert "`pr-description`" in skill
    assert "`pr-review-loop`" in skill
    assert "`fix-pr-issues`" in skill
    assert "automatic PR-infographic workflow has been retired" in skill_flat
    assert "Do not wait for the deleted `BM Bossbot Approval` status" in skill_flat
    assert "<!-- BM_INFOGRAPHIC_THEME:start -->" not in skill
    assert "<!-- BM_INFOGRAPHIC_PROVENANCE:start -->" not in skill
    assert "never merges" in skill
    assert "Do not enable auto-merge" in skill
    assert "current-head gate" in skill


def test_codex_hook_fastmcp_pins_match_core_pyproject() -> None:
    """The direct dependency and effective override must both follow core."""
    repo_root = Path(__file__).resolve().parents[1]
    core = re.search(
        r'^\s*"fastmcp==([^"]+)",$', (repo_root / "pyproject.toml").read_text(), re.MULTILINE
    )
    assert core is not None
    for name in ("session_start.py", "pre_compact.py"):
        shim = (repo_root / "plugins/codex/hooks" / name).read_text()
        pins = re.findall(r'^#     "fastmcp==([^"]+)",$', shim, re.MULTILINE)
        assert pins == [core.group(1)], name
        overrides = re.findall(
            r'^# override-dependencies = \["fastmcp==([^\"]+)"\]$', shim, re.MULTILINE
        )
        assert overrides == [core.group(1)], name


def test_claude_validator_rejects_stale_fastmcp_override(tmp_path: Path) -> None:
    repo_root = Path(__file__).resolve().parents[1]
    plugin_dir = tmp_path / "claude-code"
    shutil.copytree(repo_root / "plugins/claude-code", plugin_dir)
    script = plugin_dir / "hooks/session_start.py"
    original = script.read_text()
    script.write_text(
        re.sub(
            r'override-dependencies = \["fastmcp==[^\"]+"\]',
            'override-dependencies = ["fastmcp==0.0.0"]',
            original,
        )
    )
    result = subprocess.run(
        [sys.executable, str(repo_root / "scripts/validate_claude_plugin.py"), str(plugin_dir)],
        capture_output=True,
        text=True,
        check=False,
    )
    assert result.returncode != 0
    assert "fastmcp override must match core pin" in result.stderr
