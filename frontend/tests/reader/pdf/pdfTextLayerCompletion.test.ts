import assert from 'node:assert/strict';
import { test } from 'node:test';
import { completePdfTextLayer, createPdfTextLayerCompletion, invalidatePdfTextLayerCompletion,
  recordPdfTextLayerRendered, refitCompletedPdfTextLayer } from '../../../src/features/reader/pdf/pdfTextLayerCompletion.ts';

class FakeNode {
  parentNode: FakeNode | null = null;
  childNodes: FakeNode[] = [];
  isConnected = true;
  name: string;
  value: string;
  constructor(name: string, value = '') { this.name = name; this.value = value; }
  get textContent(): string { return this.value + this.childNodes.map(node => node.textContent).join(''); }
  append(...children: FakeNode[]) {
    for (const child of children) { child.parentNode = this; this.childNodes.push(child); }
  }
  replace(previous: FakeNode, next: FakeNode) {
    this.childNodes[this.childNodes.indexOf(previous)] = next;
    previous.parentNode = null; previous.isConnected = false; next.parentNode = this;
  }
  querySelector(selector: string): FakeNode | null {
    for (const child of this.childNodes) {
      if (selector === '.textLayer' && child.name === 'textLayer') return child;
      const found = child.querySelector(selector); if (found) return found;
    }
    return null;
  }
}

function fixture() {
  const page = new FakeNode('page'), layer = new FakeNode('textLayer'), wrapper = new FakeNode('markedContent');
  const text = new FakeNode('Text', 'actual PDF text'), end = new FakeNode('endOfContent');
  wrapper.append(text); layer.append(wrapper, end); page.append(layer);
  const facts = createPdfTextLayerCompletion<object, object>();
  const pageData = Object.freeze({ physicalPage: 2 }), textData = Object.freeze({ text: 'actual PDF text' });
  let current = true, calls = 0;
  const element = page as unknown as HTMLElement;
  const complete = () => completePdfTextLayer(facts, element, () => current, (actualPage, actualText, actualLayer) => {
    assert.equal(actualPage, pageData); assert.equal(actualText, textData); assert.equal(actualLayer, layer);
    calls++;
  });
  const arrive = (kind: 'page' | 'text' | 'render') => {
    if (kind === 'page') facts.page = pageData;
    else if (kind === 'text') facts.text = textData;
    else recordPdfTextLayerRendered(facts, element);
    return complete();
  };
  return { page, layer, wrapper, text, end, facts, element, pageData, textData, arrive, complete,
    calls: () => calls, retire: () => { current = false; } };
}

test('actual render/page/text callbacks join once in every arrival order, including render before passive text', () => {
  const orders = [
    ['render', 'text', 'page'], ['render', 'page', 'text'], ['text', 'render', 'page'],
    ['text', 'page', 'render'], ['page', 'render', 'text'], ['page', 'text', 'render'],
  ] as const;
  for (const order of orders) {
    const value = fixture();
    assert.equal(value.arrive(order[0]), false); assert.equal(value.arrive(order[1]), false);
    assert.equal(value.calls(), 0); assert.equal(value.arrive(order[2]), true); assert.equal(value.calls(), 1);
    for (const event of order) assert.equal(value.arrive(event), false);
    assert.equal(value.calls(), 1);
  }
});

test('page and TextContent cannot create an actual text-render completion', () => {
  const value = fixture(); value.arrive('page'); value.arrive('text');
  assert.equal(value.complete(), false); assert.equal(value.calls(), 0); assert.equal(value.facts.rendered, null);
});

test('replacing equal Text nodes between render and late TextContent refuses the old DOM witness', () => {
  const value = fixture(); value.arrive('render'); value.arrive('page');
  value.wrapper.replace(value.text, new FakeNode('Text', value.text.value));
  assert.equal(value.arrive('text'), false); assert.equal(value.calls(), 0);
});

