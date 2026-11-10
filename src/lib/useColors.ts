import { useEffect, useState } from 'react';

const VARS = ['--s1', '--s2', '--s3', '--s4', '--s5', '--s6', '--s7', '--s-tbd', '--line-vm', '--line-vcpu', '--line-mem', '--line-stor', '--grid', '--text-2', '--text-3', '--surface', '--border-strong'];

/** Resolve CSS custom properties to concrete colours for SVG charts; re-resolves on theme change. */
export function useColors(): (cssVar: string) => string {
  const [map, setMap] = useState<Record<string, string>>({});
  useEffect(() => {
    const read = () => {
      const cs = getComputedStyle(document.documentElement);
      setMap(Object.fromEntries(VARS.map((v) => [v, cs.getPropertyValue(v).trim()])));
    };
    read();
    const mq = matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', read);
    const mo = new MutationObserver(read);
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', read);
      mo.disconnect();
    };
  }, []);
  return (c: string) => {
    const m = c.match(/^var\((--[\w-]+)\)$/);
    const key = m ? m[1] : c;
    return map[key] || '#888';
  };
}

export const fmt = (n: number) => Math.round(n).toLocaleString('en-AU');
