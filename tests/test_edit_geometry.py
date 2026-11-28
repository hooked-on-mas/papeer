"""Physical geometry validation mirrors the TypeScript runtime, including arrow wings."""
from copy import deepcopy
import json
import math
from pathlib import Path
from uuid import UUID

import pytest

from papeer.core.edit_geometry import annotation_points, geometry_points, transform_ink_point
from papeer.core.edit_content_hash import edit_content_hash
from papeer.core.edit_model import assert_snapshot

FIXTURE = json.loads((Path(__file__).parent / "fixtures/shared-edits.json").read_text("utf-8"))


def test_frozen_migration_ids_bind_the_versioned_content_codec_without_delimiter_or_unicode_ambiguity():
    vectors = json.loads((Path(__file__).parent / "fixtures/shared-migration-ids.json").read_text("utf-8"))
    for value in vectors:
        assert edit_content_hash(["paper-desk-migration-v1", value["libraryId"], value["kind"], value["source"]]) == value["hash"]
        target = UUID(value["targetId"])
        assert target.version == 8
        encoded = list(value["hash"][:32])
        encoded[12] = "8"
        encoded[16] = "89ab"[int(encoded[16], 16) & 3]
        assert target.hex == "".join(encoded)


def ink():
    return deepcopy(FIXTURE["batches"][0]["changes"][0]["annotation"])


def snapshot(annotation):
    result = deepcopy(FIXTURE["document"])
    result["pages"][0]["annotations"] = [annotation]
    return result


@pytest.mark.parametrize("annotation", FIXTURE["annotations"]["valid"])
def test_annotation_metadata_and_explicit_unindexed_ranges_have_the_same_native_contract(annotation):
    assert_snapshot(snapshot(annotation))


@pytest.mark.parametrize("case", FIXTURE["annotations"]["invalid"], ids=lambda case: case["name"])
def test_bad_annotation_metadata_ranges_dates_and_geometry_are_rejected_identically(case):
    with pytest.raises(ValueError):
        assert_snapshot(snapshot(case["annotation"]))


def test_rotated_scaled_ellipse_extrema_enclose_the_curve_without_empty_frame_corners():
    ellipse = ink()
    ellipse["geometry"] = {"kind": "ellipse", "widthPt": 100, "heightPt": 20}
    angle = math.pi / 4
    ellipse["transform"] = {"x": 50 - math.cos(angle) * 50 + math.sin(angle) * 10,
                            "y": 50 - math.sin(angle) * 50 - math.cos(angle) * 10,
                            "rotationRad": angle, "scaleX": 1, "scaleY": 1}
    points = annotation_points(ellipse)
    for axis in ("x", "y"):
        assert min(p[axis] for p in points) == pytest.approx(50 - math.sqrt(1300))
        assert max(p[axis] for p in points) == pytest.approx(50 + math.sqrt(1300))
    ellipse["transform"].update(scaleX=1.7, scaleY=.6)
    points = annotation_points(ellipse)
    dense = [transform_ink_point(ellipse, {"x": 50 * (1 + math.cos(i * math.tau / 5000)),
                                          "y": 10 * (1 + math.sin(i * math.tau / 5000))}) for i in range(5000)]
    for axis in ("x", "y"):
        lower, upper = min(p[axis] for p in points), max(p[axis] for p in points)
        assert all(lower - 1e-9 <= p[axis] <= upper + 1e-9 for p in dense)
        assert abs(min(p[axis] for p in dense) - lower) < .0001


def test_arrow_head_lengths_remain_in_the_native_wire_model_and_both_ends_retrace():
    arrow = ink()
    arrow["geometry"] = {"kind": "arrow", "start": {"x": 5, "y": 10}, "end": {"x": 50, "y": 10},
                         "head": "both", "headLengthPt": 20, "preferredHeadLengthPt": 25}
    assert_snapshot(snapshot(arrow))
    points = geometry_points(arrow["geometry"])
    assert len(points) == 8
    assert points[1] == points[3] == arrow["geometry"]["start"]
    assert points[4] == points[6] == arrow["geometry"]["end"]
    arrow["geometry"]["preferredHeadLengthPt"] = 19
    with pytest.raises(ValueError, match="arrow-head-preference"):
        assert_snapshot(snapshot(arrow))
    arrow["geometry"].update(preferredHeadLengthPt=1e308, headLengthPt=1e308)
    arrow["transform"]["scaleX"] = 4
    with pytest.raises(ValueError, match="non-finite-geometry"):
        assert_snapshot(snapshot(arrow))
    del arrow["geometry"]["headLengthPt"]
    with pytest.raises(ValueError):
        assert_snapshot(snapshot(arrow))
