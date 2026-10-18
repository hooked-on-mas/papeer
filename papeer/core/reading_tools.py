"""Reading metadata, glossaries, paragraph revisions, library search and backups, under the names the sidecar
(routes/reading.py: `tools.…`) and the tests use. The code is in:

- reading_choices: choices of tags, sticky-note labels and reading statuses; note templates
- glossary_draft: checking a glossary, and drafting one with the AI
- library_search: search across the library
- backup: backup ZIPs and restoring them (drive_sync uses them too)
- paragraph_revisions: translated paragraphs and revising them by hand

Private names and SCHEMA_VERSION stay here too: tests call reading_tools._rename_folder and patch
reading_tools.SCHEMA_VERSION (with storage.SCHEMA_VERSION, which backup reads).
"""
from __future__ import annotations

from papeer.core.reading_choices import DEFAULT_TEMPLATE as DEFAULT_TEMPLATE
from papeer.core.reading_choices import DEFAULT_TEMPLATE_NAME as DEFAULT_TEMPLATE_NAME
from papeer.core.reading_choices import add_choice as add_choice
from papeer.core.reading_choices import all_tags as all_tags
from papeer.core.reading_choices import choice_name as choice_name
from papeer.core.reading_choices import note_templates as note_templates
from papeer.core.reading_choices import template_name as template_name
from papeer.core.glossary_draft import draft_glossary as draft_glossary
from papeer.core.glossary_draft import validate_terms as validate_terms
from papeer.core.library_search import _metadata_text as _metadata_text
from papeer.core.library_search import _search_places as _search_places
from papeer.core.library_search import library_search as library_search
from papeer.core.backup import DATABASE_FILES as DATABASE_FILES
from papeer.core.backup import SETTINGS_ENTRIES as SETTINGS_ENTRIES
from papeer.core.backup import STORED_SUFFIXES as STORED_SUFFIXES
from papeer.core.backup import _keep_current_settings as _keep_current_settings
from papeer.core.backup import _rename_folder as _rename_folder
from papeer.core.backup import _stop_if_cancelled as _stop_if_cancelled
from papeer.core.backup import create_backup as create_backup
from papeer.core.backup import restore_backup as restore_backup
from papeer.core.paragraph_revisions import REVISION_SCHEMA as REVISION_SCHEMA
from papeer.core.paragraph_revisions import adopt_revision as adopt_revision
from papeer.core.paragraph_revisions import draft_revision as draft_revision
from papeer.core.paragraph_revisions import find_paragraph as find_paragraph
from papeer.core.paragraph_revisions import revision_history as revision_history
from papeer.core.paragraph_revisions import save_revision_history as save_revision_history
from papeer.core.paragraph_revisions import translation_paragraphs as translation_paragraphs
from papeer.core.storage import SCHEMA_VERSION as SCHEMA_VERSION
from papeer.core.terminology import effective_glossary as effective_glossary
from papeer.core.terminology import validate_revision as validate_revision
