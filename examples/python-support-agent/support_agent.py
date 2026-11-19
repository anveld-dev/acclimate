"""A toy customer-support agent that runs offline.

The agent retrieves knowledge-base articles by keyword and then calls a fake
model. The fake model is deterministic, makes no network calls and follows a few
directives in the system prompt, so changing the prompt changes the answers the
same way it would with a real model. Replace ``fake_model`` with your model
client to evaluate a real agent.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
from pathlib import Path
import re

HERE = Path(__file__).resolve().parent
KNOWLEDGE_BASE = HERE / "knowledge_base.json"


@dataclass(frozen=True)
class Article:
    id: str
    title: str
    keywords: tuple[str, ...]
    answer: str


@dataclass(frozen=True)
class Reply:
    text: str
    citations: tuple[str, ...]
    escalated: bool
    input_tokens: int
    output_tokens: int


def load_knowledge_base(path: Path = KNOWLEDGE_BASE) -> list[Article]:
    rows = json.loads(path.read_text(encoding="utf-8"))
    return [Article(row["id"], row["title"], tuple(row["keywords"]), row["answer"]) for row in rows]


def words(text: str) -> set[str]:
    return set(re.findall(r"[a-z]+", text.lower()))


def retrieve(question: str, articles: list[Article], limit: int = 2) -> list[Article]:
    """Rank articles by keyword overlap with the question."""
    asked = words(question)
    scored = [(len(asked & set(article.keywords)), article) for article in articles]
    return [article for score, article in sorted(scored, key=lambda item: -item[0]) if score > 0][:limit]


def fake_model(system_prompt: str, question: str, documents: list[Article]) -> Reply:
    """Stand-in for a model call. Its behavior follows directives in the system prompt."""
    prompt = system_prompt.lower()
    cite = "cite" in prompt
    escalate = "escalate" in prompt
    if documents:
        best = documents[0]
        text = best.answer
        citations = (best.id,) if cite else ()
        if cite:
            text += f" [{best.id}]"
        escalated = False
    elif escalate:
        text = "I don't have an article for that, so I'm passing you to a human agent."
        citations, escalated = (), True
    else:
        # Without an instruction to escalate, the "model" guesses.
        text = "Please try restarting the app and signing in again."
        citations, escalated = (), False
    return Reply(
        text=text,
        citations=citations,
        escalated=escalated,
        input_tokens=len((system_prompt + question).split()) + sum(len(d.answer.split()) for d in documents),
        output_tokens=len(text.split()),
    )


def answer(system_prompt: str, question: str, articles: list[Article] | None = None) -> Reply:
    articles = load_knowledge_base() if articles is None else articles
    return fake_model(system_prompt, question, retrieve(question, articles))


def score(reply: dict, expected: dict) -> tuple[float, dict]:
    """Grade one reply against the saved expectation. Returns a reward in [0, 1] and the checks."""
    checks = {
        "escalation": reply["escalated"] == expected["escalate"],
        "citation": expected.get("article") is None or expected["article"] in reply["citations"],
        "content": all(term.lower() in reply["text"].lower() for term in expected.get("mustMention", [])),
    }
    return sum(checks.values()) / len(checks), checks
