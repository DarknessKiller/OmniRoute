/**
 * Material Symbols ligature icon. Upstream renders icons through the vendored UI kit's `Icon`;
 * this fork keeps the plain ligature span under the same import path so kit-era call sites
 * keep working without the kit.
 */
export default function Icon({
  name,
  size = 16,
  className,
}: {
  name: string;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={className ? `material-symbols-outlined ${className}` : "material-symbols-outlined"}
      style={{ fontSize: size }}
      aria-hidden="true"
    >
      {name}
    </span>
  );
}
