#!/usr/bin/env python3
"""Manage private cluster checkpoints and condition attempts."""
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from contextlib import contextmanager
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
from threading import Event

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[1]
sys.path.insert(0, str(ROOT))
from scripts.productization.qualify import Harness

NODE = ["node", "--import", "tsx", str(HERE / "main.ts")]
CEILING_THRESHOLD = 0.85
DEFAULTS = {
    "ACCLIMATE_MODEL": "gpt-6.2-astra",
    "ACCLIMATE_MODEL_REASONING_EFFORT": "high",
    "ACCLIMATE_MODEL_TIMEOUT_SECONDS": "600",
    "ACCLIMATE_MODEL_MAX_COMPLETION_TOKENS": "32768",
    "ACCLIMATE_LEARNING_EVALUATION_QUEUE_SECONDS": "600",
    "ACCLIMATE_LEARNING_EVALUATION_SECONDS": "7200",
    "ACCLIMATE_LEARNING_MAX_FAILED_ROUNDS": "3",
}


class IntegrityStop(RuntimeError):
    pass


def read(path):
    return json.loads(path.read_text())


def write(path, value):
    temp = path.with_suffix(".tmp")
    temp.write_text(json.dumps(value, indent=2, sort_keys=True) + "\n")
    temp.replace(path)


def node(config, *, capture=False, cancelled=None):
    env = dict(os.environ, TSX_TSCONFIG_PATH=str(HERE / "tsconfig.json"))
    proc = subprocess.Popen(NODE, cwd=ROOT, env=env, text=True, stdin=subprocess.PIPE,
                            stdout=subprocess.PIPE if capture else None)
    try:
        message = json.dumps(config)
        while True:
            try:
                output, _ = proc.communicate(message, timeout=1 if cancelled else None)
                break
            except subprocess.TimeoutExpired:
                message = None
                if cancelled.is_set():
                    raise IntegrityStop("Stage stopped while this condition was running")
    except BaseException:
        proc.terminate()
        try:
            proc.wait(timeout=60)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait()
        raise
    if proc.returncode == 42:
        raise IntegrityStop("K1 or K2 stopped the stage. See the condition attempt ledger.")
    if proc.returncode:
        raise RuntimeError(f"Condition process exited {proc.returncode}")
    return json.loads(output) if capture else None


@contextmanager
def cluster(pg_bin, checkpoint=None):
    harness = Harness(pg_bin)
    try:
        if checkpoint is None:
            harness.start_database()
        else:
            shutil.copytree(checkpoint, harness.dir / "pg")
            harness.pg("pg_ctl", "-D", str(harness.dir / "pg"), "-l",
                       str(harness.dir / "postgres.log"), "-o",
                       f"-p {harness.pg_port} -h 127.0.0.1 -c unix_socket_directories=''",
                       "-w", "start")
        yield harness
    finally:
        harness.close()


def ledger_hashes(directory):
    return {path.name: hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted(directory.iterdir()) if path.is_file() and path.name != "ledger.json"}


def checkpoint_hash(directory):
    hasher = hashlib.sha256()
    for path in sorted(directory.rglob("*")):
        if path.is_file():
            relative = str(path.relative_to(directory))
            with path.open("rb") as stream:
                digest = hashlib.file_digest(stream, "sha256").hexdigest()
            hasher.update(json.dumps([relative, digest]).encode())
    return hasher.hexdigest()


