"""Geometry extent witnesses, matching runtime/edits/annotationGeometry.ts."""
import math


def geometry_points(g):
    if g["kind"] == "path":
        return g["points"]
    if g["kind"] == "line":
        return [g["start"], g["end"]]
    if g["kind"] == "arrow":
        angle = math.atan2(g["end"]["y"] - g["start"]["y"], g["end"]["x"] - g["start"]["x"])
        def head(at, direction):
            return [{"x": at["x"] - math.cos(direction + offset) * g["headLengthPt"],
                     "y": at["y"] - math.sin(direction + offset) * g["headLengthPt"]} for offset in (-.5, .5)]
        end = head(g["end"], angle)
        start = head(g["start"], angle + math.pi)
        return [g["start"], g["end"], end[0], g["end"], end[1]] if g["head"] == "end" else [start[0], g["start"], start[1], g["start"], g["end"], end[0], g["end"], end[1]]
    if g["kind"] == "ellipse":
        return [{"x": g["widthPt"] * (1 + math.cos(i * math.pi / 32)) / 2,
                 "y": g["heightPt"] * (1 + math.sin(i * math.pi / 32)) / 2} for i in range(65)]
    return [{"x": 0, "y": 0}, {"x": g["widthPt"], "y": 0}, {"x": g["widthPt"], "y": g["heightPt"]}, {"x": 0, "y": g["heightPt"]}]


def transform_ink_point(annotation, point):
    t = annotation["transform"]
    c, s = math.cos(t["rotationRad"]), math.sin(t["rotationRad"])
    return {"x": t["x"] + c * point["x"] * t["scaleX"] - s * point["y"] * t["scaleY"],
            "y": t["y"] + s * point["x"] * t["scaleX"] + c * point["y"] * t["scaleY"]}


def annotation_points(annotation):
    if annotation["kind"] == "sticky":
        return [annotation["anchor"]]
    if annotation["kind"] == "highlight":
        return [annotation["anchor"], *[point for quad in annotation["quads"] for point in quad]]
    g, t = annotation["geometry"], annotation["transform"]
    if g["kind"] == "ellipse":
        c, s = math.cos(t["rotationRad"]), math.sin(t["rotationRad"])
        rx, ry = g["widthPt"] / 2, g["heightPt"] / 2
        x = math.atan2(-s * t["scaleY"] * ry, c * t["scaleX"] * rx)
        y = math.atan2(c * t["scaleY"] * ry, s * t["scaleX"] * rx)
        return [transform_ink_point(annotation, {"x": rx * (1 + math.cos(angle)), "y": ry * (1 + math.sin(angle))}) for angle in [x, x + math.pi, y, y + math.pi]]
    return [transform_ink_point(annotation, point) for point in geometry_points(g)]
