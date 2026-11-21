#!/usr/bin/env python3
"""Analyze frozen run ledgers. All effects are expressed as fractions."""
import argparse
from collections import Counter, defaultdict
import hashlib
from itertools import product
import json
import math
from pathlib import Path

import numpy as np
from scipy import optimize, stats

from run import CEILING_THRESHOLD, ledger_hashes, read, write


def interval(values):
    values = np.asarray(values, dtype=float)
    n = len(values)
    if not n:
        return [None, None]
    mean = float(values.mean())
    if n < 2:
        return [None, None]
    radius = stats.t.ppf(.975, n - 1) * values.std(ddof=1) / math.sqrt(n)
    return [float(mean - radius), float(mean + radius)]


def signed_rank(values):
    values = np.asarray(values)
    signs = np.sign(values[values != 0])
    ranks = stats.rankdata(abs(values[values != 0]))
    observed = sum(signs * ranks)
    outcomes = [sum(np.asarray(sign) * ranks) for sign in product((-1, 1), repeat=len(ranks))]
    p = sum(abs(outcome) >= abs(observed) for outcome in outcomes) / len(outcomes)
    return {"p": p, "signedStatistic": float(observed), "zeros": len(values) - len(ranks)}


def hodges_lehmann(values):
    walsh = sorted((x + y) / 2 for i, x in enumerate(values) for y in values[i:])
    n = len(values)
    # Invert the two-sided signed-rank test over the Walsh breakpoints.
    inside = []
    for left, right in zip(walsh, walsh[1:]):
        if left < right and signed_rank(np.asarray(values) - (left + right) / 2)["p"] >= .05:
            inside.extend((left, right))
    inside.extend(w for w in set(walsh) if signed_rank(np.asarray(values) - w)["p"] >= .05)
    outer_p = 2 / (2 ** n)
    bounds = [float(min(inside)), float(max(inside))] if inside and outer_p < .05 else [None, None]
    return {"estimate": float(np.median(walsh)), "ci95": bounds}


def paired(values, margin=None):
    values = np.asarray(values, dtype=float)
    n = len(values)
    if n < 2:
        return {"n": n, "mean": float(values[0]) if n else None, "p": None}
    mean = float(values.mean())
    sd = float(values.std(ddof=1)) if np.ptp(values) else 0.
    df = n - 1
    null = margin if margin is not None else 0
    statistic = (mean - null) / (sd / math.sqrt(n)) if sd else (
        math.copysign(math.inf, mean - null) if mean != null else 0.
    )
    p = stats.t.sf(statistic, df) if margin is not None else 2 * stats.t.sf(abs(statistic), df)
    effect_ci = [None, None]
    if sd:
        observed = mean / sd * math.sqrt(n)
        # The noncentral t CDF decreases monotonically with its noncentrality.
        effect_ci = [float(optimize.brentq(
            lambda delta: stats.nct.cdf(observed, df, delta) - q,
            -max(100, 100 * abs(observed)), max(100, 100 * abs(observed)),
        ) / math.sqrt(n)) for q in (.975, .025)]
    rank = signed_rank(values if margin is None else values - margin)
    return {
        "n": n, "mean": mean, "sd": sd, "ci95": interval(values),
        "t": statistic if math.isfinite(statistic) else None, "df": df, "p": float(p),
        "dz": mean / sd if sd else None, "dzCi95": effect_ci,
        "signedRank": rank, "hodgesLehmann": hodges_lehmann(values),
        "margin": margin,
        "oneSidedLower95": float(mean - stats.t.ppf(.95, df) * sd / math.sqrt(n)) if margin is not None else None,
    }


def holm(p_values):
    previous = 0.
    adjusted = {key: None for key in p_values}
    ranked = sorted(((key, value) for key, value in p_values.items() if value is not None),
                    key=lambda item: item[1])
    for rank, (key, value) in enumerate(ranked):
        previous = max(previous, min(1., (len(p_values) - rank) * value))
        adjusted[key] = previous
    return adjusted


def jsonlines(path):
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def require_ledger(directory):
    ledger = read(directory / "ledger.json")
    if ledger["files"] != ledger_hashes(directory):
        raise ValueError(f"Frozen ledger mismatch: {directory}")
    return ledger


