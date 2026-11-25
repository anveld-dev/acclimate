// A console screenshot in a light and a dark version. Global CSS shows the one that
// matches the docs theme. scripts/docs/screenshots.py regenerates the images.
export function Screenshot({ name, alt, caption, width }: { name: string; alt: string; caption?: string; width?: number }) {
  const style = width ? { maxWidth: width } : undefined;
  const className = 'w-full h-auto rounded-lg border border-fd-border';
  return (
    <figure className="not-prose my-6">
      <img src={`/screenshots/${name}-light.png`} alt={alt} loading="lazy" className={`screenshot-light ${className}`} style={style} />
      <img src={`/screenshots/${name}-dark.png`} alt={alt} loading="lazy" className={`screenshot-dark ${className}`} style={style} />
      {caption && <figcaption className="mt-2 text-sm text-fd-muted-foreground">{caption}</figcaption>}
    </figure>
  );
}