test('mutating completed text or replacing its wrapper or endOfContent cannot complete from old evidence', () => {
  const mutations = [
    (value: ReturnType<typeof fixture>) => { value.text.value = 'different PDF text'; },
    (value: ReturnType<typeof fixture>) => {
      const wrapper = new FakeNode('markedContent'); wrapper.append(new FakeNode('Text', value.text.value));
      value.layer.replace(value.wrapper, wrapper);
    },
    (value: ReturnType<typeof fixture>) => { value.layer.replace(value.end, new FakeNode('endOfContent')); },
    (value: ReturnType<typeof fixture>) => { value.layer.append(new FakeNode('span')); },
  ];
  for (const mutate of mutations) {
    const value = fixture(); value.arrive('render'); value.arrive('text'); mutate(value);
    assert.equal(value.arrive('page'), false); assert.equal(value.calls(), 0);
  }
});

test('detached or replaced page/layer cannot reuse a completed drawing', () => {
  for (const target of ['page', 'layer'] as const) {
    const value = fixture(); value.arrive('render'); value.arrive('page'); value[target].isConnected = false;
    assert.equal(value.arrive('text'), false); assert.equal(value.calls(), 0);
  }
  const value = fixture(); value.arrive('render'); value.arrive('page'); value.facts.text = value.textData;
  assert.equal(completePdfTextLayer(value.facts, new FakeNode('page') as unknown as HTMLElement, () => true, () => assert.fail()), false);
});

test('error/unmount invalidation synchronously rejects every later arrival', () => {
  const value = fixture(); value.arrive('render'); value.arrive('page'); invalidatePdfTextLayerCompletion(value.facts);
  for (const event of ['text', 'page', 'render'] as const) assert.equal(value.arrive(event), false);
  assert.equal(value.calls(), 0); assert.equal(value.facts.rendered, null);
});

test('a retired drawing cannot publish after a new drawing has become current', () => {
  const old = fixture(); old.arrive('render'); old.arrive('text'); old.retire();
  const current = fixture(); current.arrive('page'); current.arrive('text');
  assert.equal(old.arrive('page'), false); assert.equal(current.calls(), 0);
  assert.equal(current.arrive('render'), true); assert.equal(old.calls(), 0);
});

test('notification is claimed before invoking the hook, preventing reentrant duplicate completion', () => {
  const value = fixture(); value.arrive('render'); value.arrive('page'); value.facts.text = value.textData;
  let calls = 0;
  assert.equal(completePdfTextLayer(value.facts, value.element, () => true, () => {
    calls++;
    assert.equal(completePdfTextLayer(value.facts, value.element, () => true, () => assert.fail()), false);
  }), true);
  assert.equal(calls, 1);
});

test('an already notified render can be refitted without recording or notifying another completion', () => {
  const value = fixture(); value.arrive('page'); value.arrive('text'); value.arrive('render');
  let fits = 0;
  const refit = () => refitCompletedPdfTextLayer(value.facts, value.element, () => true, (page, text, layer) => {
    assert.equal(page, value.pageData); assert.equal(text, value.textData); assert.equal(layer, value.layer); fits++;
  });
  assert.equal(refit(), true); assert.equal(refit(), true); assert.equal(fits, 2); assert.equal(value.calls(), 1);
  assert.equal(value.complete(), false);
});

test('font refit refuses an unnotified, replaced, disconnected or invalidated actual render witness', () => {
  const unnotified = fixture(); unnotified.arrive('page'); unnotified.arrive('text');
  assert.equal(refitCompletedPdfTextLayer(unnotified.facts, unnotified.element, () => true, () => assert.fail()), false);
  const mutations = [
    (value: ReturnType<typeof fixture>) => value.wrapper.replace(value.text, new FakeNode('Text', value.text.value)),
    (value: ReturnType<typeof fixture>) => { value.layer.isConnected = false; },
    (value: ReturnType<typeof fixture>) => invalidatePdfTextLayerCompletion(value.facts),
  ];
  for (const mutate of mutations) {
    const value = fixture(); value.arrive('page'); value.arrive('text'); value.arrive('render'); mutate(value);
    assert.equal(refitCompletedPdfTextLayer(value.facts, value.element, () => true, () => assert.fail()), false);
  }
});

test('a DOM change or retirement during font measurement also refuses completion', () => {
  const value = fixture(); value.arrive('page'); value.arrive('text'); value.arrive('render');
  assert.equal(refitCompletedPdfTextLayer(value.facts, value.element, () => true, () => {
    value.wrapper.replace(value.text, new FakeNode('Text', value.text.value));
  }), false);
  assert.equal(value.calls(), 1);
});