def curve_score(rollouts, reference, seed, exclude=()):
    rows = [row for row in rollouts if row["id"] == reference["id"]]
    cases = defaultdict(list)
    counts = Counter((row["caseId"], row["rollout"]) for row in rows)
    for row in rows:
        cases[row["caseId"]].append(row["score"])
    if not cases or any(count != 1 for count in counts.values()) or any(
        len(scores) != 5 for scores in cases.values()
    ):
        raise ValueError("Incomplete or duplicate held-out rollout evidence")
    case_means = {case_id: np.mean(scores) for case_id, scores in sorted(cases.items())}
    if abs(np.mean(list(case_means.values())) - reference["score"]) > 1e-9:
        raise ValueError("Reported held-out score differs from local rollout evidence")
    filtered = [mean for case_id, mean in case_means.items() if case_id not in exclude]
    if not filtered:
        return {"score": None, "bootstrapSe": None}
    rng = np.random.default_rng(int(hashlib.sha256(seed.encode()).hexdigest(), 16))
    draws = rng.choice(filtered, size=(2_000, len(filtered)), replace=True).mean(axis=1)
    return {"score": float(np.mean(filtered)), "bootstrapSe": float(draws.std(ddof=1))}


def evidence(directory):
    require_ledger(directory)
    return read(directory / "summary.json"), jsonlines(directory / "rounds.jsonl"), jsonlines(directory / "rollouts.jsonl")


def endpoint(round):
    r = round["retained"]
    return r.get("replacement") or {"id": r["id"], "score": r["heldOutScore"]}


def means(values):
    return float(np.mean(values)) if values else None


def mechanism(summary, rounds, rows, source_last, start_score, final_score):
    complete = [round for round in rounds if round["state"] == "completed"]
    adopted = [round for round in complete if round["decision"] == "adopted"]
    kept = Counter(round["reason"] for round in complete if round["decision"] == "kept")
    candidates = [sample for round in rounds for sample in round["candidates"]]
    diagnoses = [sample["diagnosis"] for sample in candidates if sample["diagnosis"]]
    problems = {p["id"]: p for p in summary["memory"]["improvementMemory"]["problems"]}
    contexts = {}
    counts = Counter()
    regressions, winner = [], []
    requests = [row for round in rounds for row in round["optimizer"] if row["event"] == "request"]
    replies = [row for round in rounds for row in round["optimizer"] if row["event"] == "reply"]
    for round in rounds:
        contexts[round["number"]] = [
            {key: row[key] for key in ("kind", "bytes", "keyBytes", "inputTokens", "outputTokens")}
            for row in round["optimizer"] if row["event"] == "reply"
        ]
    for round in adopted:
        reports = {entry["role"]: entry for entry in round["evaluations"] if entry["role"] == "incumbent"}
        selected = next(entry for entry in round["evaluations"] if entry["role"] == "candidate" and
                        entry["sample"] == round["adoptedSample"])
        record = next(row for row in summary["memory"]["records"] if row["roundId"] == round["id"])
        attempt = next(a for a in problems[record["problemId"]]["attempts"] if a["round"] == round["number"])
        predicted = set(attempt["predicted"])
        counts["predicted"] += len(predicted)
        counts["fixed"] += len(attempt["fixed"])
        before = {item["caseId"]: item["passedRollouts"] for item in reports["incumbent"]["caseSummaries"]}
        after = {item["caseId"]: item["passedRollouts"] for item in selected["caseSummaries"]}
        regressions.append(sum(old >= 3 > after[case_id] for case_id, old in before.items()
                               if case_id not in predicted))
        for case_id, old in before.items():
            kind = "predicted" if case_id in predicted else "unpredicted"
            flaky = "flaky" if 0 < old < 5 else "stable"
            if case_id in predicted:
                counts[f"predicted_{flaky}_cases"] += 1
                counts[f"predicted_{flaky}_correct"] += int(case_id in attempt["fixed"])
            if old < 3:
                counts[f"{kind}_{flaky}_failures"] += 1
                counts[f"{kind}_{flaky}_fixes"] += int(after[case_id] >= 3)
        next_round = next((r for r in rounds if r["number"] > round["number"] and
                           r["parentVersionId"] == round["adoptedVersionId"] and r["incumbentScore"] is not None), None)
        if next_round:
            winner.append(selected["score"] - next_round["incumbentScore"])
        elif round is complete[-1]:
            tail_scores = [row["score"] for row in rows if row["role"] == "final-evolve"]
            if tail_scores:
                winner.append(selected["score"] - means(tail_scores))
    tail = [row for row in rows if row["role"] == "final-evolve"]
    gap = (means([row["score"] for row in tail]) - complete[0]["incumbentScore"]
           - (final_score - start_score)) if tail and start_score is not None else None
    task_turns = sum(row["turns"] for row in rows)
    input_tokens = sum(row["inputTokens"] or 0 for row in rows + replies)
    output_tokens = sum(row["outputTokens"] or 0 for row in rows + replies)
    generated = sum(sample["screen"] is not None or sample["status"] == "generated" for sample in candidates)
    reused = [d["problem"]["id"] for d in diagnoses if "id" in d["problem"]]
    return {
        "keepRate": sum(kept.values()) / len(complete), "keepReasons": dict(kept),
        "screeningYield": sum(s["status"] == "screened_out" for s in candidates) / generated if generated else None,
        "drops": dict(Counter(s["dropReason"] for s in candidates if s["dropReason"] is not None)),
        "diagnoses": len(diagnoses), "problemReuse": len(reused) / len(candidates) if candidates else None,
        "sourceProblemReuse": (sum(problems[i]["openedRound"] <= source_last for i in reused) / len(candidates)
                               if candidates and summary["firstNumber"] > 1 else None),
        "predictionCounts": dict(counts), "unpredictedRegressions": regressions,
        "winnersCurse": winner, "overfittingGap": gap, "contextGrowth": contexts,
        "taskTurns": task_turns, "optimizerRequests": len(requests),
        "inputTokens": input_tokens, "outputTokens": output_tokens,
        "turnsPerAdoptedStep": (task_turns + len(requests)) / len(adopted) if adopted else None,
        "tokensPerAdoptedStep": (input_tokens + output_tokens) / len(adopted) if adopted else None,
    }


