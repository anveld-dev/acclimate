import shlex

import pytest

from freeze import FIXTURES, load, zero_call_checks


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
