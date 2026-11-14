/**
 * A single-line name that truncates in the middle, keeping the end (episode
 * numbers, extensions) visible: "The.Matrix.Reloa…1080p.BluRay.mkv". Pure
 * CSS: the head shrinks with an ellipsis, the tail never shrinks.
 */

/** Split a name into a shrinkable head and a fixed tail. */
export function splitForMiddleEllipsis(text: string, tailLength = 16): [string, string] {
  const chars = Array.from(text);
  const dot = text.lastIndexOf(".");
  const ext = dot > 0 ? Array.from(text.slice(dot)).length : 0;
  const tail = Math.min(chars.length, Math.max(tailLength, ext + 8));
  if (chars.length <= tail) return ["", text];
  return [chars.slice(0, chars.length - tail).join(""), chars.slice(chars.length - tail).join("")];
}

export function MiddleEllipsis({ text, title, className }: { text: string; title?: string; className?: string }) {
  const [head, tail] = splitForMiddleEllipsis(text);
  return (
    <span className={className ? `mid-ellipsis ${className}` : "mid-ellipsis"} title={title ?? text}>
      {head && <span className="mid-head">{head}</span>}
      <span className="mid-tail">{tail}</span>
    </span>
  );
}
