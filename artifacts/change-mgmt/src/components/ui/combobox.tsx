import { useState } from "react";
import { Check, ChevronsUpDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";

export type ComboboxOption = {
  value: string;
  label: string;
  // Optional secondary line shown under the label (e.g. username / email).
  hint?: string;
};

type ComboboxProps = {
  options: ComboboxOption[];
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  searchPlaceholder?: string;
  emptyText?: string;
  disabled?: boolean;
  className?: string;
  contentClassName?: string;
  /**
   * When provided, the combobox runs in async mode: built-in client filtering
   * is disabled and the parent is expected to update `options` in response to
   * each query. Used by the directory (LDAP) requester picker.
   */
  onSearchChange?: (query: string) => void;
  loading?: boolean;
  "data-testid"?: string;
};

// Reusable searchable + scrollable single-select. Built on cmdk + Popover so
// every dropdown in the app gets a type-to-filter input and a scrolling list
// instead of the plain native-style Select. Supports both client-side filtering
// (default) and server-driven async search via `onSearchChange`.
export function Combobox({
  options,
  value,
  onChange,
  placeholder = "Select…",
  searchPlaceholder = "Search…",
  emptyText = "No results found.",
  disabled,
  className,
  contentClassName,
  onSearchChange,
  loading,
  "data-testid": testId,
}: ComboboxProps) {
  const [open, setOpen] = useState(false);
  const selected = options.find((o) => o.value === value);
  const isAsync = typeof onSearchChange === "function";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          disabled={disabled}
          data-testid={testId}
          className={cn("w-full justify-between font-normal", !selected && "text-muted-foreground", className)}
        >
          <span className="truncate">{selected ? selected.label : placeholder}</span>
          <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        className={cn("w-[--radix-popover-trigger-width] p-0", contentClassName)}
        align="start"
      >
        <Command shouldFilter={!isAsync}>
          <CommandInput
            placeholder={searchPlaceholder}
            onValueChange={isAsync ? onSearchChange : undefined}
          />
          <CommandList>
            {loading ? (
              <div className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Searching…
              </div>
            ) : (
              <>
                <CommandEmpty>{emptyText}</CommandEmpty>
                <CommandGroup>
                  {options.map((o) => (
                    <CommandItem
                      key={o.value}
                      // cmdk filters by the item value; include the label (and
                      // hint) so client-side search matches what the user sees.
                      value={isAsync ? o.value : `${o.label} ${o.hint ?? ""} ${o.value}`}
                      onSelect={() => {
                        onChange(o.value);
                        setOpen(false);
                      }}
                      data-testid={testId ? `${testId}-option-${o.value}` : undefined}
                    >
                      <Check
                        className={cn("mr-2 h-4 w-4 shrink-0", o.value === value ? "opacity-100" : "opacity-0")}
                      />
                      <span className="flex min-w-0 flex-col">
                        <span className="truncate">{o.label}</span>
                        {o.hint && <span className="truncate text-xs text-muted-foreground">{o.hint}</span>}
                      </span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
