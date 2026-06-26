import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";
import type { LdapSearchUser } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";

// Requester selector. Internal requesters are looked up live from the Active
// Directory directory (service-bind search); external requesters are captured
// as free text. Optional — leaving it blank stores no requester. Shared by the
// new-change form and the change detail "Details" tab.
export function RequesterField({
  type,
  name,
  onTypeChange,
  onNameChange,
}: {
  type: "internal" | "external";
  name: string;
  onTypeChange: (t: "internal" | "external") => void;
  onNameChange: (name: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  useEffect(() => {
    const h = setTimeout(() => setDebounced(query), 250);
    return () => clearTimeout(h);
  }, [query]);

  const searchQ = useQuery({
    queryKey: ["ldap-search", debounced],
    queryFn: () => api.get<{ users: LdapSearchUser[]; note?: string }>(`/users/ldap-search?q=${encodeURIComponent(debounced)}`),
    enabled: type === "internal" && debounced.trim().length >= 2,
  });

  const options: ComboboxOption[] = useMemo(() => {
    const base = (searchQ.data?.users ?? []).map((u) => ({
      value: u.fullName || u.username,
      label: u.fullName || u.username,
      hint: [u.username, u.email].filter(Boolean).join(" · "),
    }));
    // Keep the current selection visible even after the result list changes.
    if (name && !base.some((o) => o.value === name)) {
      base.unshift({ value: name, label: name, hint: "" });
    }
    return base;
  }, [searchQ.data, name]);

  const note = searchQ.data?.note;

  return (
    <div className="space-y-2">
      <Label>Requester</Label>
      <div className="flex flex-wrap items-center gap-2">
        <div className="inline-flex rounded-md border border-border p-0.5">
          <Button
            type="button"
            size="sm"
            variant={type === "internal" ? "default" : "ghost"}
            className="h-7"
            onClick={() => onTypeChange("internal")}
            data-testid="button-requester-internal"
          >
            Internal
          </Button>
          <Button
            type="button"
            size="sm"
            variant={type === "external" ? "default" : "ghost"}
            className="h-7"
            onClick={() => onTypeChange("external")}
            data-testid="button-requester-external"
          >
            External
          </Button>
        </div>
        <div className="min-w-[240px] flex-1">
          {type === "internal" ? (
            <Combobox
              options={options}
              value={name}
              onChange={onNameChange}
              placeholder="Search the directory…"
              searchPlaceholder="Type a name (min 2 chars)…"
              emptyText={
                debounced.trim().length < 2
                  ? "Type at least 2 characters."
                  : note || "No directory matches."
              }
              onSearchChange={setQuery}
              loading={searchQ.isFetching}
              data-testid="select-requester-internal"
            />
          ) : (
            <Input
              placeholder="Requester name (external)"
              value={name}
              onChange={(e) => onNameChange(e.target.value)}
              data-testid="input-requester-external"
            />
          )}
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        {type === "internal"
          ? "Pick an internal staff member from the Active Directory directory."
          : "Enter the name of an external requester (vendor, partner, etc.)."}
      </p>
    </div>
  );
}
