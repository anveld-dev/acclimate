import asyncio
import os
from pathlib import Path
import tempfile
import unittest

from acclimate import (
    DeliveryError,
    SkillLookup,
    extract_bundle_skills,
    render_bundle_prompt,
    system_prompt,
    telemetry_attributes,
)
from acclimate.integrations import claude, langchain, openai_agents, pydantic_ai


def _verified_bundle() -> dict:
    return {
        "version": {
            "id": "ver-int-1",
            "bundleId": "bun-int",
            "parentVersionId": None,
            "digest": "sha256:int1",
            "createdAt": "2026-11-27T00:00:00Z",
        },
        "payload": {
            "schemaVersion": 1,
            "files": [
                {"path": "instructions.md", "kind": "instruction", "text": "Be precise."},
                {
                    "path": "skills/triage/SKILL.md",
                    "kind": "skill",
                    "text": "---\nname: triage\ndescription: Triage tickets\n---\nCheck severity.",
                },
                {
                    "path": "skills/triage/rubric.md",
                    "kind": "skill",
                    "text": "P0 = outage.",
                },
                {"path": "memory/vip.md", "kind": "memory", "text": "VIP customer."},
            ],
        },
        "resolution": {
            "channel": "stable",
            "revision": "5",
            "version": {
                "id": "ver-int-1",
                "bundleId": "bun-int",
                "parentVersionId": None,
                "digest": "sha256:int1",
                "createdAt": "2026-11-27T00:00:00Z",
            },
        },
        "resolvedAt": 0,
        "stale": False,
    }


