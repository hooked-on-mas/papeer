"""Geometry-based reading order and conservative prose continuation groups.

No publisher, title, file name, or page-specific rules are used.
"""
from __future__ import annotations
from collections import Counter
import re
from statistics import median
from papeer.layout.math_layout import MATH_TOKEN, formula_only_block

_CAPTION = re.compile(r'^(?:Fig(?:ure)?\.?|Table|Algorithm|Appendix|References|Bibliography)\b', re.I)
_HEADING = re.compile(r'^(?:\d+(?:\.\d+)*\.?|[IVX]+\.|[A-Z]\.)\s+\S')


def _prose(b):
    text = b.get('text','').strip()
    return (b.get('kind','text') == 'text' and not b.get('running_header')
            and not b.get('reading_margin') and not b.get('reading_ambiguous') and not formula_only_block(b)
            and not _CAPTION.match(text) and len(text.split()) >= 5
            and not (_HEADING.match(text) and len(text.split()) < 16))


def order_page(blocks, width, height):
    blocks = [dict(b) for b in blocks]
    sizes = [b['font_size'] for b in blocks if _prose(b) and len(b['text']) > 100]
    body = median(sizes) if sizes else 10
    for b in blocks:
        x0,y0,x1,y1 = b['bbox']
        edge_text = b.get('kind', 'text') == 'text' and len(b['text']) < 220
        if (b.get('running_header') or (edge_text and (
                ((y1 < height*.055 or y0 > height*.95) and b['font_size'] < body*.9)
                or (y0 > height*.92 and x1-x0 > width*.6)
                or (b['text'].strip().isdigit() and abs((x0+x1)/2-width/2) < width*.1 and (y1 < height*.15 or y0 > height*.85))))):
            b['reading_margin'] = True
        # Small-type footnotes do not interrupt the main reading flow.
        if b.get('kind', 'text') == 'text' and y0 > height*.72 and b['font_size'] < body*.90:
            b['reading_margin'] = True
    prose = [b for b in blocks if _prose(b) and len(b['text']) > 60
             and width*.18 < b['bbox'][2]-b['bbox'][0] < width*.58]
    narrow = [b for b in prose if b['bbox'][2]-b['bbox'][0] < width*.33 and len(b['text']) > 250]
    # Three overlapping narrow columns cannot be represented by two lanes.
    # Abstain rather than silently flattening them into the wrong order.
    for a in narrow:
        for b in narrow:
            if b['bbox'][0] <= a['bbox'][2]+5:
                continue
            for c in narrow:
                if (c['bbox'][0] > b['bbox'][2]+5
                        and min(x['bbox'][3] for x in (a,b,c)) - max(x['bbox'][1] for x in (a,b,c)) > height*.15):
                    for item in blocks:
                        item.update(reading_ambiguous=True, flow_lane=-1, flow_band=0)
                    return sorted(blocks,key=lambda item:(item['bbox'][1],item['bbox'][0])),dict(columns=3, supported=False)
    candidates = sorted({(a['bbox'][2]+b['bbox'][0])/2 for a in prose for b in prose
                         if 5 < b['bbox'][0]-a['bbox'][2] < width*.18
                         and width*.28 < (a['bbox'][2]+b['bbox'][0])/2 < width*.72})
    best = None
    for gutter in candidates:
        left = [b for b in prose if b['bbox'][2] <= gutter+2]
        right = [b for b in prose if b['bbox'][0] >= gutter-2]
        crossing = [b for b in prose if b not in left and b not in right]
        if not left or not right:
            continue
        if min(len(left),len(right)) < 2:
            # A column can consist of one long paragraph. Require overlapping
            # vertical coverage and substantial text on both sides.
            overlap = min(max(b['bbox'][3] for b in left), max(b['bbox'][3] for b in right)) - max(min(b['bbox'][1] for b in left), min(b['bbox'][1] for b in right))
            if overlap < height*.15 or min(sum(len(b['text']) for b in side) for side in (left,right)) < 400:
                continue
        score = sum(len(b['text']) for b in left+right)-2*sum(len(b['text']) for b in crossing)
        if best is None or score > best[0]: best=(score,gutter)
    if best is None:
        for b in blocks: b.update(flow_lane=0,flow_band=0)
        return sorted(blocks,key=lambda b:(b['bbox'][1],b['bbox'][0])),dict(columns=1)
    gutter=best[1]
    marginal=[b for b in blocks if b.get('reading_margin')]
    content=[b for b in blocks if not b.get('reading_margin')]
    spans=sorted([b for b in content if b['bbox'][0] < gutter-3 and b['bbox'][2] > gutter+3],key=lambda b:b['bbox'][1])
    bands=[]
    for b in spans:
        if bands and b['bbox'][1] <= bands[-1][1]:
            bands[-1][1]=max(bands[-1][1],b['bbox'][3]); bands[-1][2].append(b)
        else: bands.append([b['bbox'][1],b['bbox'][3],[b]])
    rest=[b for b in content if b not in spans]; ordered=[]
    def lanes(items,band):
        for lane in (0,1):
            for b in sorted([b for b in items if (sum((b['bbox'][0],b['bbox'][2]))/2 >= gutter)==bool(lane)],key=lambda b:(b['bbox'][1],b['bbox'][0])):
                b.update(flow_lane=lane,flow_band=band); ordered.append(b)
    for i,(top,bottom,wide) in enumerate(bands):
        above=[b for b in rest if (b['bbox'][1]+b['bbox'][3])/2 < top]
        lanes(above,i);rest=[b for b in rest if b not in above]
        for b in wide: b.update(flow_lane=-1,flow_band=i);ordered.append(b)
    lanes(rest,len(bands))
    upper=[b for b in marginal if b['bbox'][1] < height/2]
    lower=[b for b in marginal if b not in upper]
    return upper+ordered+lower,dict(columns=2,gutter=round(gutter,2))


