import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";

import { SegmentedControl, type SegmentedOption } from "@/components/ui/segmented-control";
import type { ImageMode } from "@/lib/storage";
import type { ImagePreview } from "@/types/grove";

const MODE_OPTIONS: SegmentedOption<ImageMode>[] = [
  { value: "2-up", label: "2-up" },
  { value: "swipe", label: "Swipe" },
  { value: "onion", label: "Onion" },
  { value: "difference", label: "Difference" },
];

interface ImageDiffProps {
  image: ImagePreview;
  path: string;
  mode: ImageMode;
  onModeChange: (mode: ImageMode) => void;
}

const checkerboard = {
  backgroundColor: "var(--background)",
  backgroundImage:
    "linear-gradient(45deg, var(--muted) 25%, transparent 25%), linear-gradient(-45deg, var(--muted) 25%, transparent 25%), linear-gradient(45deg, transparent 75%, var(--muted) 75%), linear-gradient(-45deg, transparent 75%, var(--muted) 75%)",
  backgroundSize: "16px 16px",
  backgroundPosition: "0 0, 0 8px, 8px -8px, -8px 0",
} as const;

/** One side decoded to pixels, all client-side from its data URL. */
interface DecodedImage {
  width: number;
  height: number;
  pixels: Uint8ClampedArray;
}

/** A pixel under the pointer, in image coordinates of the shared frame. */
interface PixelPoint {
  x: number;
  y: number;
}

/**
 * Before/after of one image: side by side, a draggable swipe divider, an onion-skin
 * opacity slider, or a `difference` blend on a canvas. Hovering any mode reads the
 * pixel under the pointer from both sides. Everything is computed in the webview
 * from the preview's data URLs.
 */
export function ImageDiff({ image, path, mode, onModeChange }: ImageDiffProps) {
  const before = useDecodedImage(image.oldDataUrl);
  const after = useDecodedImage(image.newDataUrl);
  const frame = {
    width: Math.max(before?.width ?? 0, after?.width ?? 0, 1),
    height: Math.max(before?.height ?? 0, after?.height ?? 0, 1),
  };
  const [point, setPoint] = useState<PixelPoint | null>(null);

  const trackPointer = (event: ReactPointerEvent<HTMLElement>) => {
    const target = event.currentTarget;
    const rect = target.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    // 2-up hovers one side's own <img>; the stacked modes hover the shared frame.
    const size =
      target instanceof HTMLImageElement
        ? { width: target.naturalWidth, height: target.naturalHeight }
        : frame;
    const x = Math.floor(((event.clientX - rect.left) / rect.width) * size.width);
    const y = Math.floor(((event.clientY - rect.top) / rect.height) * size.height);
    const inside = x >= 0 && y >= 0 && x < size.width && y < size.height;
    setPoint(inside ? { x, y } : null);
  };
  const stageProps = { onPointerMove: trackPointer, onPointerLeave: () => setPoint(null) };

  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="image-diff" data-mode={mode}>
      <div className="flex h-10 shrink-0 items-center gap-2.5 border-b border-border px-3">
        <span className="rounded-sm bg-ring/16 px-1.5 text-[10px] font-medium leading-4 text-muted-foreground">
          image
        </span>
        <span className="truncate font-mono text-[11px] text-muted-foreground">
          {dimensionsLabel(before)} → {dimensionsLabel(after)}
        </span>
        <span className="flex-1" />
        <SegmentedControl
          aria-label="Image comparison"
          value={mode}
          options={MODE_OPTIONS}
          onValueChange={onModeChange}
        />
      </div>
      <div className="relative min-h-0 flex-1 overflow-auto p-3">
        {mode === "2-up" ? (
          <div className="grid h-full grid-cols-2 gap-3">
            <ImageSide
              label="Before · HEAD"
              src={image.oldDataUrl}
              path={path}
              stageProps={stageProps}
            />
            <ImageSide
              label="After · working tree"
              src={image.newDataUrl}
              path={path}
              stageProps={stageProps}
            />
          </div>
        ) : (
          <div className="flex h-full flex-col gap-2">
            <div className="flex justify-between text-[10px] font-semibold tracking-wide text-muted-foreground">
              <span>BEFORE · HEAD</span>
              <span>AFTER · WORKING TREE</span>
            </div>
            {mode === "difference" ? (
              <DifferenceStage
                before={before}
                after={after}
                frame={frame}
                stageProps={stageProps}
              />
            ) : (
              <OverlayStage
                mode={mode}
                image={image}
                path={path}
                before={before}
                after={after}
                frame={frame}
                stageProps={stageProps}
              />
            )}
          </div>
        )}
      </div>
      <PixelReadout point={point} before={before} after={after} />
    </div>
  );
}

