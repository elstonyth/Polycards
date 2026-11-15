import { Button, DropdownMenu } from '@medusajs/ui';

export type MenuOption = { id: string; label: string };

/** A dropdown of checkboxes: ticked = shown. Stays open while toggling. */
export const CheckMenu = ({
  label,
  options,
  hidden,
  onToggle,
}: {
  label: string;
  options: MenuOption[];
  hidden: ReadonlySet<string>;
  onToggle: (id: string) => void;
}) => (
  <DropdownMenu>
    <DropdownMenu.Trigger asChild>
      <Button variant="secondary" size="small" className="shrink-0">
        {label}
        {hidden.size > 0 && (
          <span className="text-ui-fg-muted tabular-nums">
            {options.length - options.filter((o) => hidden.has(o.id)).length}/
            {options.length}
          </span>
        )}
      </Button>
    </DropdownMenu.Trigger>
    <DropdownMenu.Content align="end">
      {options.map((o) => (
        <DropdownMenu.CheckboxItem
          key={o.id}
          checked={!hidden.has(o.id)}
          onCheckedChange={() => onToggle(o.id)}
          onSelect={(e) => e.preventDefault()}
        >
          {o.label}
        </DropdownMenu.CheckboxItem>
      ))}
    </DropdownMenu.Content>
  </DropdownMenu>
);
