"""OpenAI-compatible Chat Completions for learning rollouts."""

from collections.abc import Callable
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import json
import os
import re
from time import sleep
from typing import Any
from urllib.error import HTTPError
from urllib.request import HTTPRedirectHandler, Request, build_opener

from .errors import AcclimateError
from .evaluation import _files
from .types import LearningJson, VerifiedVersion


class _TranscriptError(AcclimateError):
    def __init__(self, message: str, trace: str):
        super().__init__("learning.openai_response", message)
        self.trace = trace


class OpenAIHttpError(_TranscriptError):
    """An HTTP failure from the configured endpoint, with a redacted trace."""

    def __init__(self, status: int, trace: str):
        super().__init__(f"OpenAI-compatible endpoint returned HTTP {status}.", trace)
        self.status = status


class _NoRedirect(HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        return None


def _render_bundle(version: VerifiedVersion) -> str:
    return "\n\n".join(
        f'# {file["path"]}\n{file["text"]}'
        for kind in ("instruction", "skill", "memory")
        for file in _files(version, kind)
    )


def _json(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def _redact(value: Any, api_key: str) -> Any:
    if isinstance(value, str):
        return value.replace(api_key, "[redacted]")
    if isinstance(value, list):
        return [_redact(item, api_key) for item in value]
    if isinstance(value, dict):
        return {key.replace(api_key, "[redacted]"): _redact(item, api_key) for key, item in value.items()}
    return value


def _trace(fields: dict[str, Any], api_key: str | None) -> str:
    return _json({key: _redact(value, api_key) for key, value in fields.items()} if api_key else fields)


def _retry_delay(header: str | None, attempt: int) -> float:
    if header and re.fullmatch(r"[0-9]+", header):
        return float(header)
    if header:
        try:
            date = parsedate_to_datetime(header)
            if date.tzinfo is None:
                date = date.replace(tzinfo=timezone.utc)
            return max(0, (date - datetime.now(timezone.utc)).total_seconds())
        except (ValueError, OverflowError):
            pass
    return 0.25 * 2 ** attempt


class OpenAIAgent:
    """A learning executor with the policy model available as `.model`."""

    def __init__(
        self, model: str, base_url: str | None, api_key: str | None, effort: str | None,
        parse: Callable[[str], Any] | None, render: Callable[[VerifiedVersion], str] | None,
    ):
        self.model = model
        base_url = os.environ.get("OPENAI_BASE_URL", "https://api.openai.com/v1") if base_url is None else base_url
        self._url = base_url.rstrip("/") + "/chat/completions"
        self._api_key = os.environ.get("OPENAI_API_KEY") if api_key is None else api_key
        self._effort = effort
        self._parse = parse
        self._render = _render_bundle if render is None else render

    def __call__(self, version: VerifiedVersion, input: LearningJson, rollout: int) -> tuple[Any, str]:
        body = {
            "model": self.model,
            "messages": [
                {"role": "system", "content": self._render(version)},
                {"role": "user", "content": input if isinstance(input, str) else _json(input)},
            ],
        }
        if self._effort is not None:
            body["reasoning_effort"] = self._effort
        headers = {"Content-Type": "application/json"}
        if self._api_key:
            headers["Authorization"] = f"Bearer {self._api_key}"
        request = Request(self._url, data=_json(body).encode(), headers=headers, method="POST")
        opener = build_opener(_NoRedirect())

        for attempt in range(3):
            try:
                with opener.open(request, timeout=600) as response:
                    raw = response.read().decode("utf-8", errors="replace")
                break
            except HTTPError as error:
                with error:
                    raw = error.read().decode("utf-8", errors="replace")
                if attempt < 2 and (error.code == 429 or 500 <= error.code <= 599):
                    wait = _retry_delay(error.headers.get("Retry-After"), attempt)
                    if wait <= 5:
                        sleep(wait)
                        continue
                try:
                    body_error = json.loads(raw)
                except ValueError:
                    body_error = raw
                raise OpenAIHttpError(error.code, _trace({"error": body_error}, self._api_key)) from None

        try:
            result = json.loads(raw)
        except ValueError:
            raise _TranscriptError(
                "OpenAI-compatible endpoint returned invalid JSON.", _trace({"error": raw}, self._api_key),
            ) from None
        choices = result.get("choices") if isinstance(result, dict) else None
        choice = choices[0] if isinstance(choices, list) and choices and isinstance(choices[0], dict) else {}
        message = choice.get("message")
        text = message.get("content") if isinstance(message, dict) else None
        trace = _trace({
            "text": text,
            "finish_reason": choice.get("finish_reason"),
            "usage": result.get("usage") if isinstance(result, dict) else None,
        }, self._api_key)
        if not isinstance(text, str):
            raise _TranscriptError("OpenAI-compatible endpoint returned no assistant text.", trace)
        try:
            return (self._parse(text) if self._parse is not None else text), trace
        except Exception:
            raise _TranscriptError("Could not parse assistant text.", trace) from None


def openai(
    model: str, base_url: str | None = None, api_key: str | None = None, effort: str | None = None,
    parse: Callable[[str], Any] | None = None, render: Callable[[VerifiedVersion], str] | None = None,
) -> OpenAIAgent:
    """Create an agent for an OpenAI-compatible Chat Completions endpoint."""
    return OpenAIAgent(model, base_url, api_key, effort, parse, render)
