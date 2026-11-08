import { useId } from "react";

/** One layer of the logo: a hexagon with a cyan/magenta colour split and a magenta core cell. */
function HexLayers() {
  return (
    <>
      <g fill="none" strokeWidth="5" strokeLinejoin="round">
        <polygon points="47,8 85,30 85,70 47,92 9,70 9,30" stroke="var(--accent)" opacity=".9" />
        <polygon points="53,8 91,30 91,70 53,92 15,70 15,30" stroke="var(--primary)" opacity=".9" />
        <polygon points="50,8 88,30 88,70 50,92 12,70 12,30" stroke="#fff" />
      </g>
      <polygon points="50,36 62,43 62,57 50,64 38,57 38,43" fill="var(--accent)" />
    </>
  );
}

/**
 * Hivemind "glitch hex" mark: the hexagon is cut into three bands; the middle band sits shifted,
 * and every few seconds the bands jump (animation in styles.css, `.logo-glitch-*`).
 */
export function HivemindLogo({ className }: { className?: string }) {
  const id = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const band = (name: string, y: number, h: number) => <clipPath id={`${id}-${name}`}><rect x="-10" y={y} width="120" height={h} /></clipPath>;
  return (
    <svg viewBox="0 0 100 100" className={className} overflow="visible" aria-hidden>
      <defs>{band("top", -10, 54)}{band("mid", 44, 12)}{band("bot", 56, 54)}</defs>
      <g clipPath={`url(#${id}-top)`}><g className="logo-glitch-top"><HexLayers /></g></g>
      <g clipPath={`url(#${id}-mid)`}><g className="logo-glitch-mid"><HexLayers /></g></g>
      <g clipPath={`url(#${id}-bot)`}><g className="logo-glitch-bot"><HexLayers /></g></g>
    </svg>
  );
}
