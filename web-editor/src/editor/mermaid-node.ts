import { createRoot, type Root } from 'react-dom/client';
import { createElement } from 'react';
import { TextSelection } from '@milkdown/prose/state';
import { MermaidView } from '../MermaidView';

interface CodeBlockLike {
  type: { name: string };
  attrs: { language?: unknown };
}

const DANGEROUS_ELEMENTS = 'script, foreignObject, iframe, object, embed';
const URL_ATTRIBUTES = ['href', 'xlink:href'];
const UNSAFE_CSS_RE = /(?:@import\b|expression\s*\()/i;
const CSS_URL_RE = /url\(\s*(?:"([^"]*)"|'([^']*)'|([^)]*))\s*\)/gi;

function hasUnsafeStyle(value: string): boolean {
  if (UNSAFE_CSS_RE.test(value)) return true;
  for (const match of value.matchAll(CSS_URL_RE)) {
    const target = (match[1] ?? match[2] ?? match[3] ?? '').trim();
    if (!/^#[A-Za-z_][\w:.-]*$/.test(target)) return true;
  }
  return false;
}

export function isMermaidCodeBlock(node: CodeBlockLike): boolean {
  return node.type.name === 'code_block'
    && typeof node.attrs.language === 'string'
    && node.attrs.language.toLowerCase() === 'mermaid';
}

export function sanitizeMermaidSvg(svg: string): string {
  const document = new DOMParser().parseFromString(svg, 'image/svg+xml');
  for (const element of document.querySelectorAll(DANGEROUS_ELEMENTS)) element.remove();
  for (const style of document.querySelectorAll('style')) {
    if (hasUnsafeStyle(style.textContent || '')) style.remove();
  }
  for (const element of document.querySelectorAll('*')) {
    for (const attribute of [...element.attributes]) {
      if (attribute.name.toLowerCase().startsWith('on')) element.removeAttribute(attribute.name);
    }
    const style = element.getAttribute('style');
    if (style && hasUnsafeStyle(style)) element.removeAttribute('style');
    for (const attribute of URL_ATTRIBUTES) {
      const value = element.getAttribute(attribute);
      if (value && !/^(?:https?:|mailto:|#|\/)/i.test(value)) element.removeAttribute(attribute);
    }
  }
  return new XMLSerializer().serializeToString(document.documentElement);
}

export function createMermaidNodeViews(): Record<string, any> {
  return {
    code_block(node: any, view: any, getPos: () => number | undefined) {
      if (!isMermaidCodeBlock(node)) return undefined;
      const dom = document.createElement('div');
      dom.className = 'wikinest-mermaid-node';
      const diagram = document.createElement('div');
      const source = document.createElement('pre');
      source.className = 'wikinest-mermaid-node__source';
      const code = document.createElement('code');
      source.append(code);
      dom.append(diagram, source);
      let active = false;
      let root: Root | null = createRoot(diagram);

      const render = (next: typeof node) => {
        root?.render(createElement(MermaidView, { source: next.textContent, active }));
        diagram.hidden = active;
        source.hidden = !active;
      };
      const activate = (event: MouseEvent) => {
        event.preventDefault();
        active = true;
        render(node);
        view.focus();
        const position = getPos();
        if (position === undefined) return;
        view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(position))));
      };
      diagram.addEventListener('mousedown', activate);
      const deactivate = () => {
        active = false;
        render(node);
      };
      source.addEventListener('focusout', deactivate);
      render(node);

      return {
        dom,
        contentDOM: code,
        update(next: typeof node) {
          if (!isMermaidCodeBlock(next)) return false;
          node = next;
          render(next);
          return true;
        },
        ignoreMutation(mutation: MutationRecord) {
          return diagram.contains(mutation.target);
        },
        destroy() {
          diagram.removeEventListener('mousedown', activate);
          source.removeEventListener('focusout', deactivate);
          root?.unmount();
          root = null;
        },
      };
    },
  };
}