def continuation_groups(document):
    ordered=[b for b in document['blocks'] if not b.get('reading_margin') and not b.get('running_header')]
    groups=[]; decisions=[]
    for a,b in zip(ordered,ordered[1:]):
        boundary = ('page' if b['page']==a['page']+1 else
                    'column' if b['page']==a['page'] and a.get('flow_lane')==0 and b.get('flow_lane')==1
                    and a.get('flow_band')==b.get('flow_band') else None)
        if boundary is None: continue
        reason='not_prose'
        if _prose(a) and _prose(b):
            end=a['text'].rstrip();start=b['text'].lstrip()
            # A terminal period/colon, heading, or list starts a new unit.
            if re.search(r'[.!?:;][\s\)\]”\"\']*$',end): reason='sentence_end'
            elif not re.match(r'(?:[a-z(\[∈∀∃]|[A-Z](?:\s|[.,)\]]))',start): reason='uncertain_start'
            elif len(a.get('translation_text',end))+len(b.get('translation_text',start))>6000: reason='too_long'
            else: reason='joined'
        decisions.append(dict(before=a['id'],after=b['id'],boundary=boundary,decision=reason))
        if reason!='joined': continue
        if groups and groups[-1]['blocks'][-1]==a['id']:
            ids=groups[-1]['blocks']+[b['id']]
            lookup={x['id']:x for x in ordered}
            if sum(len(lookup[k].get('translation_text',lookup[k]['text'])) for k in ids)>6000:
                decisions[-1]['decision']='too_long';continue
            groups[-1]['blocks'].append(b['id']);groups[-1]['pages']=sorted(set(groups[-1]['pages']+[b['page']]))
        else: groups.append(dict(blocks=[a['id'],b['id']],pages=sorted({a['page'],b['page']}),boundary=boundary))
    return groups,decisions


def translation_blocks(document):
    lookup={b['id']:b for b in document['blocks']}
    groups={g['blocks'][0]:g for g in document.get('continuations',[])}
    tails={k for g in groups.values() for k in g['blocks'][1:]}
    result=[]
    for b in document['blocks']:
        if b['id'] in tails: continue
        if b['id'] not in groups: result.append(b);continue
        group=groups[b['id']];members=[lookup[k] for k in group['blocks']]
        # Remove only visual line-end hyphenation between block fragments.
        def join(key):
            value=members[0].get(key,members[0]['text']).rstrip()
            for member in members[1:]:
                following=member.get(key,member['text']).lstrip()
                if re.search(r'[A-Za-z]-$',value) and re.match('[a-z]',following): value=value[:-1]+following
                else: value+='\n'+following
            return value
        result.append(dict(b,text=join('text'),translation_text=join('translation_text'),
            formulas=[dict(f,source_page=m['page']) for m in members for f in m.get('formulas',[])],
            flow_blocks=group['blocks'],flow_pages=group['pages']))
    return result


