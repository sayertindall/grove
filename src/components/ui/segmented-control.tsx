import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import {
  segmentedControlItemVariants,
  segmentedControlRootClassName,
} from "@/lib/segmented-control";

export interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

interface SegmentedControlProps<T extends string> {
  "aria-label": string;
  value: T;
  options: readonly SegmentedOption<T>[];
  onValueChange: (value: T) => void;
}

/** One-choice segmented control; callers keep their literal value type. */
export function SegmentedControl<T extends string>({
  "aria-label": ariaLabel,
  value,
  options,
  onValueChange,
}: SegmentedControlProps<T>) {
  return (
    <ToggleGroup
      aria-label={ariaLabel}
      className={segmentedControlRootClassName}
      value={[value]}
      onValueChange={(next) => {
        const selected = next[0];
        if (selected !== undefined) onValueChange(selected as T);
      }}
    >
      {options.map((option) => (
        <ToggleGroupItem
          key={option.value}
          value={option.value}
          className={segmentedControlItemVariants({ size: "sm", state: "pressed" })}
        >
          {option.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
