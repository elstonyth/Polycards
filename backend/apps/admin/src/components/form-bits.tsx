// Form furniture shared by the Tasks and Lucky Draw editors — moved out of
// routes/tasks/page.tsx verbatim so the second form does not carry a copy.
import { Label, Select, Text } from "@medusajs/ui";

// One labelled field. Every control in the form goes through this — the old
// editor's worst habit was a bare numeric input with nothing naming it.
export const Field = ({
  label,
  htmlFor,
  hint,
  className,
  children,
}: {
  label: string;
  htmlFor?: string;
  hint?: string;
  className?: string;
  children: React.ReactNode;
}) => (
  <div className={`flex flex-col gap-y-1 ${className ?? ""}`}>
    <Label htmlFor={htmlFor} size="small" weight="plus">
      {label}
    </Label>
    {children}
    {hint && (
      <Text size="small" className="text-ui-fg-subtle">
        {hint}
      </Text>
    )}
  </div>
);

export const Section = ({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: React.ReactNode;
}) => (
  <div className="border-ui-border-base flex flex-col gap-y-3 border-t pt-4 first:border-t-0 first:pt-0">
    <div>
      <Text weight="plus">{title}</Text>
      {description && (
        <Text size="small" className="text-ui-fg-subtle">
          {description}
        </Text>
      )}
    </div>
    {children}
  </div>
);

/**
 * A select whose saved value may not be in the options any more (a renamed or
 * deleted pack / card / Pokémon). Without the extra item the control falls back
 * to its PLACEHOLDER, which reads as "nothing selected" and invites the
 * operator to overwrite a binding they never knew was set.
 */
export const StaleAwareSelect = ({
  value,
  onChange,
  placeholder,
  options,
  className,
  head,
  disabled,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  options: { value: string; label: string }[];
  className?: string;
  /** An always-present leading option, e.g. "Any pack". */
  head?: { value: string; label: string };
  disabled?: boolean;
}) => {
  const known = options.some((o) => o.value === value) || head?.value === value;
  return (
    <Select value={value} onValueChange={onChange} disabled={disabled}>
      <Select.Trigger className={className}>
        <Select.Value placeholder={placeholder} />
      </Select.Trigger>
      <Select.Content>
        {head && <Select.Item value={head.value}>{head.label}</Select.Item>}
        {value !== "" && !known && (
          <Select.Item value={value}>{value} — current, not listed</Select.Item>
        )}
        {options.map((o) => (
          <Select.Item key={o.value} value={o.value}>
            {o.label}
          </Select.Item>
        ))}
      </Select.Content>
    </Select>
  );
};
