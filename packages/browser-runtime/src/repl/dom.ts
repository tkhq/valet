import { parseHTML } from 'linkedom';
export interface ImmutableNode {
  readonly textContent: string;
  readonly tagName: string;
  readonly id: string;
  readonly className: string;
  getAttribute(name: string): string | null;
  querySelector(selector: string): ImmutableNode | null;
  querySelectorAll(selector: string): readonly ImmutableNode[];
  readonly children: readonly ImmutableNode[];
  readonly innerText: string;
  readonly visible: boolean;
  getBoundingClientRect():
    | Readonly<{ x: number; y: number; width: number; height: number }>
    | undefined;
}
export function immutableDocument(html: string): ImmutableNode {
  const { document } = parseHTML(html);
  function wrap(node: Element | Document): ImmutableNode {
    const fields: ImmutableNode = {
      textContent: node.textContent ?? '',
      innerText: node.textContent ?? '',
      tagName: 'tagName' in node ? node.tagName : '#document',
      id: 'id' in node ? node.id : '',
      className: 'className' in node ? node.className : '',
      getAttribute: (name: string) =>
        'getAttribute' in node ? node.getAttribute(name) : null,
      querySelector: (selector: string) => {
        const found = node.querySelector(selector);
        return found ? wrap(found) : null;
      },
      querySelectorAll: (selector: string) =>
        Object.freeze(
          [...node.querySelectorAll(selector)].slice(0, 1000).map(wrap),
        ),
      get children() {
        return Object.freeze([...node.children].map(wrap));
      },
      visible:
        'getAttribute' in node
          ? node.getAttribute('data-valet-visible') !== '0'
          : true,
      getBoundingClientRect: () => {
        const box =
          'getAttribute' in node ? node.getAttribute('data-valet-box') : null;
        if (!box) return undefined;
        const value: unknown = JSON.parse(box);
        if (!value || typeof value !== 'object') return undefined;
        const x = Reflect.get(value, 'x'),
          y = Reflect.get(value, 'y'),
          width = Reflect.get(value, 'width'),
          height = Reflect.get(value, 'height');
        return typeof x === 'number' &&
          typeof y === 'number' &&
          typeof width === 'number' &&
          typeof height === 'number'
          ? Object.freeze({ x, y, width, height })
          : undefined;
      },
    };
    return new Proxy(Object.freeze(fields), {
      get(target, property, receiver) {
        if (property === Symbol.toStringTag) return 'ImmutableDOM';
        if (property === 'then' || property === 'toJSON') return undefined;
        if (!Reflect.has(target, property))
          throw Error(
            `Unsupported immutable DOM property ${String(property)}. Use snapshot read methods.`,
          );
        return Reflect.get(target, property, receiver);
      },
      set() {
        throw Error(
          'Immutable DOM observations cannot be modified. Use browser actions.',
        );
      },
      defineProperty() {
        throw Error('Immutable DOM observations cannot be modified.');
      },
      deleteProperty() {
        throw Error('Immutable DOM observations cannot be modified.');
      },
    });
  }
  return wrap(document);
}