function dimensionsLabel(image: DecodedImage | null): string {
  return image === null ? "∅" : `${image.width}×${image.height}`;
}

/** Decodes a data URL to RGBA once per URL; `null` while loading, absent, or undecodable. */
function useDecodedImage(src: string | null): DecodedImage | null {
  const [decoded, setDecoded] = useState<{ src: string; image: DecodedImage } | null>(null);
  useEffect(() => {
    if (src === null) return;
    let cancelled = false;
    const element = new Image();
    element.onload = () => {
      if (cancelled) return;
      const width = element.naturalWidth || 1;
      const height = element.naturalHeight || 1;
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d", { willReadFrequently: true });
      if (context === null) return;
      context.drawImage(element, 0, 0, width, height);
      setDecoded({
        src,
        image: { width, height, pixels: context.getImageData(0, 0, width, height).data },
      });
    };
    element.src = src;
    return () => {
      cancelled = true;
    };
  }, [src]);
  return decoded !== null && decoded.src === src ? decoded.image : null;
}

interface StageProps {
  onPointerMove: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerLeave: () => void;
}

function ImageSide({
  label,
  src,
  path,
  stageProps,
}: {
  label: string;
  src: string | null;
  path: string;
  stageProps: StageProps;
}) {
  return (
    <figure className="flex min-w-0 flex-col gap-2">
      <figcaption className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {label}
      </figcaption>
      <div
        className="flex min-h-40 flex-1 items-center justify-center overflow-auto rounded-lg border border-border p-3"
        style={checkerboard}
      >
        {src === null ? (
          <span className="text-xs text-muted-foreground">Absent</span>
        ) : (
          <img
            alt={`${label} ${path}`}
            className="max-h-full max-w-full object-contain"
            src={src}
            {...stageProps}
          />
        )}
      </div>
    </figure>
  );
}

/** A box with the frame's aspect ratio, never wider than the frame itself. */
function FrameBox({
  frame,
  stageProps,
  children,
  label,
}: {
  frame: { width: number; height: number };
  stageProps: React.HTMLAttributes<HTMLDivElement>;
  children: React.ReactNode;
  label: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center">
      <div
        role="img"
        aria-label={label}
        className="relative max-h-full touch-none select-none overflow-hidden rounded-md border border-border"
        style={{
          ...checkerboard,
          aspectRatio: `${frame.width} / ${frame.height}`,
          width: `min(100%, ${frame.width}px)`,
        }}
        {...stageProps}
      >
        {children}
      </div>
    </div>
  );
}

