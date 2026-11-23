// One tooltip for the whole page. Elements say what to show with `data-tip`
// (always) or `data-tip-overflow` (only when their text is cut short). The
// browser's own `title` tooltip is not used: it is slow to appear and some
// embedded browsers never show it.

import { useEffect, useState } from 'react';

interface Shown {
  text: string;
  x: number;
  y: number;
  above: boolean;
}

export function TipLayer() {
  const [tip, setTip] = useState<Shown | null>(null);
  useEffect(() => {
    let current: Element | null = null;
    let timer = 0;
    const hide = () => {
      window.clearTimeout(timer);
      current = null;
      setTip(null);
    };
    const over = (e: MouseEvent) => {
      const el = (e.target as Element | null)?.closest?.('[data-tip],[data-tip-overflow]') ?? null;
      if (el === current) return;
      window.clearTimeout(timer);
      current = el;
      setTip(null);
      if (!el) return;
      timer = window.setTimeout(() => {
        const h = el as HTMLElement;
        const always = h.getAttribute('data-tip');
        const overflow = h.getAttribute('data-tip-overflow');
        const text = always || (overflow && h.scrollWidth > h.clientWidth + 1 ? overflow : null);
        if (!text) return;
        const r = h.getBoundingClientRect();
        const above = r.bottom + 120 > window.innerHeight;
        setTip({
          text,
          x: Math.max(8, Math.min(r.left, window.innerWidth - 428)),
          y: above ? r.top - 6 : r.bottom + 6,
          above,
        });
      }, 250);
    };
    document.addEventListener('mouseover', over);
    window.addEventListener('wheel', hide, { passive: true });
    window.addEventListener('pointerdown', hide);
    window.addEventListener('blur', hide);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('mouseover', over);
      window.removeEventListener('wheel', hide);
      window.removeEventListener('pointerdown', hide);
      window.removeEventListener('blur', hide);
    };
  }, []);
  if (!tip) return null;
  return (
    <div
      className="tip"
      role="tooltip"
      style={{
        left: tip.x,
        top: tip.y,
        transform: tip.above ? 'translateY(-100%)' : undefined,
      }}
    >
      {tip.text}
    </div>
  );
}