class IntegrationsTest(unittest.TestCase):
    def test_skills_and_telemetry_helpers(self) -> None:
        verified = _verified_bundle()
        self.assertEqual(render_bundle_prompt(verified["payload"]), system_prompt(verified["payload"]))
        skills = extract_bundle_skills(verified["payload"])
        self.assertEqual(len(skills), 1)
        self.assertEqual(skills[0].name, "triage")
        self.assertEqual(skills[0].description, "Triage tickets")
        lookup = SkillLookup(verified["payload"])
        self.assertEqual(lookup.read_skill("triage", "rubric.md"), "P0 = outage.")
        with self.assertRaises(DeliveryError):
            lookup.read_skill("missing")
        attrs = telemetry_attributes(verified)
        self.assertEqual(attrs["acclimate.channel"], "stable")
        self.assertEqual(attrs["acclimate.version_id"], "ver-int-1")

    def test_claude_integration_stages_workspace_and_overlay(self) -> None:
        verified = _verified_bundle()
        with tempfile.TemporaryDirectory() as base:
            real_base = os.path.realpath(base)
            mcp_path = Path(real_base) / ".mcp.json"
            mcp_path.write_text('{"mcpServers":{}}', encoding="utf-8")
            with claude.prepare(verified, base_dir=real_base, approved_memory_paths=[]) as prepared:
                self.assertTrue(Path(prepared.cwd, "CLAUDE.md").is_file())
                self.assertEqual(
                    Path(prepared.cwd, "CLAUDE.md").read_text(encoding="utf-8"), "Be precise."
                )
                self.assertTrue(Path(prepared.cwd, ".claude/skills/triage/SKILL.md").is_file())
                self.assertTrue(Path(prepared.cwd, ".claude/skills/triage/rubric.md").is_file())
                self.assertTrue(Path(prepared.cwd, ".mcp.json").is_file())
                self.assertEqual(prepared.memory_files, [])
                self.assertFalse(Path(prepared.cwd, ".acclimate/memory/memory/vip.md").exists())
                self.assertEqual(len(prepared.overlay_files), 1)
                opts = claude.claude_session_options(prepared)
                self.assertEqual(opts["cwd"], prepared.cwd)
                self.assertEqual(opts["setting_sources"], ["project"])
                self.assertEqual(opts["skills"], ["triage"])
                cwd = prepared.cwd
                prepared.cwd = "/tmp/should-not-be-deleted"
            self.assertFalse(os.path.exists(cwd))

        with tempfile.TemporaryDirectory() as base, tempfile.TemporaryDirectory() as outside:
            real_base = os.path.realpath(base)
            real_outside = os.path.realpath(outside)
            (Path(real_outside) / "settings.json").write_text("{}", encoding="utf-8")
            os.symlink(real_outside, Path(real_base) / ".claude")
            with self.assertRaises(DeliveryError):
                claude.prepare(verified, base_dir=real_base)

        with tempfile.TemporaryDirectory() as base, tempfile.TemporaryDirectory() as outside:
            real_base = os.path.realpath(base)
            real_outside = os.path.realpath(outside)
            nested = Path(real_outside) / "proj"
            nested.mkdir()
            (nested / ".mcp.json").write_text("{}", encoding="utf-8")
            symlink_parent = Path(real_base) / "linked"
            os.symlink(real_outside, symlink_parent)
            with self.assertRaises(DeliveryError):
                claude.prepare(verified, base_dir=str(symlink_parent / "proj"))

        bad_skill = _verified_bundle()
        bad_skill["payload"]["files"][1]["text"] = "---\nname: wrong\ndescription: oops\n---\nbody"
        with self.assertRaises(DeliveryError):
            claude.prepare(bad_skill)

    def test_openai_agents_integration(self) -> None:
        verified = _verified_bundle()

        async def run() -> None:
            async with openai_agents.prepare(
                verified, include_skills_in_prompt=False, approved_memory_paths=[]
            ) as prepared:
                prompt = prepared.instructions()
                self.assertIn("Be precise.", prompt)
                self.assertNotIn("Check severity.", prompt)
                self.assertEqual(prepared.trace_metadata["acclimate.version_id"], "ver-int-1")
                self.assertEqual(prepared.trace_metadata["acclimate.stale"], "false")
                hooks = prepared.run_hooks()
                await hooks.on_agent_start()
                await hooks.on_llm_start()
                await hooks.on_llm_end()
                await hooks.on_tool_start()
                await hooks.on_tool_end()
                await hooks.on_handoff()
                await hooks.on_agent_end()
                list_fn, read_fn = prepared.skill_tools()
                self.assertEqual(list_fn()[0]["name"], "triage")
                self.assertIn("Check severity.", read_fn("triage", None))

        asyncio.run(run())

    def test_langchain_integration(self) -> None:
        verified = _verified_bundle()
        with langchain.prepare(verified) as prepared:
            self.assertEqual(prepared.system_message[0], "system")
            self.assertIn("Be precise.", prepared.system_message[1])
            cfg = prepared.runnable_config(
                {"metadata": {"env": "prod"}, "tags": ("t1",), "callbacks": ["user_handler"]}
            )
            self.assertEqual(cfg["metadata"]["acclimate.version_id"], "ver-int-1")
            self.assertEqual(cfg["metadata"]["env"], "prod")
            self.assertIn("t1", cfg["tags"])
            self.assertIn("acclimate:channel:stable", cfg["tags"])
            self.assertEqual(len(cfg["callbacks"]), 2)
            self.assertEqual(cfg["callbacks"][0], "user_handler")
            cfg["callbacks"][1].on_chat_model_start()

            class FakeManager:
                def __init__(self) -> None:
                    self.handlers: list = []

                def copy(self) -> "FakeManager":
                    cloned = FakeManager()
                    cloned.handlers = list(self.handlers)
                    return cloned

                def add_handler(self, handler: object) -> None:
                    self.handlers.append(handler)

            mgr = FakeManager()
            cfg_mgr = prepared.runnable_config({"callbacks": mgr})
            self.assertIsNot(cfg_mgr["callbacks"], mgr)
            self.assertEqual(len(cfg_mgr["callbacks"].handlers), 1)
            list_fn, read_fn = prepared.skill_tools()
            self.assertEqual(list_fn()[0]["name"], "triage")
            self.assertEqual(read_fn("triage", "rubric.md"), "P0 = outage.")

    def test_pydantic_ai_integration(self) -> None:
        verified = _verified_bundle()

        async def run() -> None:
            async with pydantic_ai.prepare(verified, include_skills_in_prompt=False) as prepared:
                self.assertIn("Be precise.", prepared.instructions())
                self.assertEqual(prepared.telemetry_attributes["acclimate.bundle_id"], "bun-int")
                list_fn, read_fn = prepared.skill_tools()
                self.assertEqual(list_fn()[0]["name"], "triage")
                self.assertIn("Check severity.", read_fn("triage", None))

        asyncio.run(run())


if __name__ == "__main__":
    unittest.main()