def run_attempt(options, config, destination, source_dir=None, cancelled=None):
    checkpoint = source_dir / "checkpoint" if source_dir else None
    identity = {key: config[key] for key in ("seed", "block", "code", "rounds", "serviceSettings")}
    if source_dir:
        source_ledger = read(source_dir / "ledger.json")
        if source_ledger["files"] != ledger_hashes(source_dir) or source_ledger["checkpoint"] != checkpoint_hash(checkpoint):
            raise IntegrityStop(f"Source checkpoint or ledger changed: {source_dir}")
        identity["sourceCheckpoint"] = source_ledger["checkpoint"]
    if (destination / "ledger.json").exists():
        ledger = read(destination / "ledger.json")
        if ledger["identity"] != identity or ledger["files"] != ledger_hashes(destination):
            raise IntegrityStop(f"Frozen ledger mismatch: {destination}")
        return read(destination / "summary.json")
    if destination.exists():
        raise IntegrityStop(f"Incomplete published run: {destination}")
    for attempt in range(1, 4):
        if cancelled and cancelled.is_set():
            raise IntegrityStop("Stage stopped before starting this condition")
        work = destination.with_name(destination.name + f".attempt-{attempt}")
        if work.exists():
            if (work / "integrity-stop").exists():
                raise IntegrityStop(f"Unresolved integrity stop in {work}")
            continue
        work.mkdir(mode=0o700, parents=True)
        try:
            with cluster(options.pg_bin, checkpoint) as harness:
                node(dict(config, scratch=str(harness.dir / "assets"), directory=str(work),
                          database=harness.env["DATABASE_URL"]), cancelled=cancelled)
                summary = read(work / "summary.json")
                findings = harness.pg(
                    "psql", harness.env["DATABASE_URL"], "-XqAt", "-v", "ON_ERROR_STOP=1",
                    "-v", f"project={summary['project']}", "-v", f"bundle={summary['bundleId']}",
                    "-v", f"optimizer_model={config['serviceSettings']['ACCLIMATE_MODEL']}",
                    "-v", f"optimizer_effort={config['serviceSettings']['ACCLIMATE_MODEL_REASONING_EFFORT']}",
                    "-v", f"first={summary['firstNumber']}", "-v", f"last={summary['lastNumber']}",
                    "-f", str(HERE / "checks.sql"),
                ).stdout
                (work / "checks.txt").write_text(findings)
                if findings.strip():
                    raise IntegrityStop(f"K1: database invariant violation: {findings}")
                if config["condition"] == "source":
                    pg_data = harness.dir / "pg"
                    harness.pg("pg_ctl", "-D", str(pg_data), "-m", "fast", "-w", "stop")
                    shutil.copytree(pg_data, work / "checkpoint")
            ledger = {"identity": identity, "files": ledger_hashes(work)}
            if config["condition"] == "source":
                ledger["checkpoint"] = checkpoint_hash(work / "checkpoint")
            write(work / "ledger.json", ledger)
            work.rename(destination)
            return summary
        except IntegrityStop:
            if cancelled:
                cancelled.set()
            (work / "integrity-stop").touch()
            raise
        except (RuntimeError, subprocess.CalledProcessError) as error:
            (work / "failure.txt").write_text(str(error) + "\n")
    raise RuntimeError(f"K5: exhausted three attempts for {destination}")


def target_runs(options, base, source_dir, block_dir):
    source = read(source_dir / "summary.json")
    randomized = node(dict(base, action="freeze"), capture=True)
    codes = dict(zip(randomized["codes"], "ABC", strict=True))
    key = options.output / "key.json"
    mapping = read(key) if key.exists() else {}
    mapping[str(base["block"])] = {code: condition for condition, code in codes.items()}
    write(key, mapping)

    cancelled = Event()

    def target(condition):
        code = codes[condition]
        config = dict(base, condition=condition, code=code, source=source,
                      targetZero=condition in ("full", "cold"), finalEvolve=options.stage == "S2")
        try:
            return run_attempt(options, config, block_dir / code, source_dir, cancelled)
        except IntegrityStop:
            cancelled.set()
            raise

    completed = {}
    with ThreadPoolExecutor(max_workers=3) as executor:
        tasks = {executor.submit(target, condition): condition for condition in randomized["order"]}
        for future in as_completed(tasks):
            condition = tasks[future]
            try:
                completed[condition] = future.result()
            except RuntimeError as error:
                if isinstance(error, IntegrityStop):
                    raise
                write(block_dir / f"{codes[condition]}.missing.json", {"reason": str(error)})
    return completed