def harm_stop(root):
    if (root / "S2" / "harm-stop.json").exists():
        return True
    key = root / "key.json"
    if not key.exists():
        return False
    differences = []
    for block in sorted(read(key), key=int):
        codes = {condition: code for code, condition in read(key)[block].items()}
        values = []
        for condition in ("full", "transfer"):
            directory = root / "S2" / f"b{block}" / codes[condition]
            if (directory / "ledger.json").exists():
                require_ledger(directory)
                last = [r for r in jsonlines(directory / "rounds.jsonl") if r["state"] == "completed"][-1]
                values.append(endpoint(last)["score"])
        block_dir = root / "S2" / f"b{block}"
        if len(values) == 2 and all((block_dir / code / "ledger.json").exists() for code in "ABC"):
            differences.append(values[0] - values[1])
        if len(differences) == 5:
            fired = interval(differences)[1] < -.05
            if fired:
                write(root / "S2" / "harm-stop.json", {"harmStop": True})
            return fired
    return False


def pilot_report(root, optimizer_context, freeze_seed):
    policy = defaultdict(list)
    target_codes = read(root / "key.json").get("1", {}) if (root / "key.json").exists() else {}
    target_round_zero = {}
    rounds, replies, run_replies = [], [], []
    for directory in sorted((root / "S0c").glob("b*/?")):
        if not (directory / "ledger.json").exists():
            continue
        summary, records, rollouts = evidence(directory)
        condition = target_codes.get(directory.name)
        if directory.parent.name == "b1" and condition in ("full", "cold") and summary["roundZero"]:
            target_round_zero[condition] = summary["roundZero"]["score"]
        rounds.extend(records)
        for row in rollouts:
            policy[row["model"]].append(row)
        entries = [row for record in records for row in record["optimizer"] if row["event"] == "reply"]
        replies.extend(entries)
        run_replies.append(entries)
    source = [r for r in rounds if r["code"] == "S"]
    samples = [sample for r in rounds for sample in r["candidates"]]
    rejection = sum(sample["dropReason"] == "format-rejected" for sample in samples) / max(1, len(samples))
    token_growth = []
    for entries in run_replies:
        per_round = defaultdict(list)
        for row in entries:
            if row["inputTokens"] is not None:
                per_round[row["round"]].append(row["inputTokens"])
        peaks = [max(per_round[i]) for i in sorted(per_round)]
        token_growth.extend(b - a for a, b in zip(peaks, peaks[1:]))
    measured = [r["inputTokens"] for r in replies if r["inputTokens"] is not None]
    projected = max(measured) + 17 * max(0, *token_growth) if measured and token_growth else None
    ceiling_reached = any(score >= CEILING_THRESHOLD for score in target_round_zero.values())
    def repeat_noise(rows):
        repeats = defaultdict(list)
        for row in rows:
            if not row["infraFailure"] and row["role"] in ("round-zero", "retained", "rescore"):
                repeats[row["id"], row["caseId"]].append(row["score"])
        complete = [scores for scores in repeats.values() if len(scores) == 5]
        if not complete:
            return {"mixedCaseRate": None, "heldOutDifferenceNoise": None}
        variance = np.mean([np.var(scores, ddof=1) for scores in complete])
        held_cases = len({case_id for _, case_id in repeats})
        return {
            "mixedCaseRate": sum(len(set(scores)) > 1 for scores in complete) / len(complete),
            "heldOutDifferenceNoise": float(np.sqrt(2 * variance / (5 * held_cases))),
        }

    report = {
        "freezeSeed": freeze_seed,
        "targetRoundZero": target_round_zero,
        "targetCeilingThreshold": CEILING_THRESHOLD,
        "targetCeilingReached": ceiling_reached,
        "policy": {model: {"turns": sum(r["turns"] for r in rows),
                           "meanInputTokens": means([r["inputTokens"] for r in rows if r["inputTokens"] is not None]),
                           "meanOutputTokens": means([r["outputTokens"] for r in rows if r["outputTokens"] is not None]),
                           "meanMilliseconds": means([r["milliseconds"] for r in rows]),
                           **repeat_noise(rows),
                           "meanTraceBytes": means([len((r["trace"] or "").encode()) for r in rows])}
                   for model, rows in policy.items()},
        "optimizer": {"replies": len(replies), "meanInputTokens": means(measured),
                      "meanOutputTokens": means([r["outputTokens"] for r in replies if r["outputTokens"] is not None]),
                      "meanMilliseconds": means([r["milliseconds"] for r in replies])},
        "formatRejectionRate": rejection, "optimizerContext": optimizer_context,
        "optimizerInputGrowthTokens": token_growth, "projectedRound20InputTokens": projected,
        "keepRate": sum(r["decision"] == "kept" for r in rounds) / max(1, len(rounds)),
        "passed": len([r for r in source if r["state"] == "completed"]) == 6
        and len([r for r in rounds if r["state"] == "completed"]) == 9 and rejection <= .20
        and any(r["decision"] == "adopted" for r in source)
        and projected is not None and projected <= optimizer_context / 2
        and all(any(r["inputTokens"] is not None and r["outputTokens"] is not None for r in rows)
                for rows in policy.values())
        and set(target_round_zero) == {"full", "cold"} and not ceiling_reached,
    }
    anchors = list(report["policy"].values())
    if anchors and measured:
        report["paperSizeEstimate"] = {
            "inputTokens": int(624_000 * max(r["meanInputTokens"] or 0 for r in anchors) + 2800 * np.mean(measured)),
            "outputTokens": int(624_000 * max(r["meanOutputTokens"] or 0 for r in anchors)
                                + 2800 * np.mean([r["outputTokens"] or 0 for r in replies])),
            "serialPolicyHours": 624_000 * max(r["meanMilliseconds"] for r in anchors) / 3_600_000,
            "serialOptimizerHours": 2800 * report["optimizer"]["meanMilliseconds"] / 3_600_000,
        }
    write(root / "S0c" / "pilot.json", report)
    if ceiling_reached:
        raise ValueError("K3: target round-0 held-out score reached 85%. Stop before S1 for a maintainer decision.")
    if not report["passed"]:
        raise ValueError("K3: pilot gate failed. See S0c/pilot.json.")


