import { useEffect, useRef, useState } from 'react';
import mermaid from 'mermaid';
import { sanitizeMermaidSvg } from './editor/mermaid-node';

interface MermaidViewProps {
  source: string;
  active: boolean;
}

let nextDiagramId = 0;

export function MermaidView({ source, active }: MermaidViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const generation = useRef(0);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (active) return undefined;
    const currentGeneration = ++generation.current;
    const id = `wikinest-mermaid-${nextDiagramId++}`;
    let disposed = false;

    mermaid.initialize({ startOnLoad: false, securityLevel: 'strict' });
    void Promise.resolve(mermaid.render(id, source))
      .then(({ svg }) => {
        if (disposed || currentGeneration !== generation.current || !container.current) return;
        container.current.innerHTML = sanitizeMermaidSvg(svg);
        setError(null);
      })
      .catch(() => {
        if (disposed || currentGeneration !== generation.current) return;
        setError('Mermaid 图表语法无效');
      });

    return () => {
      disposed = true;
      generation.current += 1;
    };
  }, [active, source]);

  if (active) return null;
  return (
    <div className="wikinest-mermaid" contentEditable={false}>
      <div ref={container} />
      {error ? <p role="alert">{error}</p> : null}
    </div>
  );
}
