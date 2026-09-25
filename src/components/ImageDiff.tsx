import type { ImagePreview } from "@/types/grove";

interface ImageDiffProps {
  image: ImagePreview;
  path: string;
}

const checkerboard = {
  backgroundColor: "var(--background)",
  backgroundImage:
    "linear-gradient(45deg, var(--muted) 25%, transparent 25%), linear-gradient(-45deg, var(--muted) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--muted) 75%), linear-gradient(-45deg, transparent 75%, var(--muted) 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
} as const;

export function ImageDiff({ image, path }: ImageDiffProps) {
  return (
    <div className="grid min-h-0 flex-1 grid-cols-2 gap-3 overflow-auto p-3">
      <ImageSide label="Before" src={image.oldDataUrl} path={path} />
      <ImageSide label="After" src={image.newDataUrl} path={path} />
    </div>
  );
}

function ImageSide({
  label,
  src,
  path,
}: {
  label: string;
  src: string | null;
  path: string;
}) {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="text-[11px] text-muted-foreground">{label}</figcaption>
      <div
        className="flex min-h-40 flex-1 items-center justify-center overflow-auto rounded-lg border border-border p-3"
        style={checkerboard}
      >
        {src === null ? (
          <span className="text-xs text-muted-foreground">Absent</span>
        ) : (
          <img alt={`${label} ${path}`} className="max-h-full max-w-full object-contain" src={src} />
        )}
      </div>
    </figure>
  );
}
