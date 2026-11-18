"""Grade one argv answer with the pinned LLM Click parser. Never invoke callbacks."""
import json
import shlex
import sys

import click
from llm.cli import cli

from tasks import cases


def parse(argv):
    if not isinstance(argv, list) or not argv or argv[0] != "llm":
        raise ValueError("Expected an argv array starting with llm")
    command, args = cli, argv[1:]
    contexts = []
    route = []
    try:
        while True:
            context = command.make_context(
                command.name, args, parent=contexts[-1] if contexts else None
            )
            contexts.append(context)
            route.append((command.name, context.params))
            if not isinstance(command, click.Group):
                return route
            # Read explicit routing tokens rather than allowing the default command.
            _, command, args = command.resolve_command(
                context, [*context._protected_args, *context.args]
            )
    finally:
        for context in reversed(contexts):
            context.close()


def grade(output, expected):
    reference = parse(shlex.split(expected))
    try:
        return int(parse(output) == reference)
    except (click.ClickException, click.exceptions.Exit, ValueError, TypeError):
        return 0


def main():
    if sys.argv[1:] == ["--cases"]:
        print(json.dumps({split: list(cases(split)) for split in ("development", "audit", "field")}))
    elif sys.argv[1:] == ["--check"]:
        for split in ("development", "audit", "field"):
            for case in cases(split):
                expected = case["expected"]
                assert grade(shlex.split(expected), expected) == 1
                assert grade(["llm", "this-is-not-a-real-command"], expected) == 0
        print("Verified 70 references and negative controls")
    else:
        payload = json.load(sys.stdin)
        print(grade(payload["output"], payload["expected"]))


if __name__ == "__main__":
    main()
