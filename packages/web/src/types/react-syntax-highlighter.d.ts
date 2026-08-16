/**
 * `react-syntax-highlighter` v16 ships no type declarations at all.
 * `code-block.tsx` imports `dist/esm/prism-light` + per-language subpaths
 * (to register a handful of languages instead of the full ~290-language
 * bundle), so those two module shapes are declared here.
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
