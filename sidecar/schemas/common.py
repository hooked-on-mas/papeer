"""What the response models of several routers share: values the API describes but passes on as they are."""
from __future__ import annotations

from typing import TYPE_CHECKING, Annotated, Any, TypeVar

from pydantic import GetPydanticSchema, TypeAdapter
from pydantic_core import core_schema

T = TypeVar("T")

if TYPE_CHECKING:
    # For the type checker, Stored[X] is X or anything else, as nothing checks the value.
    Stored = Annotated[T | Any, "stored"]
else:
    class Stored:
        """Stored[X]: a value the schema (app.openapi(), and so the frontend's types) describes as X, answered
        exactly as the sidecar read it, without validation.

        For what comes from a file or an outside service rather than from the code answering: a translation
        report or preview written by an earlier Papeer (translation-report.json and the like), pages worked out
        from a document.json an older version extracted, the plan usage a CLI reports. A response model would
        drop the keys X does not name and refuse (500) a value of another shape, so the reader would not open a
        paper whose old report has an unexpected field; the frontend reads these defensively instead.
        """

        def __class_getitem__(cls, described: Any) -> Any:
            adapter = TypeAdapter(described)
            return Annotated[Any, GetPydanticSchema(
                lambda _source, _handler: core_schema.any_schema(),
                lambda _schema, handler: handler(adapter.core_schema))]