/** Both sides stacked in the frame; the after side clipped (swipe) or faded (onion). */
function OverlayStage({
  mode,
  image,
  path,
  before,
  after,
  frame,
  stageProps,
}: {
  mode: "swipe" | "onion";
  image: ImagePreview;
  path: string;
  before: DecodedImage | null;
  after: DecodedImage | null;
  frame: { width: number; height: number };
  stageProps: StageProps;
}) {
  const [split, setSplit] = useState(50);
  const [opacity, setOpacity] = useState(50);
  const dragging = useRef(false);
  const swipe = mode === "swipe";

  const placeDivider = (event: ReactPointerEvent<HTMLElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    setSplit(Math.min(100, Math.max(0, ((event.clientX - rect.left) / rect.width) * 100)));
  };
  // The frame captures the pointer while dragging, so move and up land on it.
  const frameHandlers: React.HTMLAttributes<HTMLDivElement> = {
    onPointerLeave: stageProps.onPointerLeave,
    onPointerMove: (event) => {
      stageProps.onPointerMove(event);
      if (dragging.current) placeDivider(event);
    },
    onPointerDown: (event) => {
      if (!swipe) return;
      dragging.current = true;
      event.currentTarget.setPointerCapture(event.pointerId);
      placeDivider(event);
    },
    onPointerUp: () => {
      dragging.current = false;
    },
  };
  const afterStyle = swipe ? { clipPath: `inset(0 0 0 ${split}%)` } : { opacity: opacity / 100 };

  return (
    <>
      <FrameBox
        frame={frame}
        label={`${swipe ? "Swipe" : "Onion skin"} comparison of ${path}`}
        stageProps={frameHandlers}
      >
        <StackedSide src={image.oldDataUrl} size={before} frame={frame} alt={`Before ${path}`} />
        <div className="absolute inset-0" style={afterStyle} data-testid="image-after-layer">
          <StackedSide src={image.newDataUrl} size={after} frame={frame} alt={`After ${path}`} />
        </div>
        {swipe ? (
          <div
            role="slider"
            tabIndex={0}
            aria-label="Swipe divider"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(split)}
            data-testid="swipe-divider"
            className="absolute inset-y-0 w-0.5 -translate-x-1/2 cursor-ew-resize bg-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            style={{ left: `${split}%` }}
            onKeyDown={(event) => {
              const step = event.key === "ArrowLeft" ? -2 : event.key === "ArrowRight" ? 2 : 0;
              if (step === 0) return;
              event.preventDefault();
              setSplit((value) => Math.min(100, Math.max(0, value + step)));
            }}
          >
            <span className="absolute top-1/2 left-1/2 flex size-6 -translate-1/2 items-center justify-center rounded-full bg-foreground text-xs font-bold text-background">
              ⇔
            </span>
          </div>
        ) : null}
      </FrameBox>
      {!swipe ? (
        <label className="flex shrink-0 items-center justify-center gap-3 text-xs text-muted-foreground">
          Before
          <input
            type="range"
            min={0}
            max={100}
            value={opacity}
            aria-label="After opacity"
            className="w-60 accent-foreground"
            onChange={(event) => setOpacity(Number(event.target.value))}
          />
          After
        </label>
      ) : null}
    </>
  );
}

/** One side at the frame's top-left, at its own size relative to the frame. */
function StackedSide({
  src,
  size,
  frame,
  alt,
}: {
  src: string | null;
  size: DecodedImage | null;
  frame: { width: number; height: number };
  alt: string;
}) {
  if (src === null) return null;
  return (
    <img
      alt={alt}
      src={src}
      draggable={false}
      className="pointer-events-none absolute top-0 left-0"
      style={{
        width: size === null ? "100%" : `${(size.width / frame.width) * 100}%`,
        height: size === null ? "100%" : `${(size.height / frame.height) * 100}%`,
        imageRendering: frame.width < 128 ? "pixelated" : undefined,
      }}
    />
  );
}

/**
 * `difference` blend of the two sides on a canvas: identical pixels go black. The
 * changed share counts pixels whose blended RGB is non-zero or whose alpha differs.
 */
function DifferenceStage({
  before,
  after,
  frame,
  stageProps,
}: {
  before: DecodedImage | null;
  after: DecodedImage | null;
  frame: { width: number; height: number };
  stageProps: StageProps;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [changed, setChanged] = useState<number | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d", { willReadFrequently: true });
    if (canvas === null || context === null || context === undefined) return;
    canvas.width = frame.width;
    canvas.height = frame.height;
    context.fillStyle = "#000";
    context.fillRect(0, 0, frame.width, frame.height);
    const draw = (side: DecodedImage | null) => {
      if (side === null) return;
      const layer = document.createElement("canvas");
      layer.width = side.width;
      layer.height = side.height;
      layer
        .getContext("2d")
        ?.putImageData(new ImageData(side.pixels.slice(), side.width, side.height), 0, 0);
      context.drawImage(layer, 0, 0);
    };
    context.globalCompositeOperation = "source-over";
    draw(before);
    context.globalCompositeOperation = "difference";
    draw(after);
    context.globalCompositeOperation = "source-over";
    setChanged(changedShare(before, after, frame));
  }, [before, after, frame.width, frame.height]);

  return (
    <>
      <FrameBox frame={frame} stageProps={stageProps} label="Difference of the two sides">
        <canvas
          ref={canvasRef}
          data-testid="difference-canvas"
          className="absolute inset-0 h-full w-full"
          style={{ imageRendering: frame.width < 128 ? "pixelated" : undefined }}
        />
      </FrameBox>
      <p
        className="shrink-0 text-center text-[11px] text-muted-foreground"
        data-testid="changed-share"
      >
        {changed === null ? "Comparing…" : `${formatPercent(changed)} of pixels changed`}
      </p>
    </>
  );
}

