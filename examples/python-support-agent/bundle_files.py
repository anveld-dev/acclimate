"""Turn a prompt directory into a bundle payload, and publish the first version.

  python bundle_files.py payload prompts/v2 > candidate.json
  python bundle_files.py publish prompts/v1 --name "Support agent" --channel stable

Files under ``skills/`` become skills, files under ``memory/`` become memory,
and every other file is an instruction.
"""

import argparse
import json
import os
from pathlib import Path
import sys
import uuid

from acclimate import AcclimateClient, BundlePayload, validate_payload


def payload_from_directory(directory: Path) -> BundlePayload:
    files = []
    for path in sorted(p for p in directory.rglob("*") if p.is_file() and not p.name.startswith(".")):
        relative = path.relative_to(directory).as_posix()
        top = relative.split("/", 1)[0]
        kind = "skill" if top == "skills" else "memory" if top == "memory" else "instruction"
        files.append({"path": relative, "kind": kind, "text": path.read_text(encoding="utf-8")})
    payload: BundlePayload = {"schemaVersion": 1, "files": files}
    validate_payload(payload)
    return payload


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    commands = parser.add_subparsers(dest="command", required=True)
    show = commands.add_parser("payload", help="print the bundle payload JSON for a directory")
    show.add_argument("directory", type=Path)
    publish = commands.add_parser("publish", help="create a bundle and release the directory to a channel")
    publish.add_argument("directory", type=Path)
    publish.add_argument("--name", default="Support agent")
    publish.add_argument("--channel", default="stable")
    args = parser.parse_args(argv)

    payload = payload_from_directory(args.directory)
    if args.command == "payload":
        json.dump(payload, sys.stdout, indent=2, ensure_ascii=False)
        print()
        return 0

    client = AcclimateClient(os.environ["ACCLIMATE_URL"], os.environ["ACCLIMATE_TOKEN"], "python-support-agent")
    setup = client.create_bundle_setup(
        os.environ["ACCLIMATE_WORKSPACE"],
        {
            "name": args.name,
            "origin": "created",
            "channel": args.channel,
            "payload": payload,
            "reason": "Initial support agent instructions",
        },
        # Reuse the same key if you retry after a lost response.
        os.environ.get("ACCLIMATE_SETUP_KEY") or str(uuid.uuid4()),
    )
    print(json.dumps({"bundleId": setup["bundle"]["id"], "versionId": setup["version"]["id"],
                      "channel": args.channel}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