def analyze(root, document, out):
    n, length = document["n"], document["N"]
    if (root / "S2" / "harm-stop.json").exists():
        raise ValueError("K4 stopped the preregistered study")
    coded = {}
    for block in range(1, n + 1):
        label = f"b{block}"
        source_dir = root / "S1" / label / "S"
        target_dir = root / "S2" / label
        if (target_dir / "S.missing.json").exists():
            coded[str(block)] = {}
            continue
        if not all((target_dir / code / "ledger.json").is_file()
                   or (target_dir / f"{code}.missing.json").is_file() for code in "ABC"):
            raise ValueError(f"Target block {label} has unfinished conditions")
        source, source_rounds, source_rows = evidence(source_dir)
        flaky = [case_id for case_id, results in _group_passes(source_rows, source["roundZero"]["id"]).items()
                 if 0 < sum(results) < 5]
        source_final = [row for row in source_rounds if row["r"] == length]
        if len(source_final) != 1:
            raise ValueError("Source does not have its frozen round count")
        seed = f"{document['seed']}:{block}"
        source_gain = (curve_score(source_rows, endpoint(source_final[0]), seed + ":source-final")["score"]
                       - curve_score(source_rows, source["roundZero"], seed + ":source-zero")["score"])
        arms = {}
        zeros = {}
        for code in "ABC":
            if not (target_dir / code / "ledger.json").exists():
                continue
            summary, rounds, rollouts = evidence(target_dir / code)
            arms[code] = (summary, rounds, rollouts)
            if summary["roundZero"]:
                zeros[summary["startDigest"]] = curve_score(rollouts, summary["roundZero"], seed + ":" + code + ":0")
        retained = {}
        if (target_dir / "retention" / "ledger.json").exists():
            require_ledger(target_dir / "retention")
            retention = read(target_dir / "retention" / "retention.json")
            rows = jsonlines(target_dir / "retention" / "retention.jsonl")
            retained = {code: curve_score(rows, ref, seed + ":retention:" + code)["score"]
                        for code, ref in retention.items()}
        elif not (target_dir / "retention.missing.json").exists():
            raise ValueError(f"Retention has not reached a terminal state for {label}")
        block_result = {"sourceGain": source_gain, "sourceAdopted": any(r["decision"] == "adopted" for r in source_rounds),
                        "flakyCases": flaky, "conditions": {}}
        for code, (summary, rounds, rows) in arms.items():
            complete = [row for row in rounds if row["state"] == "completed"]
            if [row["r"] for row in complete] != list(range(1, length + 1)):
                raise ValueError("Target does not have its frozen round count")
            if summary["rollouts"] != len(rows) or summary["turns"] != sum(row["turns"] for row in rows):
                raise ValueError("Rollout and turn totals disagree with the run summary")
            scores = [curve_score(rows, endpoint(row), f"{seed}:{code}:{row['r']}") for row in complete]
            zero = zeros.get(summary["startDigest"])
            zero_score = zero["score"] if zero else None
            last = scores[-1]["score"]
            block_result["conditions"][code] = {
                "curve": [zero, *scores], "final": last,
                "nonFlakyFinal": curve_score(rows, endpoint(complete[-1]), seed + ":" + code + ":nonflaky", flaky)["score"],
                "jumpStart": scores[2]["score"] - zero_score if zero and length >= 3 else None,
                "curveArea": means([value["score"] - zero_score for value in scores]) if zero else None,
                "retention": retained[code] - retained["source"] if code in retained else None,
                "mechanism": mechanism(summary, rounds, rows, source["lastNumber"], zero_score, last),
            }
        coded[str(block)] = block_result
    out.mkdir(parents=True, exist_ok=True)
    write(out / "coded.json", coded)
    key_path = root / "key.json"
    key = read(key_path) if key_path.exists() else {}
    arms = {condition: {} for condition in ("full", "transfer", "cold")}
    for block, result in coded.items():
        for code, data in result.get("conditions", {}).items():
            arms[key[block][code]][block] = data

    def differences(first, second, endpoint_name, filter_block=lambda block: True):
        values = {}
        for block in first.keys() & second.keys():
            a, b = first[block][endpoint_name], second[block][endpoint_name]
            if a is not None and b is not None and filter_block(block):
                values[block] = a - b
        return values

    full, transfer, cold = arms.values()
    paired_values = {"T1": differences(full, transfer, "final"),
                     "T2": differences(transfer, cold, "final"),
                     "T3": {block: row["retention"] for block, row in full.items() if row["retention"] is not None}}
    results = {name: {**paired(list(values.values()), -.03 if name == "T3" else None),
                      "blocks": sorted(values, key=int),
                      "missingBlocks": sorted(set(coded) - values.keys(), key=int)}
               for name, values in paired_values.items()}
    adjusted = holm({name: results[name]["p"] for name in ("T2", "T3")})
    for name, row in results.items():
        row["adjustedP"] = adjusted.get(name, row["p"])
        margin = -.03 if name == "T3" else 0
        row["passes"] = bool(row.get("signedRank", {}).get("signedStatistic", 0) > 0 and
                             row["mean"] is not None and row["mean"] > margin and
                             row["adjustedP"] is not None and row["adjustedP"] < .05)
        row["signedRankQualification"] = row.get("signedRank", {}).get("p", 0) > .05
    sensitivities = {
        "excludeFlaky": differences(full, transfer, "nonFlakyFinal"),
        "excludeNoSourceAdopts": differences(full, transfer, "final", lambda b: coded[b]["sourceAdopted"]),
        "curveArea": differences(full, transfer, "curveArea"),
    }
    curves = {}
    for condition, blocks in arms.items():
        curves[condition] = []
        for r in range(length + 1):
            values = [block["curve"][r]["score"] for block in blocks.values() if block["curve"][r] is not None]
            curves[condition].append({"r": r, "n": len(values), "mean": means(values), "ci95": interval(values)})
    prediction = {}
    for condition, blocks in arms.items():
        counts = Counter()
        for row in blocks.values():
            counts.update(row["mechanism"]["predictionCounts"])
        unpredicted_failures = counts["unpredicted_stable_failures"] + counts["unpredicted_flaky_failures"]
        unpredicted_fixes = counts["unpredicted_stable_fixes"] + counts["unpredicted_flaky_fixes"]
        prediction[condition] = {
            "counts": dict(counts), "interpret": counts["predicted"] >= 100,
            "precision": counts["fixed"] / counts["predicted"] if counts["predicted"] else None,
            "unpredictedFixRate": unpredicted_fixes / unpredicted_failures if unpredicted_failures else None,
        }
    write(out / "results.json", {"contrasts": results, "curves": curves, "predictions": prediction,
          "fullMinusCold": differences(full, cold, "final"),
          "sensitivity": {k: paired(list(v.values())) for k, v in sensitivities.items()},
          "conditions": arms})
    with (out / "curves.tsv").open("w", encoding="utf-8") as table:
        table.write("condition\tround\tn\tmean\tci95_lower\tci95_upper\n")
        for condition, points in curves.items():
            for p in points:
                values = [condition, p["r"], p["n"], p["mean"], *p["ci95"]]
                table.write("\t".join("" if value is None else str(value) for value in values) + "\n")


def _group_passes(rows, identity):
    grouped = defaultdict(list)
    for row in rows:
        if row["id"] == identity:
            grouped[row["caseId"]].append(row["passed"])
    return grouped


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("results", type=Path)
    parser.add_argument("--freeze", type=Path)
    parser.add_argument("--out", type=Path)
    parser.add_argument("--harm-only", action="store_true")
    args = parser.parse_args()
    if args.harm_only:
        print(json.dumps({"harmStop": harm_stop(args.results)}))
        return
    if not args.freeze:
        parser.error("--freeze is required for final analysis")
    from freeze import canonical, digest
    preregistration = read(args.freeze)
    seed = preregistration.pop("seed")
    if digest(canonical(preregistration)) != seed:
        raise ValueError("Preregistration digest mismatch")
    frozen_analyzer = preregistration["sha256"]["examples/self-improvement-memory/analyze.py"]
    if digest(Path(__file__).read_bytes()) != frozen_analyzer or not preregistration["pilot"]["passed"]:
        raise ValueError("Final analysis requires the frozen post-pilot analyzer")
    analyze(args.results, {**preregistration, "seed": seed}, args.out or args.results / "analysis")


if __name__ == "__main__":
    main()