/** RGBA at one point of a side, or null outside it. */
function pixelAt(
  side: DecodedImage | null,
  point: PixelPoint,
): [number, number, number, number] | null {
  if (side === null || point.x >= side.width || point.y >= side.height) return null;
  const offset = (point.y * side.width + point.x) * 4;
  const pixels = side.pixels;
  return [pixels[offset], pixels[offset + 1], pixels[offset + 2], pixels[offset + 3]];
}

/** Share of frame pixels whose RGBA differs; outside a side counts as transparent. */
function changedShare(
  before: DecodedImage | null,
  after: DecodedImage | null,
  frame: { width: number; height: number },
): number {
  const channel = (side: DecodedImage | null, x: number, y: number, offset: number) =>
    side === null || x >= side.width || y >= side.height
      ? 0
      : side.pixels[(y * side.width + x) * 4 + offset];
  let changed = 0;
  for (let y = 0; y < frame.height; y += 1) {
    for (let x = 0; x < frame.width; x += 1) {
      for (let offset = 0; offset < 4; offset += 1) {
        if (channel(before, x, y, offset) !== channel(after, x, y, offset)) {
          changed += 1;
          break;
        }
      }
    }
  }
  return changed / (frame.width * frame.height);
}

function formatPercent(share: number): string {
  return `${Math.round(share * 1000) / 10}%`;
}

function hexColor(rgba: [number, number, number, number]): string {
  const hex = rgba
    .slice(0, 3)
    .map((channel) => channel.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase();
  return `#${hex}`;
}

/** x, y and both sides' RGBA under the pointer, plus their mean channel distance. */
function PixelReadout({
  point,
  before,
  after,
}: {
  point: PixelPoint | null;
  before: DecodedImage | null;
  after: DecodedImage | null;
}) {
  const beforePixel = point === null ? null : pixelAt(before, point);
  const afterPixel = point === null ? null : pixelAt(after, point);
  const delta =
    beforePixel !== null && afterPixel !== null
      ? beforePixel.reduce(
          (sum, channel, index) => sum + Math.abs(channel - afterPixel[index]),
          0,
        ) /
        (255 * 4)
      : null;
  return (
    <div
      className="flex h-8 shrink-0 items-center gap-5 border-t border-border px-4 font-mono text-[11px]"
      data-testid="pixel-readout"
      aria-live="off"
    >
      {point === null ? (
        <span className="font-sans text-muted-foreground">Hover the image to read pixels</span>
      ) : (
        <>
          <span className="whitespace-pre">
            x {point.x} y {point.y}
          </span>
          <PixelSwatch label="before" pixel={beforePixel} />
          <PixelSwatch label="after" pixel={afterPixel} />
          {delta !== null ? (
            <span className="text-warning-foreground">Δ {formatPercent(delta)}</span>
          ) : null}
        </>
      )}
    </div>
  );
}

function PixelSwatch({
  label,
  pixel,
}: {
  label: string;
  pixel: [number, number, number, number] | null;
}) {
  if (pixel === null) return <span className="text-muted-foreground">{label} —</span>;
  return (
    <span className="flex items-center gap-1.5 text-muted-foreground">
      <span
        className="size-2.5 shrink-0 rounded-[2px] border border-border"
        style={{
          backgroundColor: `rgba(${pixel[0]}, ${pixel[1]}, ${pixel[2]}, ${pixel[3] / 255})`,
        }}
      />
      {label} {hexColor(pixel)} rgba({pixel.join(", ")})
    </span>
  );
}