def unit_pages(unit):
    return set(unit.get('flow_pages',[unit['page']]))


# Where one block was split into several translation units (pdf_engine.translation_units).
# The translations are joined with this marker instead of a newline, so the split is not
# typeset as a paragraph break; resolve_unit_joins removes it before text leaves the
# PDF layout (translation.md, page text, search). Never stored in the translation cache.
UNIT_JOINER = '\u2063'
_UNIT_JOIN = re.compile(r'\s*' + UNIT_JOINER + r'\s*')


def join_unit_translations(parts):
    return UNIT_JOINER.join(parts)


def resolve_unit_joins(text):
    """Join the parts of a split block: a space only between two ASCII words (e.g. an
    untranslated source fallback), nothing between Japanese sentences."""
    def join(match):
        left = text[match.start() - 1] if match.start() else ''
        right = text[match.end()] if match.end() < len(text) else ''
        spaced = (left.isascii() and right.isascii() and not left.isspace() and not right.isspace()
                  and left not in '([{"\'' and right not in ')]}.,;:!?"\'')
        return ' ' if left and right and spaced else ''
    return _UNIT_JOIN.sub(join, text)


def split_flow_text(text, members, formulas):
    """Split Japanese at punctuation, keeping formula markers atomic and exact."""
    weights=[max(1,(b['bbox'][2]-b['bbox'][0])*(b['bbox'][3]-b['bbox'][1])) for b in members]
    # Math markers are measured as the formula they represent, not their IDs.
    tokens={f['token']:max(1,(f['bbox'][2]-f['bbox'][0])/max(1,members[0]['font_size'])) for f in formulas}
    atoms=re.findall(MATH_TOKEN.pattern+r'|[\s\S]',text)
    sizes=[tokens.get(a,.55 if a.isascii() else 1) for a in atoms]
    segments=[];offset=0
    for i,weight in enumerate(weights[:-1]):
        remaining=sum(sizes[offset:]);target=remaining*weight/sum(weights[i:]);running=0;candidates=[]
        for j in range(offset,len(atoms)-1):
            running+=sizes[j]
            if running<remaining*.08 or running>remaining*.92: continue
            ch=atoms[j]
            if ch in '。！？；!?;': penalty=0
            elif ch in '、，,:：': penalty=remaining*.06
            elif ch.isspace(): penalty=remaining*.12
            else: continue
            candidates.append((abs(running-target)+penalty,j+1))
        if not candidates:
            # No safe Japanese phrase boundary: keep this unit intact rather
            # than cutting a symbol or inventing punctuation.
            cut=len(atoms) if target>=remaining/2 else offset
        else: cut=min(candidates)[1]
        segments.append(''.join(atoms[offset:cut]));offset=cut
    segments.append(''.join(atoms[offset:]))
    assert ''.join(segments)==text
    return segments


def materialize_flows(document, translations):
    translations=dict(translations);blocks=[dict(b) for b in document['blocks']];lookup={b['id']:b for b in blocks}
    for group in document.get('continuations',[]):
        first=group['blocks'][0]
        if first not in translations: continue
        members=[lookup[k] for k in group['blocks']]
        formulas=[dict(f,source_page=b['page']) for b in members for f in b.get('formulas',[])]
        if Counter(MATH_TOKEN.findall(translations[first]))!=Counter(f['token'] for f in formulas):
            raise ValueError('段・ページをまたぐ訳文の数式が欠落または重複しています。')
        parts=split_flow_text(translations[first],members,formulas)
        for index,(b,part) in enumerate(zip(members,parts)):
            translations[b['id']]=part
            if index:
                b['paragraph_continuation'] = True
            used=set(MATH_TOKEN.findall(part));b['formulas']=[f for f in formulas if f['token'] in used]
    return dict(document,blocks=blocks),translations


def expand_pages(units, pages):
    """Include every page sharing a translation unit; return the full dependency closure."""
    selected = set(pages)
    while True:
        expanded = selected | set().union(*(unit_pages(u) for u in units if unit_pages(u) & selected))
        if expanded == selected:
            return selected
        selected = expanded
