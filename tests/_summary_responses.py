"""Valid stub audit responses for tests of other summary behavior (not AI accuracy)."""
import json


def clean_summary_response(data: str) -> str:
    request = json.loads(data)
    if request.get("phase") != "acceptance_audit":
        return '{"edits": []}'
    unit = next(unit for unit in request["source_pages"] if unit["page"] in request["review_pages"])
    return json.dumps({"edits": [], "checked_pages": request["review_pages"], "coverage": [{
        "kind": "result", "page": unit["page"], "evidence": unit["text"][:100],
        "article_excerpt": request["article"][:100]}]})
