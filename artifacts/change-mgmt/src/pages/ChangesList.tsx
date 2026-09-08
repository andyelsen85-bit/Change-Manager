import { useMemo, useState } from "react";
import { Link, useLocation, useSearch } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { ArrowDownUp, Check, CircleAlert, CircleCheck, Clock3, Plus, Search, StickyNote } from "lucide-react";
import { api } from "@/lib/api";
import type { CategoryItem, ChangeRequest, ChangeStatus, ChangeTrack } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Combobox, type ComboboxOption } from "@/components/ui/combobox";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { RiskScoreBadge, StatusBadge, TrackBadge } from "@/components/StatusBadge";
import { fmtDateShort, fmtDateTime } from "@/lib/format";
import { Skeleton } from "@/components/ui/skeleton";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { PirCountdownBadge } from "@/components/PirCountdownBadge";
import { useDiscussionStates } from "@/lib/discussions";

const TRACKS: ChangeTrack[] = ["normal", "standard", "emergency"];
const STATUSES: ChangeStatus[] = ["draft", "submitted", "in_review", "awaiting_approval", "approved", "in_preprod_testing", "scheduled", "in_progress", "implemented", "in_testing", "awaiting_implementation", "awaiting_pir", "completed", "rejected", "rolled_back", "cancelled"];
type SortKey = "ref" | "category" | "title" | "track" | "status" | "plannedStart" | "plannedEnd" | "updatedAt";
type SavedFilters = { search: string; track: string; status: string; category: string };
const FILTER_STORAGE_KEY = "change-it:changes-filters";

function initialFilters(locationSearch: string): SavedFilters {
  const params = new URLSearchParams(locationSearch);
  if (params.size > 0) {
    return {
      search: params.get("search") ?? "",
      track: params.get("track") ?? "all",
      status: params.get("status") ?? "active",
      category: params.get("category") ?? "all",
    };
  }
  try {
    const saved = JSON.parse(sessionStorage.getItem(FILTER_STORAGE_KEY) ?? "") as Partial<SavedFilters>;
    return {
      search: saved.search ?? "",
      track: saved.track ?? "all",
      status: saved.status ?? "active",
      category: saved.category ?? "all",
    };
  } catch {
    return { search: "", track: "all", status: "active", category: "all" };
  }
}