def parse_blocks(spec):
    blocks = set()
    for value in spec.split(","):
        start, _, end = value.partition("-")
        blocks.update(range(int(start), int(end or start) + 1))
    if not blocks or not blocks.issubset(range(1, 11)):
        raise ValueError("Blocks must be in 1–10")
    return sorted(blocks)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--stage", choices=["S0a", "S0c", "S1", "S2"], required=True)
    parser.add_argument("--blocks", default="1-10")
    parser.add_argument("--pg-bin", type=Path, default=Path("/opt/homebrew/opt/postgresql@16/bin"))
    parser.add_argument("--service-bin", type=Path, default=ROOT / "target/debug/acclimate-service")
    parser.add_argument("--output", type=Path, default=ROOT / "artifacts/sim-experiment")
    parser.add_argument("--freeze", type=Path)
    parser.add_argument("--source-tree", type=Path)
    parser.add_argument("--live", action="store_true", help="Authorize paid model calls")
    options = parser.parse_args()
    model_free = options.stage == "S0a"
    if not model_free and not (options.live and options.freeze and options.source_tree):
        parser.error("Paid stages require --live, --freeze and --source-tree")
    if model_free and options.live:
        parser.error("S0a is model-free")
    os.umask(0o077)
    options.output = options.output.resolve()
    options.output.mkdir(parents=True, exist_ok=True)
    options.pg_bin = options.pg_bin.resolve()
    if model_free:
        setup = read(options.output / "seed.json") if (options.output / "seed.json").exists() else {"seed": "model-free-v1"}
        write(options.output / "seed.json", setup)
        seed, settings = setup["seed"], DEFAULTS
    else:
        from freeze import verify
        frozen = verify(options.freeze, options.source_tree, options.service_bin, options.pg_bin)
        if options.stage in ("S1", "S2") and not frozen["pilot"]:
            parser.error("S1 and S2 require the post-pilot freeze")
        seed = frozen["seed"]
        settings = frozen["serviceSettings"]
    blocks = [1] if model_free else [1, 2] if options.stage == "S0c" else parse_blocks(options.blocks)
    for block in blocks:
        base = dict(block=block, seed=seed, project=f"sim-study-{block}", binary=str(options.service_bin.resolve()),
                    modelFree=model_free, evidenceRoot=str(options.output), python=sys.executable, sourceTree=str((options.source_tree or ROOT).resolve()),
                    serviceSettings=settings)
        block_dir = options.output / options.stage / f"b{block}"
        source_dir = (options.output / "S1" / f"b{block}" if options.stage == "S2" else block_dir) / "S"
        if options.stage != "S2":
            count = 2 if model_free else 3 if options.stage == "S0c" else 10
            try:
                run_attempt(options, dict(base, code="S", condition="source", rounds=count), source_dir)
            except RuntimeError as error:
                if isinstance(error, IntegrityStop) or options.stage != "S1":
                    raise
                write(source_dir.parent / "S.missing.json", {"reason": str(error)})
        elif not (source_dir / "ledger.json").exists():
            if (source_dir.parent / "S.missing.json").exists():
                block_dir.mkdir(parents=True, exist_ok=True)
                write(block_dir / "S.missing.json", {"reason": "source missing"})
                continue
            raise IntegrityStop(f"Missing source checkpoint: {source_dir}")
        if options.stage == "S2":
            from analyze import harm_stop
            if harm_stop(options.output):
                raise IntegrityStop("K4: harm stop fired after five paired blocks")
        if options.stage == "S2" or model_free or (options.stage == "S0c" and block == 1):
            target_runs(options, dict(base, rounds=2 if model_free else 1 if options.stage == "S0c" else 10),
                        source_dir, block_dir)
    if options.stage == "S0c":
        from analyze import pilot_report
        pilot_report(options.output, frozen["optimizerContext"])
    if options.stage == "S2":
        from analyze import harm_stop
        if harm_stop(options.output):
            raise IntegrityStop("K4: harm stop fired after five paired blocks")
        # Retention uses a fresh common window once the target legs are terminal.
        for block in range(1, frozen["n"] + 1):
            target = options.output / "S2" / f"b{block}"
            if not (target / "S.missing.json").exists() and not all(
                (target / code / "ledger.json").exists() or (target / f"{code}.missing.json").exists() for code in "ABC"
            ):
                return
        key = options.output / "key.json"
        mapping = read(key) if key.exists() else {}
        for block in range(1, frozen["n"] + 1):
            target = options.output / "S2" / f"b{block}"
            if (target / "S.missing.json").exists() or (target / "retention" / "ledger.json").exists():
                continue
            versions = {"source": read(options.output / "S1" / f"b{block}" / "S" / "summary.json")["finalVersion"]}
            for code, condition in mapping[str(block)].items():
                if condition in ("full", "transfer") and (target / code / "summary.json").exists():
                    versions[code] = read(target / code / "summary.json")["finalVersion"]
            for attempt in range(1, 4):
                work = target / f"retention.attempt-{attempt}"
                if work.exists():
                    if (work / "integrity-stop").exists():
                        raise IntegrityStop(f"Unresolved integrity stop in {work}")
                    continue
                work.mkdir(mode=0o700)
                try:
                    node(dict(base, action="retention", block=block, directory=str(work), versions=versions))
                    write(work / "ledger.json", {"files": ledger_hashes(work)})
                    work.rename(target / "retention")
                    break
                except RuntimeError as error:
                    if isinstance(error, IntegrityStop):
                        (work / "integrity-stop").touch()
                        raise
                    (work / "failure.txt").write_text(str(error) + "\n")
            if not (target / "retention" / "ledger.json").exists():
                write(target / "retention.missing.json", {"reason": "K5: exhausted retention attempts"})


if __name__ == "__main__":
    main()
