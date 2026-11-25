"""Select PR jobs from the paths changed in the tested merge commit."""
import os
from pathlib import PurePosixPath
import subprocess


FULL = frozenset({"full", "unit", "bdd"})
DOC_FILES = {
    "docs/site/build-info.json", "docs/site/site-manifest.json", "docs/development.md", "features/README.md",
}
DOC_SECTIONS = {"docs/architecture", "docs/design", "docs/implementation", "docs/research"}


def documentation(path):
    if path.as_posix() in DOC_FILES or path.is_relative_to("docs/site/source"):
        return True
    if path.is_relative_to("docs/site"):
        return path.suffix == ".html"
    return path.suffix == ".md" and any(path.is_relative_to(section) for section in DOC_SECTIONS)


def required_jobs(paths):
    if not paths:
        return FULL
    jobs = set()
    for path in map(PurePosixPath, paths):
        if documentation(path):
            continue
        if path.parts[:3] == ("apps", "docs", "content") and path.suffix in {".mdx", ".json"}:
            # SDK reference pages are checked against TypeScript and Python.
            jobs.add("unit")
        elif (path.parent == PurePosixPath("features") and path.suffix == ".feature"
              or path.as_posix() == "scripts/bdd/inventory.json"):
            jobs.add("bdd")
        else:
            return FULL
    return jobs


def changed_paths(base):
    if not base:
        return []
    # Include both paths of moves so an old runtime path cannot disappear from scope.
    result = subprocess.run(
        ["git", "diff", "--no-renames", "--name-only", "-z", base, "HEAD", "--"],
        capture_output=True,
    )
    if result.returncode:
        print("Could not compare the PR base with the checked-out commit. Running all jobs.")
        return []
    return os.fsdecode(result.stdout).split("\0")[:-1]


if __name__ == "__main__":
    base = os.environ.get("PR_BASE_SHA") if os.environ["GITHUB_EVENT_NAME"] == "pull_request" else None
    jobs = required_jobs(changed_paths(base))
    print("Selected checks:", ", ".join(sorted(jobs | {"docs"})))
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        for name in sorted(FULL):
            print(f"{name}={str(name in jobs).lower()}", file=output)
