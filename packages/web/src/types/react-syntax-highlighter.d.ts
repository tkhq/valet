/**
 * `@types/react-syntax-highlighter` types only the v15 top-level default
 * export. `code-block.tsx` imports the v16 `dist/esm/prism-light` +
 * per-language subpaths (to register a handful of languages instead of the
 * full ~290-language bundle), which ship no types of their own.
 */
declare module "react-syntax-highlighter/dist/esm/prism-light" {
  import type { ComponentType, ReactNode } from "react";

  export type PrismGrammar = Record<string, unknown>;

  export interface SyntaxHighlighterProps {
    language?: string;
    style?: Record<string, unknown>;
    useInlineStyles?: boolean;
    PreTag?: string;
    CodeTag?: string;
    children?: ReactNode;
  }

  type PrismLightComponent = ComponentType<SyntaxHighlighterProps> & {
    registerLanguage(name: string, language: PrismGrammar): void;
  };

  const PrismLight: PrismLightComponent;
  export default PrismLight;
}

declare module "react-syntax-highlighter/dist/esm/languages/prism/*" {
  import type { PrismGrammar } from "react-syntax-highlighter/dist/esm/prism-light";

  const grammar: PrismGrammar;
  export default grammar;
}
