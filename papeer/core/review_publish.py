"""Publish visually reviewed fresh translations without changing other pages."""
from __future__ import annotations
from collections import defaultdict
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import shutil
import sqlite3
import uuid
import pymupdf as fitz
from papeer.core.config import Settings
from papeer.core.paths import PaperFiles
from papeer.layout.math_layout import LAYOUT_VERSION, restore_formula_text
from papeer.core.fileio import atomic_write_json, atomic_write_text, replace_file
from papeer.core.exports import discard_interleaved
from papeer.pdf.pdf_engine import PDF_LOCK, translation_units, bilingual_pdf
from papeer.translation.translation import translation_fingerprint, validate_translations
from papeer.translation.translation_preview import read_preview, translated_page, translated_page_numbers
from papeer.layout.reading_flow import unit_pages, materialize_flows
from papeer.core.terminology import apply_glossary, glossary_for_folder


# Each publish backs up what it replaces; the newest applied backups of a paper are kept, so the
# last few publishes can be rolled back and tools.verify_review_publish (which checks the latest
# receipt) always finds its backup. Older ones, and failed attempts older than the oldest kept, go.
REVIEW_BACKUPS_KEPT = 5
_BACKUP_NAME = re.compile(r'\d{8}T\d{6}Z-[0-9a-f]{8}')


def _read(path, default=None):
    return json.loads(path.read_text('utf-8')) if path.exists() else default


def _digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def apply_review(papers: Path, review: Path, cases: list[str] | None = None) -> list[dict]:
    papers, review = papers.resolve(), review.resolve()
    manifest = _read(review / 'manifest.json')
    if not manifest or manifest.get('fresh_translation') is not True:
        raise ValueError('新規翻訳による検証結果ではありません。')
    if manifest.get('complete') is False and not cases:
        raise ValueError('検証が未完了です。完了ページを --case で指定してください。')
    results = manifest.get('results', [])
    if cases:
        selected = []
        for case in cases:
            prefix, number = case.split(':')
            matches = [r for r in results if r['id'].startswith(prefix) and r['page'] == int(number)]
            if len(matches) != 1:
                raise ValueError(f'完了した検証ページを一意に選択できません: {case}')
            selected.extend(matches)
        results = selected
    elif {(r['id'], r['page']) for r in results} != {tuple(item) for item in manifest['selected']}:
        raise ValueError('検証が未完了です。完了ページを --case で指定してください。')
    if not results:
        raise ValueError('反映できるページがありません。')
    groups = defaultdict(list)
    # Validate every selected artifact before changing any library file.
    for result in results:
        identity, number = result['id'], result['page']
        if not re.fullmatch('[0-9a-f]{32}', identity) or type(number) is not int:
            raise ValueError('論文IDまたはページ番号が不正です。')
        folder = papers / identity
        label = f'{identity[:4]}-p{number}'
        if _digest(PaperFiles(folder).original_pdf) != result['source_sha256']:
            raise ValueError('原文PDFが検証時から変更されています。再検証してください。')
        pdf = review/(label+'.pdf')
        if result.get('pdf_sha256') and _digest(pdf) != result['pdf_sha256']:
            raise ValueError('検証済みPDFが変更されています。')
        document = _read(review/(label+'-document.json'))
        if document['layout_version'] != LAYOUT_VERSION:
            raise ValueError('抽出処理が更新されています。現在の処理で再検証してください。')
        if not 1 <= number <= document['page_count']:
            raise ValueError('ページ番号が範囲外です。')
        with fitz.open(pdf) as page_pdf, fitz.open(PaperFiles(folder).original_pdf) as original:
            if len(page_pdf) != 1 or page_pdf[0].rect != original[number-1].rect:
                raise ValueError('差し替えPDFのページ数または寸法が一致しません。')
        values = _read(review/(label+'-translation.json'))['translations']
        units = [u for u in translation_units(document) if number in unit_pages(u)]
        validate_translations(json.dumps({'translations': [{'id': k, 'text': v} for k,v in values.items()]}), units)
        groups[identity].append((result, document, values, pdf))
    for identity, entries in groups.items():
        selected_pages = {r['page'] for r, _, _, _ in entries}
        for flow in entries[0][1].get('continuations', []):
            if selected_pages & set(flow['pages']) and not set(flow['pages']) <= selected_pages:
                raise ValueError('文がつながるページはまとめて反映してください。')
        seen = {}
        for _, _, values, _ in entries:
            for key, value in values.items():
                if key in seen and seen[key] != value:
                    raise ValueError('ページ間で共通の訳文が一致しません。再検証してください。')
                seen[key] = value
    receipts = []
    for identity, entries in groups.items():
        with PDF_LOCK:
            receipts.append(_publish(papers/identity, review, manifest, entries))
    atomic_write_json(review/'applied.json', receipts)
    return receipts