export function ChangesListPage() {
  const [, setLocation] = useLocation();
  const locationSearch = useSearch();
  const [initial] = useState(() => initialFilters(locationSearch));
  const [search, setSearch] = useState(initial.search);
  const [trackFilter, setTrackFilter] = useState(initial.track);
  const [statusFilter, setStatusFilter] = useState(initial.status);
  const [categoryFilter, setCategoryFilter] = useState(initial.category);
  const [sort, setSort] = useState<{ key: SortKey; desc: boolean }>({ key: "updatedAt", desc: true });

  const updateFilters = (next: Partial<{ search: string; track: string; status: string; category: string }>) => {
    const values = { search, track: trackFilter, status: statusFilter, category: categoryFilter, ...next };
    setSearch(values.search); setTrackFilter(values.track); setStatusFilter(values.status); setCategoryFilter(values.category);
    sessionStorage.setItem(FILTER_STORAGE_KEY, JSON.stringify(values));
    const params = new URLSearchParams();
    if (values.search.trim()) params.set("search", values.search.trim());
    if (values.track !== "all") params.set("track", values.track);
    if (values.status !== "all") params.set("status", values.status);
    if (values.category !== "all") params.set("category", values.category);
    setLocation(`/changes${params.size ? `?${params}` : ""}`);
  };
  const apiParams = new URLSearchParams();
  if (trackFilter !== "all") apiParams.set("track", trackFilter);
  if (statusFilter !== "all") apiParams.set("status", statusFilter);
  const path = `/changes${apiParams.size ? `?${apiParams}` : ""}`;
  const { data, isLoading } = useQuery({ queryKey: [path], queryFn: () => api.get<ChangeRequest[]>(path) });
  const categoriesQ = useQuery({ queryKey: ["categories"], queryFn: () => api.get<CategoryItem[]>("/categories") });
  const discussionsQ = useDiscussionStates();
  const discussions = useMemo(() => new Map((discussionsQ.data ?? []).map((s) => [s.changeId, s])), [discussionsQ.data]);
  const categoryOptions: ComboboxOption[] = [{ value: "all", label: "All categories" }, ...(categoriesQ.data ?? []).map((c) => ({ value: c.key, label: c.name }))];

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data ?? []).filter((c) => (!categoryFilter || categoryFilter === "all" || c.category === categoryFilter) && (!q || [c.ref, c.title, c.ownerName ?? "", c.createdByName ?? ""].some((v) => v.toLowerCase().includes(q)))).sort((a, b) => {
      const av = String(a[sort.key] ?? ""), bv = String(b[sort.key] ?? "");
      const result = av.localeCompare(bv, undefined, { numeric: true });
      return sort.desc ? -result : result;
    });
  }, [data, search, categoryFilter, sort]);
  const toggleSort = (key: SortKey) => setSort((old) => ({ key, desc: old.key === key ? !old.desc : false }));
  const head = (label: string, key: SortKey) => <TableHead className="p-2"><button className="inline-flex items-center gap-1 font-medium hover:text-foreground" onClick={() => toggleSort(key)}>{label}<ArrowDownUp className="h-3 w-3" /></button></TableHead>;

  return <div className="space-y-4" data-testid="page-changes-list">
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between"><div><h2 className="text-2xl font-semibold tracking-tight">Change requests</h2><p className="text-sm text-muted-foreground">All requests across normal, standard, and emergency tracks.</p></div><Link href="/changes/new"><Button data-testid="button-create-change"><Plus className="mr-2 h-4 w-4" /> New Change</Button></Link></div>
    <Card><CardContent className="space-y-4 p-4"><div className="grid gap-3 md:grid-cols-5"><div className="relative md:col-span-2"><Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" /><Input placeholder="Search by ref, title, or creator" className="pl-9" value={search} onChange={(e) => updateFilters({ search: e.target.value })} data-testid="input-search-changes" /></div>
      <Combobox options={[{ value: "all", label: "All tracks" }, ...TRACKS.map((t) => ({ value: t, label: t[0].toUpperCase() + t.slice(1) }))]} value={trackFilter} onChange={(track) => updateFilters({ track })} placeholder="Track" data-testid="select-track-filter" />
      <Combobox options={[{ value: "active", label: "All active" }, { value: "all", label: "All statuses" }, ...STATUSES.map((s) => ({ value: s, label: s.replace(/_/g, " ") }))]} value={statusFilter} onChange={(status) => updateFilters({ status })} placeholder="Status" data-testid="select-status-filter" />
      <Combobox options={categoryOptions} value={categoryFilter} onChange={(category) => updateFilters({ category })} placeholder="Category" data-testid="select-category-filter" />
    </div>
    {isLoading ? <Skeleton className="h-72 w-full" /> : filtered.length === 0 ? <div className="py-16 text-center text-sm text-muted-foreground">No changes match these filters.</div> : <div className="rounded-md border border-border"><Table className="table-fixed text-xs"><TableHeader><TableRow>
      {head("Ref", "ref")}{head("Category", "category")}{head("Title", "title")}<TableHead className="w-6 p-1" /><TableHead className="p-2">Track</TableHead>{head("Status", "status")}<TableHead className="p-2">Risk</TableHead><TableHead className="p-2">Creator</TableHead><TableHead className="p-2 text-center">CAB</TableHead><TableHead className="p-2">PIR</TableHead>{head("Planned start", "plannedStart")}{head("Planned end", "plannedEnd")}{head("Updated", "updatedAt")}
    </TableRow></TableHeader><TableBody>{filtered.map((c) => <TableRow key={c.id} className="cursor-pointer hover:bg-muted/40" onClick={() => setLocation(`/changes/${c.id}`)} data-testid={`row-change-${c.id}`}>
      <TableCell className="p-2 font-mono">{c.ref}</TableCell><TableCell className="truncate p-2">{c.category ?? "—"}</TableCell><TableCell className="truncate p-2 font-medium">{c.title}</TableCell>
      <TableCell className="p-1 text-center">{discussions.get(c.id) && <StickyNote className={`inline h-3.5 w-3.5 ${discussions.get(c.id)?.unread ? "text-amber-500" : "text-muted-foreground/40"}`} />}</TableCell><TableCell className="p-2"><TrackBadge track={c.track} /></TableCell><TableCell className="p-2"><StatusBadge status={c.status} /></TableCell><TableCell className="p-2"><RiskScoreBadge impact={c.impact} probability={c.risk} /></TableCell><TableCell className="truncate p-2">{c.createdByName ?? c.ownerName ?? "—"}</TableCell>
      <TableCell className="p-2 text-center"><CabIndicator change={c} /></TableCell><TableCell className="p-2 whitespace-nowrap">{c.status === "completed" && c.track !== "standard" ? <Check className="h-4 w-4 text-success" aria-label="PIR completed" /> : <PirCountdownBadge change={c} data-testid={`badge-pir-${c.id}`} />}</TableCell><TableCell className="p-2 whitespace-nowrap">{fmtDateShort(c.plannedStart)}</TableCell><TableCell className="p-2 whitespace-nowrap">{fmtDateShort(c.plannedEnd)}</TableCell><TableCell className="p-2 whitespace-nowrap text-muted-foreground">{fmtDateTime(c.updatedAt)}</TableCell>
    </TableRow>)}</TableBody></Table></div>}
    </CardContent></Card>
  </div>;
}

function CabIndicator({ change }: { change: ChangeRequest }) {
  const date = change.cabMeetingDate ? new Date(change.cabMeetingDate) : null;
  const upcoming = date && date.getTime() > Date.now();
  const approved = ["approved", "scheduled", "in_progress", "implemented", "in_testing", "awaiting_pir", "completed"].includes(change.status);
  const state = !date || change.cabMeetingStatus === "cancelled" ? { text: "Not planned", icon: CircleAlert, cls: "text-destructive", tip: "CAB not planned" } : upcoming ? { text: "Upcoming", icon: Clock3, cls: "text-amber-500", tip: `Upcoming CAB: ${fmtDateTime(change.cabMeetingDate!)}` } : change.cabMeetingStatus === "completed" && approved ? { text: "Approved", icon: CircleCheck, cls: "text-success", tip: `CAB occurred and change is approved (${fmtDateTime(change.cabMeetingDate!)})` } : { text: "Not approved", icon: CircleAlert, cls: "text-destructive", tip: `CAB has not occurred and approved the change (${fmtDateTime(change.cabMeetingDate!)})` };
  const Icon = state.icon;
  return <TooltipProvider delayDuration={150}><Tooltip><TooltipTrigger asChild><span className={`inline-flex items-center gap-1 ${state.cls}`}><Icon className="h-3.5 w-3.5" /><span className="hidden xl:inline">{state.text}</span></span></TooltipTrigger><TooltipContent>{state.tip}</TooltipContent></Tooltip></TooltipProvider>;
}