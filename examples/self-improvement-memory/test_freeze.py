import shlex

import pytest

from freeze import FIXTURES, load, passing_pilot, zero_call_checks


def test_frozen_w1_inventory_and_controls():
    assert zero_call_checks() == {
        "evolveCases": 40, "heldOutCases": 60, "priorCases": 120, "negativeControlsRejected": 120,
    }


def test_duplicate_normalized_input_with_a_new_id_is_rejected():
    held = load(FIXTURES / "held-out.json")
    held[1]["input"] = "  " + held[0]["input"].upper().replace(" ", "  ") + " "
    with pytest.raises(ValueError, match="not disjoint"):
        zero_call_checks(held)


def test_duplicate_parsed_target_under_different_text_is_rejected():
    held = load(FIXTURES / "held-out.json")
    held[1]["expected"] = held[0]["expected"]
    with pytest.raises(ValueError, match="not disjoint"):
        zero_call_checks(held)


def test_passing_negative_control_is_rejected():
    held = load(FIXTURES / "held-out.json")
    held[0]["negativeControls"][0] = shlex.split(held[0]["expected"])
    with pytest.raises(ValueError, match="negative controls"):
        zero_call_checks(held)


@pytest.mark.parametrize(("scores", "passed"), [
    ({"full": .849, "cold": .80}, True),
    ({"full": .85, "cold": .80}, False),
    ({"full": .80, "cold": .86}, False),
    ({"full": .80}, False),
])
def test_pilot_freeze_requires_both_target_baselines_below_ceiling(scores, passed):
    pilot = {"passed": True, "optimizerContext": 272_000, "targetRoundZero": scores}
    assert passing_pilot(pilot, 272_000) is passed
