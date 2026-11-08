// Fixed, faint background art behind a page (HackUTD Zero Day artwork in /public/art).
// Sits in its own fixed layer under the page; the page's <main> is raised above it (relative z-10).
// The artworks are JPEGs on black, so `screen` blending drops the black and keeps the glow.
import type { CSSProperties } from 'react';

export interface BackdropLayer {
  src: string;
  /** 0..1 */
  opacity: number;
  /** CSS background-position / size, e.g. 'center bottom' / 'cover' */
  position?: string;
  size?: string;
  blend?: CSSProperties['mixBlendMode'];
}

export function PageBackdrop({ layers }: { layers: BackdropLayer[] }) {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 z-0 overflow-hidden">
      {layers.map((l) => (
        <div
          key={l.src}
          className="absolute inset-0 bg-no-repeat"
          style={{
            backgroundImage: `url(${l.src})`,
            backgroundPosition: l.position ?? 'center',
            backgroundSize: l.size ?? 'cover',
            opacity: l.opacity,
            mixBlendMode: l.blend ?? 'screen',
          }}
        />
      ))}
    </div>
  );
}