def _publish(folder, review, manifest, entries):
    document = entries[0][1]
    if any(d != document for _, d, _, _ in entries):
        raise ValueError('同じ論文の抽出情報が一致しません。')
    count = document['page_count']
    selected = {r['page'] for r, _, _, _ in entries}
    replacements = {r['page']: pdf for r, _, _, pdf in entries}
    completed = set(translated_page_numbers(folder, count)) | selected
    run_id = uuid.uuid4().hex
    backup = folder/'review-backups'/(datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')+'-'+run_id[:8])
    stage = backup/'staged'
    stage.mkdir(parents=True)
    # interleaved.pdf is rebuilt from translated.pdf when opened, so it is discarded instead.
    names = ['translated.pdf', 'document.json', 'translation-cache.json',
             'translation-report.json', 'translation-preview.json', 'translation.md']
    if PaperFiles(folder).bilingual_pdf.exists():
        names.append('bilingual.pdf')
    existed = {name for name in names if (folder/name).exists()}
    for name in existed:
        shutil.copy2(folder/name, backup/name)
    # An unfinished translation's pages live in its run folder, which is removed once the published
    # (complete) preview no longer names it; keep them with the preview that points to them.
    previous = read_preview(folder)
    if previous and not previous['complete']:
        run = PaperFiles(folder).translation_pages/previous['run_id']
        if run.is_dir():
            shutil.copytree(run, backup/'translation-pages'/previous['run_id'])
    with fitz.open() as output, fitz.open(PaperFiles(folder).original_pdf) as original:
        for number in range(1, count+1):
            if number in replacements:
                path, index = replacements[number], 0
            else:
                path, index = translated_page(folder, number-1)
                if path is None or not path.exists():
                    path, index = PaperFiles(folder).original_pdf, number-1
            with fitz.open(path) as source:
                if index >= len(source):
                    raise ValueError('既存の訳文PDFのページ数が原文と一致しません。')
                output.insert_pdf(source, from_page=index, to_page=index)
        output.set_metadata(dict(original.metadata, title=document['title']+' - 日本語訳', creator='Papeer'))
        output.set_toc(original.get_toc())
        output.save(PaperFiles(stage).translated_pdf, garbage=4, deflate=True)
    if 'bilingual.pdf' in names:
        bilingual_pdf(PaperFiles(folder).original_pdf, PaperFiles(stage).translated_pdf, PaperFiles(stage).bilingual_pdf)
    settings = Settings.from_values({'provider': manifest['provider'], 'model': manifest['model'],
                                     'base_url': manifest.get('base_url', Settings().base_url)})
    # With the glossary applied, as PaperService.translate fingerprints it.
    units = translation_units(document)
    apply_glossary(units, glossary_for_folder(folder))
    fingerprint = translation_fingerprint(settings, units)
    old_cache = _read(folder/'translation-cache.json', {})
    cache = old_cache if old_cache.get('fingerprint') == fingerprint else {'fingerprint': fingerprint, 'translations': {}}
    cache = json.loads(json.dumps(cache))
    reviewed_values = {}
    for _, _, values, _ in entries:
        reviewed_values.update(values)
    cache['translations'].update(reviewed_values)
    # Page records are what translation reuses and paragraph editing reads.
    for entry in cache.get('completed_pages', {}).values():
        page_values = entry.get('translations', {})
        page_values.update({key: value for key, value in reviewed_values.items() if key in page_values})
    retry = cache.setdefault('retry_state', {'attempts': {}, 'retry_calls': 0})
    for key in reviewed_values:
        retry['attempts'].pop(key, None)
    atomic_write_json(stage/'translation-cache.json', cache)
    atomic_write_json(stage/'document.json', document)
    report = _read(folder/'translation-report.json', {})
    # Old whole-document counters cannot be subtracted reliably by page.
    aggregate_keys = ('scaled_blocks', 'inline_formulas', 'preserved_table_blocks', 'preserved_figure_blocks', 'preserved_formula_blocks')
    previous_metrics = {k: report.pop(k) for k in aggregate_keys if k in report}
    if previous_metrics:
        report['previous_aggregate_metrics'] = previous_metrics
    report['readability_warnings'] = [w for w in report.get('readability_warnings', []) if w['page'] not in selected]
    page_reports = report.setdefault('reviewed_page_reports', {})
    for result, _, _, _ in entries:
        page_reports[str(result['page'])] = result['report']
        report['readability_warnings'].extend(result['report'].get('readability_warnings', []))
    report.update(pages=count, translated_pages=sorted(completed), untranslated_pages=sorted(set(range(1,count+1))-completed),
                  last_review_pages=sorted(selected), last_review=str(review))
    report['skipped_pages'] = [p for p in report.get('skipped_pages', []) if p not in selected]
    report['page_errors'] = {k:v for k,v in report.get('page_errors', {}).items() if int(k) not in selected}
    report['skipped_blocks'] = [k for k in report.get('skipped_blocks', []) if not any(k.startswith(f'p{p}b') for p in selected)]
    atomic_write_json(stage/'translation-report.json', report)
    atomic_write_json(stage/'translation-preview.json', dict(fingerprint=fingerprint, run_id=run_id, pages=sorted(completed),
        skipped_pages=report['skipped_pages'], page_errors=report['page_errors'], target_pages=sorted(completed),
        total_pages=count, complete=True))
    md_path = folder/'translation.md'
    markdown = md_path.read_text('utf-8') if md_path.exists() else '# '+document['title']+' — 日本語訳\n\n'
    sections = re.split(r'(?=^## p\.\d+ / )', markdown, flags=re.M)
    sections = [s for s in sections if not (m := re.match(r'## p\.(\d+) / ', s)) or int(m[1]) not in selected]
    grouped = defaultdict(list)
    for unit in translation_units(document):
        if unit['id'] in reviewed_values:
            grouped[unit['block']].append(reviewed_values[unit['id']])
    rendered_document, rendered_text = materialize_flows(document, {k:'\n'.join(v) for k,v in grouped.items()})
    for block in rendered_document['blocks']:
        if block['page'] not in selected:
            continue
        if block['id'] in rendered_text:
            text = restore_formula_text(rendered_text[block['id']], block)
        elif block.get('kind') in {'formula','table','figure','reference'}:
            text = block['text']
        else:
            continue
        sections.append(f"## p.{block['page']} / {block['id']}\n\n{text}\n\n")
    head = [s for s in sections if not re.match(r'## p\.\d+', s)]
    body = [s for s in sections if re.match(r'## p\.\d+', s)]
    body.sort(key=lambda s:int(re.match(r'## p\.(\d+)', s)[1]))
    atomic_write_text(stage/'translation.md', ''.join(head+body))
    # Detect concurrent app writes before publishing; keep staging for diagnosis.
    if (_digest(PaperFiles(folder).original_pdf) != entries[0][0]['source_sha256'] or
            any((folder/n).exists() != (n in existed) or (n in existed and _digest(folder/n) != _digest(backup/n)) for n in names)):
        raise RuntimeError('反映の準備中にライブラリが更新されました。再実行してください。')
    replaced = []
    database = folder.parent.parent/'library.sqlite3'
    connection = sqlite3.connect(database) if database.exists() else None
    previous_status = None
    try:
        if connection:
            connection.execute('BEGIN IMMEDIATE')
            row = connection.execute('SELECT status FROM papers WHERE id=?', (folder.name,)).fetchone()
            previous_status = row[0] if row else None
        for name in names:
            replace_file(stage/name, folder/name)
            replaced.append(name)
        if connection:
            status = '翻訳済み' if len(completed) == count and not report.get('skipped_blocks') else '一部翻訳済み'
            connection.execute('UPDATE papers SET status=? WHERE id=?', (status, folder.name))
            connection.commit()
    except Exception:
        if connection:
            connection.rollback()
        for name in reversed(replaced):
            if name in existed:
                shutil.copy2(backup/name, folder/name)
            else:
                (folder/name).unlink(missing_ok=True)
        raise
    finally:
        if connection:
            connection.close()
    discard_interleaved(PaperFiles(folder))
    receipt = dict(paper=folder.name, pages=sorted(selected), backup=str(backup), review=str(review),
                   previous_status=previous_status, applied_at=datetime.now(timezone.utc).isoformat())
    atomic_write_json(backup/'receipt.json', receipt)
    try:
        stage.rmdir()  # Emptied by the publish.
    except OSError:
        pass
    prune_review_backups(folder, current=backup)
    return receipt


def prune_review_backups(folder: Path, keep: int = REVIEW_BACKUPS_KEPT, current: Path | None = None) -> None:
    """Delete a paper's review backups beyond the newest `keep` applied ones (see REVIEW_BACKUPS_KEPT)."""
    root = folder/'review-backups'
    if not root.is_dir():
        return
    # The name starts with the UTC time of the publish, so it sorts oldest first.
    backups = sorted(p for p in root.iterdir() if p.is_dir() and _BACKUP_NAME.fullmatch(p.name))
    applied = [p for p in backups if (p/'receipt.json').is_file()]
    if len(applied) <= keep:
        return
    oldest_kept = applied[-keep].name
    for path in backups:
        if path.name < oldest_kept and path != current:
            shutil.rmtree(path, ignore_errors=True)
