import { useEffect, useId, useState } from "react";
import { CodeBlock } from "./code-block";
import { renderMermaid } from "~/lib/mermaid";
import { useMermaidTheme } from "~/lib/use-mermaid-theme";

interface RenderState {
  source: string;
  svg?: string;
  failed?: boolean;
}

/** A fenced Mermaid block rendered from untrusted source. */
export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const theme = useMermaidTheme();
  const [state, setState] = useState<RenderState>({ source });

  useEffect(() => {
    let active = true;
    const id = `mermaid-${reactId.replace(/[^A-Za-z0-9_-]/g, "")}`;
    setState({ source });
    void renderMermaid(source, id, theme).then(
      (svg) => {
        if (active) setState({ source, svg });
      },
      () => {
        if (active) setState({ source, failed: true });
      },
    );
    return () => {
      active = false;
    };
  }, [reactId, source, theme]);

  if (state.source === source && state.svg) {
    return (
      <div className="mermaid-diagram my-3 overflow-x-auto text-center">
        <img
          src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(state.svg)}`}
          alt="Mermaid diagram"
          className="mx-auto max-w-full"
        />
      </div>
    );
  }

  return (
    <div className="mermaid-diagram my-3" data-state={state.failed ? "error" : "loading"}>
      {state.failed && (
        <p role="alert" className="mb-2 text-sm text-danger-600 dark:text-danger-400">
          Diagram could not render. Check the Mermaid syntax. The source is shown below.
        </p>
      )}
      <CodeBlock code={source} language="mermaid" />
    </div>
  );
}
