/** Page title in the heading font, with wide letter spacing and an occasional glitch (see `.glitch` in styles.css). */
export function PageTitle({ children }: { children: string }) {
  return (
    <h1 data-text={children} className="glitch font-heading text-3xl tracking-[0.3em] text-heading-pink glow-magenta-soft md:text-4xl">
      {children}
    </h1>
  );
}
