"""Structural validator for the generated, finite edit wire schema."""
from __future__ import annotations

import math
import re
import sys


def validate_structure(schema: dict, name: str, value: object) -> None:
    def fail(path):
        raise ValueError(f"Invalid edit data: {path}")

    def visit(rule, data, path):
        if "$ref" in rule:
            return visit(schema["$defs"][rule["$ref"].rsplit("/", 1)[1]], data, path)
        if "const" in rule:
            if type(data) is not type(rule["const"]) or data != rule["const"]:
                fail(path)
            return
        if "enum" in rule:
            if not any(type(data) is type(v) and data == v for v in rule["enum"]):
                fail(path)
            return
        if "oneOf" in rule:
            matches = 0
            for branch in rule["oneOf"]:
                try:
                    visit(branch, data, path)
                    matches += 1
                except ValueError:
                    pass
            if matches != 1:
                fail(path)
            return
        kind = rule.get("type")
        if kind == "null":
            if data is not None:
                fail(path)
        elif kind == "boolean":
            if not isinstance(data, bool):
                fail(path)
        elif kind == "string":
            if not isinstance(data, str) or len(data) < rule.get("minLength", 0) or len(data) > rule.get("maxLength", math.inf):
                fail(path)
            if "pattern" in rule and not re.fullmatch(rule["pattern"], data):
                fail(path)
            if any(0xD800 <= ord(char) <= 0xDFFF for char in data):
                fail(path)
        elif kind in ("number", "integer"):
            if type(data) not in (int, float) or abs(data) > sys.float_info.max or not math.isfinite(data):
                fail(path)
            if kind == "integer" and (data != int(data) or abs(data) > 9007199254740991):
                fail(path)
            if data < rule.get("minimum", -math.inf) or data > rule.get("maximum", math.inf):
                fail(path)
            if "exclusiveMinimum" in rule and data <= rule["exclusiveMinimum"]:
                fail(path)
        elif kind == "array":
            if not isinstance(data, list) or len(data) < rule.get("minItems", 0) or len(data) > rule.get("maxItems", math.inf):
                fail(path)
            for index, item in enumerate(data):
                visit(rule["items"], item, f"{path}[{index}]")
        elif kind == "object":
            if not isinstance(data, dict) or not all(isinstance(key, str) for key in data):
                fail(path)
            for key in rule.get("required", []):
                if key not in data:
                    fail(f"{path}.{key}")
            for key, item in data.items():
                if any(0xD800 <= ord(char) <= 0xDFFF for char in key):
                    fail(path)
                prop = rule.get("properties", {}).get(key, rule.get("additionalProperties", False))
                if prop is False:
                    fail(f"{path}.{key}")
                if prop is not True:
                    visit(prop, item, f"{path}.{key}")
        else:
            fail(path)

    visit(schema["$defs"][name], value, name)
