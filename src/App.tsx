import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "./supabaseClient";

// ── Types ─────────────────────────────────────────────────────────────────────
type Link = { id: string; title: string; magnet: string; created_date?: string };
type HttpLink = { id: string; title: string; url: string; created_date?: string };
type Toast = { id: number; msg: string; kind: "ok" | "error" };
type Confirmation = { title: string; body: string; danger?: boolean; onConfirm: () => void } | null;
type VaultView = "magnet" | "http";

const PRIO_KEY = "magnet-vault-priority";

// ── Helpers ───────────────────────────────────────────────────────────────────
function parseMagnetTitle(magnet: string) {
  if (!magnet) return "";
  const m = magnet.match(/[?&]dn=([^&]+)/i);
  if (m) {
    let raw = m[1].replace(/\+/g, " ");
    try { raw = decodeURIComponent(raw); } catch {}
    return raw.replace(/[._]+/g, " ").trim();
  }
  return "";
}
function isValidMagnet(v: string) {
  const s = (v || "").trim();
  return /^magnet:\?/i.test(s) && /xt=urn:btih:[a-z0-9]+/i.test(s);
}
function isValidHttpLink(v: string) {
  const s = (v || "").trim();
  return /^https?:\/\/[^\s]+$/i.test(s);
}
function parseHttpLinkTitle(url: string) {
  if (!url) return "";
  try {
    const u = new URL(url.trim());
    const path = u.pathname && u.pathname !== "/" ? u.pathname.replace(/\/+$/, "") : "";
    return path ? `${u.hostname}${path}` : u.hostname;
  } catch {
    return "";
  }
}
// Splits a blob of text into individual http(s) links, even when links are
// pasted back-to-back with no whitespace between them
// (e.g. "https://buffer.comhttps://outlook.com").
function extractHttpLinks(text: string): string[] {
  if (!text) return [];
  return text
    .split(/(?=https?:\/\/)/gi)
    .map((s) => s.trim().replace(/[\s,;]+$/, ""))
    .filter((s) => /^https?:\/\//i.test(s));
}
function parseSeasonEpisode(title: string) {
  if (!title) return null;
  let m = title.match(/s(\d{1,4})[\s._-]*e(\d{1,4})/i);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  m = title.match(/\b(\d{1,2})x(\d{1,3})\b/i);
  if (m) return { season: parseInt(m[1], 10), episode: parseInt(m[2], 10) };
  m = title.match(/\b(?:s|season)[\s._-]*(\d{1,4})(?!\d)/i);
  if (m) return { season: parseInt(m[1], 10), episode: null as number | null };
  return null;
}
function stripShowName(title: string) {
  if (!title) return "";
  let name = title.replace(/[._]+/g, " ");
  const seMatch = name.match(/\b(s\d{1,4}[\s._-]*e\d{1,4}|\d{1,2}x\d{1,4}|(?:s|season)[\s._-]*\d{1,4})(?!\d)/i);
  if (seMatch && seMatch.index !== undefined) name = name.slice(0, seMatch.index);
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}
function episodeKey(title: string) {
  const show = stripShowName(title);
  const se = parseSeasonEpisode(title);
  if (se) {
    const epStr = se.episode !== null ? `e${String(se.episode).padStart(2, "0")}` : "";
    return `${show}|s${String(se.season).padStart(2, "0")}${epStr}`;
  }
  return show || title.toLowerCase().trim();
}
function splitIntoGroups(arr: Link[], splitCount: number, perGroup: number): Link[][] {
  if (perGroup && perGroup > 0) {
    const g: Link[][] = [];
    for (let i = 0; i < arr.length; i += perGroup) g.push(arr.slice(i, i + perGroup));
    return g;
  }
  if (splitCount && splitCount >= 2) {
    const g: Link[][] = [];
    const size = Math.ceil(arr.length / splitCount);
    for (let i = 0; i < splitCount; i++) {
      const c = arr.slice(i * size, (i + 1) * size);
      if (c.length > 0) g.push(c);
    }
    return g;
  }
  return [arr];
}

// ── API (Supabase) ──────────────────────────────────────────────────────────
function rowToLink(r: any): Link {
  return {
    id: String(r.id),
    title: r.title ?? "",
    magnet: r.magnet ?? "",
    created_date: r.created_at,
  };
}

async function dbListLinks(): Promise<{ list: Link[] }> {
  const { data, error } = await supabase
    .from("links")
    .select("id, title, magnet, created_at")
    .order("created_at", { ascending: false })
    .limit(10000);
  if (error) throw new Error(error.message);
  return { list: (data || []).map(rowToLink) };
}

async function dbAddLink(title: string, magnet: string): Promise<Link> {
  const { data, error } = await supabase
    .from("links")
    .insert({ title: title.slice(0, 1000), magnet: magnet.slice(0, 4000) })
    .select("id, title, magnet, created_at")
    .single();
  if (error) throw new Error(error.message);
  return rowToLink(data);
}

async function dbAddLinksBulk(records: { title: string; magnet: string }[]): Promise<{ list: Link[] }> {
  if (!records.length) return { list: [] };
  const payload = records.map((r) => ({
    title: String(r.title ?? "").slice(0, 1000),
    magnet: String(r.magnet ?? "").slice(0, 4000),
  }));
  const { data, error } = await supabase.from("links").insert(payload).select("id, title, magnet, created_at");
  if (error) throw new Error(error.message);
  return { list: (data || []).map(rowToLink) };
}

async function dbDeleteLink(id: string): Promise<void> {
  const { error } = await supabase.from("links").delete().eq("id", Number(id));
  if (error) throw new Error(error.message);
}

async function dbDeleteLinksBulk(ids: string[]): Promise<void> {
  const numIds = ids.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  if (!numIds.length) return;
  const { error } = await supabase.from("links").delete().in("id", numIds);
  if (error) throw new Error(error.message);
}

// ── API (Supabase) — HTTP links ─────────────────────────────────────────────
function rowToHttpLink(r: any): HttpLink {
  return {
    id: String(r.id),
    title: r.title ?? "",
    url: r.url ?? "",
    created_date: r.created_at,
  };
}

async function dbListHttpLinks(): Promise<{ list: HttpLink[] }> {
  const { data, error } = await supabase
    .from("http_links")
    .select("id, title, url, created_at")
    .order("created_at", { ascending: false })
    .limit(10000);
  if (error) throw new Error(error.message);
  return { list: (data || []).map(rowToHttpLink) };
}

async function dbAddHttpLink(title: string, url: string): Promise<HttpLink> {
  const { data, error } = await supabase
    .from("http_links")
    .insert({ title: title.slice(0, 1000), url: url.slice(0, 4000) })
    .select("id, title, url, created_at")
    .single();
  if (error) throw new Error(error.message);
  return rowToHttpLink(data);
}

async function dbAddHttpLinksBulk(records: { title: string; url: string }[]): Promise<{ list: HttpLink[] }> {
  if (!records.length) return { list: [] };
  const payload = records.map((r) => ({
    title: String(r.title ?? "").slice(0, 1000),
    url: String(r.url ?? "").slice(0, 4000),
  }));
  const { data, error } = await supabase.from("http_links").insert(payload).select("id, title, url, created_at");
  if (error) throw new Error(error.message);
  return { list: (data || []).map(rowToHttpLink) };
}

async function dbDeleteHttpLink(id: string): Promise<void> {
  const { error } = await supabase.from("http_links").delete().eq("id", Number(id));
  if (error) throw new Error(error.message);
}

async function dbDeleteHttpLinksBulk(ids: string[]): Promise<void> {
  const numIds = ids.map((v) => Number(v)).filter((n) => Number.isFinite(n));
  if (!numIds.length) return;
  const { error } = await supabase.from("http_links").delete().in("id", numIds);
  if (error) throw new Error(error.message);
}

// ── Background ornaments ──────────────────────────────────────────────────────
function OceanBg() {
  return (
    <>
      <div className="orb orb-1" />
      <div className="orb orb-2" />
      <div className="orb orb-3" />
      {Array.from({ length: 24 }).map((_, i) => (
        <span key={i} className="bubble-bg" aria-hidden>{i % 3 === 0 ? "🫧" : i % 3 === 1 ? "🐚" : "🐠"}</span>
      ))}
    </>
  );
}

// ── Inline SVG icons ──────────────────────────────────────────────────────────
const I = {
  Mermaid: () => (<svg viewBox="0 0 24 24" fill="white" style={{ width: '1.4rem', height: '1.4rem' }}><path d="M12 2c-1.5 1.8-2.2 3.6-2.2 5.4 0 1.6.7 2.6 2.2 4 1.5-1.4 2.2-2.4 2.2-4C14.2 5.6 13.5 3.8 12 2z"/><circle cx="12" cy="9.2" r="1.4"/><path d="M7 13c0 4 2 8 5 9 3-1 5-5 5-9-1.6 1.4-3.3 2-5 2s-3.4-.6-5-2z"/></svg>),
  Chevron: () => (<svg className="chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m9 18 6-6-6-6" /></svg>),
  Funnel: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polygon points="22 3 2 3 10 12.46 10 19 14 21 14 12.46 22 3" /></svg>),
  Search: () => (<svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8" /><path d="m21 21-4.35-4.35" /></svg>),
  Eye: () => (<svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>),
  EyeOff: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" /><line x1="1" y1="1" x2="23" y2="23" /></svg>),
  Split: () => (<svg className="input-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2v-4M9 21H5a2 2 0 0 1-2-2v-4m0 0h18" /></svg>),
  Copy: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></svg>),
  Sort: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M7 12h10M11 18h2" /></svg>),
  Dedupe: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M2 20h20M6 20V10l6-8 6 8v10" /><path d="M10 20v-5h4v5" /></svg>),
  Exact: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" /><rect x="8" y="2" width="8" height="4" rx="1" ry="1" /><line x1="9" y1="14" x2="15" y2="14" /><line x1="9" y1="10" x2="15" y2="10" /></svg>),
  Sync: ({ spin }: { spin?: boolean }) => (<svg className={spin ? "mv-spin" : ""} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 2v6h-6" /><path d="M3 12a9 9 0 0 1 15-6.7L21 8" /><path d="M3 22v-6h6" /><path d="M21 12a9 9 0 0 1-15 6.7L3 16" /></svg>),
  Trash: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2" /></svg>),
  TrashSlash: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 6h18M19 6l-1 14H6L5 6M10 11v6M14 11v6M9 6V4h6v2" /><line x1="4" y1="20" x2="20" y2="4" /></svg>),
  Fire: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z" /></svg>),
  Save: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><polyline points="17 21 17 13 7 13 7 21" /><polyline points="7 3 7 8 15 8" /></svg>),
  Plus: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5v14" /></svg>),
  ArrowUp: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m18 15-6-6-6 6" /></svg>),
  ArrowDown: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="m6 9 6 6 6-6" /></svg>),
  X: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M18 6 6 18M6 6l12 12" /></svg>),
  Check: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M20 6 9 17l-5-5" /></svg>),
  Globe: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10" /><line x1="2" y1="12" x2="22" y2="12" /><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z" /></svg>),
  Magnet: () => (<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M6 15a6 6 0 0 0 12 0v-3" /><path d="M18 5v7" /><path d="M6 5v7" /><path d="M6 5h4" /><path d="M14 5h4" /></svg>),
};

// ── LinkRow — defined outside App so React never unmounts rows on parent re-render ──
type LinkRowProps = {
  l: Link;
  selected: boolean;
  onToggle: (id: string) => void;
  onCopy: (text: string, label: string) => void;
  onDelete: (id: string) => void;
};
function LinkRow({ l, selected, onToggle, onCopy, onDelete }: LinkRowProps) {
  const se = parseSeasonEpisode(l.title);
  const date = l.created_date ? new Date(l.created_date).toLocaleString() : "";
  return (
    <li className={`link-row${selected ? " selected" : ""}`} onClick={() => onToggle(l.id)}>
      <div className="link-row-inner">
        <div className="link-meta">
          <div className="link-title-wrap">
            <span className="link-title">{l.title || "(untitled)"}</span>
            {se && <span className="ep-badge">S{String(se.season).padStart(2, "0")}{se.episode !== null ? "E" + String(se.episode).padStart(2, "0") : ""}</span>}
          </div>
          <p className="link-magnet">{l.magnet}</p>
          <p className="link-date">{date}</p>
        </div>
        <div className="link-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" onClick={() => onCopy(l.magnet, "Link copied")} aria-label="Copy link"><I.Copy /></button>
          <button className="icon-btn del" onClick={() => onDelete(l.id)} aria-label="Delete link"><I.Trash /></button>
        </div>
      </div>
    </li>
  );
}

// ── HttpLinkRow — list item for the HTTP links vault ──────────────────────────
type HttpLinkRowProps = {
  l: HttpLink;
  selected: boolean;
  onToggle: (id: string) => void;
  onCopy: (text: string, label: string) => void;
  onDelete: (id: string) => void;
};
function HttpLinkRow({ l, selected, onToggle, onCopy, onDelete }: HttpLinkRowProps) {
  const date = l.created_date ? new Date(l.created_date).toLocaleString() : "";
  return (
    <li className={`link-row${selected ? " selected" : ""}`} onClick={() => onToggle(l.id)}>
      <div className="link-row-inner">
        <div className="link-meta">
          <div className="link-title-wrap">
            <span className="link-title">{l.title || "(untitled)"}</span>
          </div>
          <p className="link-magnet">{l.url}</p>
          <p className="link-date">{date}</p>
        </div>
        <div className="link-actions" onClick={(e) => e.stopPropagation()}>
          <button className="icon-btn" onClick={() => onCopy(l.url, "Link copied")} aria-label="Copy link"><I.Copy /></button>
          <button className="icon-btn del" onClick={() => onDelete(l.id)} aria-label="Delete link"><I.Trash /></button>
        </div>
      </div>
    </li>
  );
}

// ─────────────────────────────────────────────────────────────────────────────
export default function App() {
  // ── State ────────────────────────────────────────────────────────────────
  const [view, setView] = useState<VaultView>("magnet");

  const [allLinks, setAllLinks] = useState<Link[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [hiddenIds, setHiddenIds] = useState<Set<string>>(new Set());
  const [syncing, setSyncing] = useState(false);
  const [connected, setConnected] = useState(false);

  const [allHttpLinks, setAllHttpLinks] = useState<HttpLink[]>([]);
  const [selectedHttpIds, setSelectedHttpIds] = useState<Set<string>>(new Set());
  const [httpSyncing, setHttpSyncing] = useState(false);
  const [httpConnected, setHttpConnected] = useState(false);
  const [hFilter, setHFilter] = useState("");
  const [addHttpTitle, setAddHttpTitle] = useState("");
  const [addHttpUrl, setAddHttpUrl] = useState("");

  const [toasts, setToasts] = useState<Toast[]>([]);
  const toastIdRef = useRef(0);
  const [confirmation, setConfirmation] = useState<Confirmation>(null);

  const [priorityWords, setPriorityWords] = useState<string[]>(() => {
    try {
      const r = localStorage.getItem(PRIO_KEY);
      return r ? JSON.parse(r) : ["repack", "proper", "2160p", "1080p"];
    } catch { return ["repack", "proper", "2160p", "1080p"]; }
  });
  const [newPrio, setNewPrio] = useState("");
  const [dedupeMode, setDedupeMode] = useState<"priority" | "first" | "last">("priority");
  const [dedupeIgnore, setDedupeIgnore] = useState("");
  const [hidePhrase, setHidePhrase] = useState("");
  const [phraseHiddenIds, setPhraseHiddenIds] = useState<Set<string>>(new Set());

  // filters
  const [fShow, setFShow] = useState("");
  const [fTerm, setFTerm] = useState("");
  const [fOr, setFOr] = useState("");
  const [fOnly, setFOnly] = useState("");
  const [fExcept, setFExcept] = useState("");
  const [fHideCount, setFHideCount] = useState("");
  const [fHidePos, setFHidePos] = useState<"top" | "bottom">("top");
  const [fSplit, setFSplit] = useState("");
  const [fPerGroup, setFPerGroup] = useState("");

  // add form
  const [addTitle, setAddTitle] = useState("");
  const [addMagnet, setAddMagnet] = useState("");

  // ── Toast / confirm helpers ──────────────────────────────────────────────
  const pushToast = useCallback((msg: string, kind: "ok" | "error" = "ok") => {
    const id = ++toastIdRef.current;
    setToasts((t) => [...t, { id, msg, kind }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3200);
  }, []);

  const askConfirm = useCallback((c: NonNullable<Confirmation>) => setConfirmation(c), []);

  // ── Persist priority ─────────────────────────────────────────────────────
  useEffect(() => {
    localStorage.setItem(PRIO_KEY, JSON.stringify(priorityWords));
  }, [priorityWords]);

  // ── Filters ──────────────────────────────────────────────────────────────
  const filters = useMemo(() => ({
    show: fShow.trim().toLowerCase(),
    term: fTerm.trim().toLowerCase(),
    or: fOr.trim().toLowerCase(),
    only: fOnly.trim().toLowerCase(),
    except: fExcept.trim().toLowerCase(),
    hideCount: parseInt(fHideCount || "0", 10),
    hidePos: fHidePos,
    splitCount: parseInt(fSplit || "0", 10),
    perGroup: parseInt(fPerGroup || "0", 10),
  }), [fShow, fTerm, fOr, fOnly, fExcept, fHideCount, fHidePos, fSplit, fPerGroup]);

  const isFilterActive = !!(filters.show || filters.term || filters.or || filters.only || filters.except || (filters.hideCount > 0));

  const filteredLinks = useMemo(() => {
    const terms = filters.term ? filters.term.split(/\s+/).filter(Boolean) : [];
    const orTerms = filters.or ? filters.or.split(/\s+/).filter(Boolean) : [];
    const onlyPhrases = filters.only ? filters.only.split(",").map((p) => p.trim()).filter(Boolean) : [];
    const exceptPhrases = filters.except ? filters.except.split(",").map((p) => p.trim()).filter(Boolean) : [];

    let result = allLinks.filter((l) => {
      if (hiddenIds.has(l.id)) return false;
      if (phraseHiddenIds.has(l.id)) return false;
      const titleLower = (l.title || "").toLowerCase();
      const showName = stripShowName(l.title);
      const searchText = `${l.title} ${l.magnet}`.toLowerCase();
      if (onlyPhrases.length && !onlyPhrases.some((p) => titleLower.includes(p))) return false;
      if (exceptPhrases.length && exceptPhrases.some((p) => titleLower.includes(p))) return false;
      if (filters.show && !showName.includes(filters.show)) return false;
      if (terms.length && !terms.every((t) => searchText.includes(t))) return false;
      if (orTerms.length && !orTerms.some((t) => searchText.includes(t))) return false;
      return true;
    });

    if (filters.hideCount > 0) {
      result = filters.hidePos === "top"
        ? result.slice(filters.hideCount)
        : result.slice(0, Math.max(0, result.length - filters.hideCount));
    }
    return result;
  }, [allLinks, hiddenIds, phraseHiddenIds, filters]);

  const groups = useMemo(() => {
    const useSplit = filters.splitCount >= 2 || filters.perGroup >= 1;
    if (!useSplit) return null;
    return splitIntoGroups(filteredLinks, filters.splitCount >= 2 ? filters.splitCount : 0, filters.perGroup >= 1 ? filters.perGroup : 0);
  }, [filteredLinks, filters.splitCount, filters.perGroup]);

  // ── Fetch ────────────────────────────────────────────────────────────────
  const fetchLinks = useCallback(async () => {
    setSyncing(true);
    try {
      const data = await dbListLinks();
      setAllLinks(data.list || []);
      setConnected(true);
      setHiddenIds(new Set());
      pushToast("Vault synced", "ok");
    } catch (e: any) {
      setConnected(false);
      pushToast("Sync failed: " + e.message, "error");
    } finally {
      setSyncing(false);
    }
  }, [pushToast]);

  useEffect(() => { fetchLinks(); }, [fetchLinks]);

  const fetchHttpLinks = useCallback(async () => {
    setHttpSyncing(true);
    try {
      const data = await dbListHttpLinks();
      setAllHttpLinks(data.list || []);
      setHttpConnected(true);
      pushToast("HTTP vault synced", "ok");
    } catch (e: any) {
      setHttpConnected(false);
      pushToast("HTTP sync failed: " + e.message, "error");
    } finally {
      setHttpSyncing(false);
    }
  }, [pushToast]);

  useEffect(() => { fetchHttpLinks(); }, [fetchHttpLinks]);

  // ── Actions ──────────────────────────────────────────────────────────────
  function toggleSelect(id: string) {
    setSelectedIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  async function copyText(text: string, label = "Copied") {
    try {
      await navigator.clipboard.writeText(text);
      pushToast(label);
    } catch {
      pushToast("Clipboard copy failed", "error");
    }
  }

  function copyGroup(idx: number) {
    if (!groups || !groups[idx] || !groups[idx].length) return pushToast("Nothing to copy", "error");
    copyText(groups[idx].map((l) => l.magnet).join("\n"), `Copied Group ${idx + 1} — ${groups[idx].length} link(s)`);
  }

  function handleCopyAll() {
    if (selectedIds.size > 0) {
      const sel = allLinks.filter((l) => selectedIds.has(l.id));
      if (!sel.length) return;
      copyText(sel.map((l) => l.magnet).join("\n"), `Copied ${sel.length} selected link(s)!`);
      setSelectedIds(new Set());
      return;
    }
    if (!filteredLinks.length) return pushToast("Nothing to copy", "error");
    copyText(filteredLinks.map((l) => l.magnet).join("\n"), `Copied ${filteredLinks.length} link(s)`);
  }

  function handleSort() {
    setAllLinks((prev) => [...prev].sort((a, b) => {
      const sa = parseSeasonEpisode(a.title), sb = parseSeasonEpisode(b.title);
      if (!sa && !sb) return a.title.localeCompare(b.title);
      if (!sa) return 1; if (!sb) return -1;
      const sc = stripShowName(a.title).localeCompare(stripShowName(b.title));
      if (sc !== 0) return sc;
      if (sa.season !== sb.season) return sa.season - sb.season;
      const epA = sa.episode !== null ? sa.episode : -1;
      const epB = sb.episode !== null ? sb.episode : -1;
      return epA - epB;
    }));
    pushToast("Sorted by season + episode");
  }

  function handleDedupe() {
    const ignorePhrase = dedupeIgnore.trim().toLowerCase();
    const score = (item: Link) => {
      const hay = `${item.title} ${item.magnet}`.toLowerCase();
      if (ignorePhrase && hay.includes(ignorePhrase)) return -1;
      for (let i = 0; i < priorityWords.length; i++)
        if (hay.includes(priorityWords[i])) return priorityWords.length - i;
      return 0;
    };
    const scope = isFilterActive ? filteredLinks : allLinks.filter((l) => !hiddenIds.has(l.id) && !phraseHiddenIds.has(l.id));
    const groupsMap = new Map<string, Link[]>();
    for (const item of scope) {
      const key = episodeKey(item.title);
      if (!groupsMap.has(key)) groupsMap.set(key, []);
      groupsMap.get(key)!.push(item);
    }
    const hide: string[] = [];
    for (const arr of groupsMap.values()) {
      if (arr.length < 2) continue;
      let keeper = arr[0];
      if (dedupeMode === "last") {
        keeper = arr[arr.length - 1];
      } else if (dedupeMode === "first") {
        keeper = arr[0];
      } else {
        for (let i = 1; i < arr.length; i++) {
          const s = score(arr[i]), ks = score(keeper);
          if (s > ks) keeper = arr[i];
        }
      }
      for (const item of arr) if (item.id !== keeper.id) hide.push(item.id);
    }
    if (!hide.length) return pushToast("No duplicates found");
    setHiddenIds((h) => { const n = new Set(h); hide.forEach((i) => n.add(i)); return n; });
    pushToast(`Hid ${hide.length} duplicate(s) (sync to restore)`);
  }

  function handleExactDedupe() {
    const scope = isFilterActive ? filteredLinks : allLinks.filter((l) => !hiddenIds.has(l.id) && !phraseHiddenIds.has(l.id));
    const seen = new Set<string>();
    const hide: string[] = [];
    for (const item of scope) {
      const match = item.magnet.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
      const key = match ? match[1].toLowerCase() : item.magnet.trim().toLowerCase();
      if (seen.has(key)) hide.push(item.id);
      else seen.add(key);
    }
    if (!hide.length) return pushToast("No exact duplicates found");
    setHiddenIds((h) => { const n = new Set(h); hide.forEach((i) => n.add(i)); return n; });
    pushToast(`Hid ${hide.length} exact duplicate(s) (sync to restore)`);
  }

  async function handleDelete(id: string) {
    setSyncing(true);
    try {
      await dbDeleteLink(id);
      setAllLinks((prev) => prev.filter((l) => l.id !== id));
      setSelectedIds((s) => { const n = new Set(s); n.delete(id); return n; });
      pushToast("Link deleted");
    } catch (e: any) { pushToast("Delete failed: " + e.message, "error"); }
    finally { setSyncing(false); }
  }

  function handlePurgeFiltered() {
    if (!filteredLinks.length) return pushToast("No filtered items to drop", "error");
    askConfirm({
      title: "Purge filtered links?",
      body: `This will permanently delete the ${filteredLinks.length} visible link(s). This cannot be undone.`,
      danger: true,
      onConfirm: async () => {
        setSyncing(true);
        try {
          const ids = filteredLinks.map((l) => l.id);
          await dbDeleteLinksBulk(ids);
          setAllLinks((prev) => prev.filter((l) => !ids.includes(l.id)));
          setSelectedIds(new Set());
          pushToast(`Purged ${ids.length} filtered items`);
        } catch (e: any) { pushToast("Purge failed: " + e.message, "error"); }
        finally { setSyncing(false); }
      },
    });
  }

  function handlePurge() {
    if (!allLinks.length) return pushToast("Vault already empty", "error");
    askConfirm({
      title: "Purge entire vault?",
      body: `This will permanently delete ALL ${allLinks.length} link(s). This cannot be undone.`,
      danger: true,
      onConfirm: async () => {
        setSyncing(true);
        try {
          const ids = allLinks.map((l) => l.id);
          await dbDeleteLinksBulk(ids);
          setAllLinks([]);
          setSelectedIds(new Set());
          pushToast("Vault completely purged");
        } catch (e: any) { pushToast("Purge failed: " + e.message, "error"); }
        finally { setSyncing(false); }
      },
    });
  }

  async function handleAdd() {
    if (!isValidMagnet(addMagnet)) return pushToast("Invalid magnet URL", "error");
    const t = addTitle.trim() || parseMagnetTitle(addMagnet) || "(untitled)";
    setSyncing(true);
    try {
      const created = await dbAddLink(t, addMagnet.trim());
      setAllLinks((prev) => [created, ...prev]);
      setAddTitle(""); setAddMagnet("");
      pushToast("Link added!");
    } catch (e: any) { pushToast("Add failed: " + e.message, "error"); }
    finally { setSyncing(false); }
  }

  async function handlePasteAdd() {
    const candidates = (addMagnet || "").trim().split(/\s+/).filter(isValidMagnet);
    if (!candidates.length) return pushToast("No valid magnet links found", "error");
    // Compare by btih hash so magnet links with different parameter ordering aren't re-added
    function btihOf(m: string) {
      const match = m.match(/xt=urn:btih:([a-zA-Z0-9]+)/i);
      return match ? match[1].toLowerCase() : m.trim().toLowerCase();
    }
    const existingHashes = new Set(allLinks.map((l) => btihOf(l.magnet)));
    const toAdd = candidates.filter((s) => !existingHashes.has(btihOf(s)));
    const skipped = candidates.length - toAdd.length;
    if (!toAdd.length) return pushToast(`All ${skipped} link(s) already in vault`);
    setSyncing(true);
    try {
      const payload = toAdd.map((s) => ({ title: parseMagnetTitle(s) || s.slice(0, 160), magnet: s }));
      await dbAddLinksBulk(payload);
      await fetchLinks();
      setAddMagnet("");
      pushToast(`Added ${toAdd.length} link(s)${skipped ? `, skipped ${skipped} duplicate(s)` : ""}`);
    } catch (e: any) { pushToast("Paste failed: " + e.message, "error"); }
    finally { setSyncing(false); }
  }

  // ── Actions — HTTP links ─────────────────────────────────────────────────
  function urlKeyOf(u: string) {
    return (u || "").trim().toLowerCase().replace(/\/+$/, "");
  }

  function toggleSelectHttp(id: string) {
    setSelectedHttpIds((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id); else n.add(id);
      return n;
    });
  }

  const filteredHttpLinks = useMemo(() => {
    const f = hFilter.trim().toLowerCase();
    if (!f) return allHttpLinks;
    return allHttpLinks.filter((l) => `${l.title} ${l.url}`.toLowerCase().includes(f));
  }, [allHttpLinks, hFilter]);

  function handleHttpCopyAll() {
    if (selectedHttpIds.size > 0) {
      const sel = allHttpLinks.filter((l) => selectedHttpIds.has(l.id));
      if (!sel.length) return;
      copyText(sel.map((l) => l.url).join("\n"), `Copied ${sel.length} selected link(s)!`);
      setSelectedHttpIds(new Set());
      return;
    }
    if (!filteredHttpLinks.length) return pushToast("Nothing to copy", "error");
    copyText(filteredHttpLinks.map((l) => l.url).join("\n"), `Copied ${filteredHttpLinks.length} link(s)`);
  }

  function handleHttpSort() {
    setAllHttpLinks((prev) => [...prev].sort((a, b) => (a.title || a.url).localeCompare(b.title || b.url)));
    pushToast("Sorted alphabetically");
  }

  function handleHttpExactDedupe() {
    const scope = hFilter.trim() ? filteredHttpLinks : allHttpLinks;
    const seen = new Set<string>();
    const dupeIds: string[] = [];
    for (const item of scope) {
      const key = urlKeyOf(item.url);
      if (seen.has(key)) dupeIds.push(item.id);
      else seen.add(key);
    }
    if (!dupeIds.length) return pushToast("No exact duplicates found");
    askConfirm({
      title: "Remove duplicate links?",
      body: `This will permanently delete ${dupeIds.length} duplicate link(s), keeping the first copy of each.`,
      danger: true,
      onConfirm: async () => {
        setHttpSyncing(true);
        try {
          await dbDeleteHttpLinksBulk(dupeIds);
          setAllHttpLinks((prev) => prev.filter((l) => !dupeIds.includes(l.id)));
          pushToast(`Removed ${dupeIds.length} duplicate(s)`);
        } catch (e: any) { pushToast("Dedupe failed: " + e.message, "error"); }
        finally { setHttpSyncing(false); }
      },
    });
  }

  async function handleHttpDelete(id: string) {
    setHttpSyncing(true);
    try {
      await dbDeleteHttpLink(id);
      setAllHttpLinks((prev) => prev.filter((l) => l.id !== id));
      setSelectedHttpIds((s) => { const n = new Set(s); n.delete(id); return n; });
      pushToast("Link deleted");
    } catch (e: any) { pushToast("Delete failed: " + e.message, "error"); }
    finally { setHttpSyncing(false); }
  }

  function handleHttpPurge() {
    if (!allHttpLinks.length) return pushToast("Vault already empty", "error");
    askConfirm({
      title: "Purge entire HTTP vault?",
      body: `This will permanently delete ALL ${allHttpLinks.length} link(s). This cannot be undone.`,
      danger: true,
      onConfirm: async () => {
        setHttpSyncing(true);
        try {
          const ids = allHttpLinks.map((l) => l.id);
          await dbDeleteHttpLinksBulk(ids);
          setAllHttpLinks([]);
          setSelectedHttpIds(new Set());
          pushToast("HTTP vault completely purged");
        } catch (e: any) { pushToast("Purge failed: " + e.message, "error"); }
        finally { setHttpSyncing(false); }
      },
    });
  }

  async function handleHttpAdd() {
    if (!isValidHttpLink(addHttpUrl)) return pushToast("Invalid http(s) link", "error");
    const t = addHttpTitle.trim() || parseHttpLinkTitle(addHttpUrl) || "(untitled)";
    setHttpSyncing(true);
    try {
      const created = await dbAddHttpLink(t, addHttpUrl.trim());
      setAllHttpLinks((prev) => [created, ...prev]);
      setAddHttpTitle(""); setAddHttpUrl("");
      pushToast("Link added!");
    } catch (e: any) { pushToast("Add failed: " + e.message, "error"); }
    finally { setHttpSyncing(false); }
  }

  async function handleHttpPasteAdd() {
    // Parses out individual http(s) links even when pasted back-to-back with
    // no separator, e.g. "https://buffer.comhttps://outlook.com".
    const candidates = extractHttpLinks(addHttpUrl).filter(isValidHttpLink);
    if (!candidates.length) return pushToast("No valid http(s) links found", "error");
    const existingKeys = new Set(allHttpLinks.map((l) => urlKeyOf(l.url)));
    const seenInBatch = new Set<string>();
    const toAdd = candidates.filter((s) => {
      const k = urlKeyOf(s);
      if (existingKeys.has(k) || seenInBatch.has(k)) return false;
      seenInBatch.add(k);
      return true;
    });
    const skipped = candidates.length - toAdd.length;
    if (!toAdd.length) return pushToast(`All ${skipped} link(s) already in vault`);
    setHttpSyncing(true);
    try {
      const payload = toAdd.map((s) => ({ title: parseHttpLinkTitle(s) || s.slice(0, 160), url: s }));
      await dbAddHttpLinksBulk(payload);
      await fetchHttpLinks();
      setAddHttpUrl("");
      pushToast(`Added ${toAdd.length} link(s)${skipped ? `, skipped ${skipped} duplicate(s)` : ""}`);
    } catch (e: any) { pushToast("Paste failed: " + e.message, "error"); }
    finally { setHttpSyncing(false); }
  }

  function autoFillHttpTitle(url: string) {
    setAddHttpUrl(url);
    if (!addHttpTitle.trim()) {
      const p = parseHttpLinkTitle(url);
      if (p) setAddHttpTitle(p);
    }
  }

  // ── Priority ─────────────────────────────────────────────────────────────
  function movePriority(idx: number, dir: -1 | 1) {
    if (idx + dir < 0 || idx + dir >= priorityWords.length) return;
    setPriorityWords((p) => {
      const next = [...p];
      [next[idx], next[idx + dir]] = [next[idx + dir], next[idx]];
      return next;
    });
  }
  function removePriority(idx: number) { setPriorityWords((p) => p.filter((_, i) => i !== idx)); }
  function handleHidePhrase() {
    const phrase = hidePhrase.trim().toLowerCase();
    if (!phrase) return pushToast("Enter a phrase first", "error");
    const matches = allLinks.filter((l) => `${l.title} ${l.magnet}`.toLowerCase().includes(phrase));
    if (!matches.length) return pushToast("No links match that phrase", "error");
    setPhraseHiddenIds((h) => { const n = new Set(h); matches.forEach((l) => n.add(l.id)); return n; });
    pushToast(`Hid ${matches.length} matching link(s)`);
  }
  function handleUnhideAll() {
    if (!phraseHiddenIds.size) return pushToast("Nothing hidden", "error");
    setPhraseHiddenIds(new Set());
    pushToast("Unhid all phrase-matched links");
  }
  function addPriorityWord() {
    const w = newPrio.trim().toLowerCase();
    if (w && !priorityWords.includes(w)) {
      setPriorityWords((p) => [...p, w]);
      setNewPrio("");
    }
  }

  // ── Render helpers ───────────────────────────────────────────────────────
  function autoFillTitle(magnet: string) {
    setAddMagnet(magnet);
    if (!addTitle.trim()) {
      const p = parseMagnetTitle(magnet);
      if (p) setAddTitle(p);
    }
  }

  const statusLabel = syncing ? "Syncing…" : connected ? "Vault Synced" : "Offline / Errors";
  const copyAllLabel = selectedIds.size > 0 ? `Copy Selected (${selectedIds.size})` : "Copy All";
  const copyAllPrimary = selectedIds.size > 0;
  const dedupeLabel = isFilterActive ? "Dedupe (filtered)" : "Dedupe";
  const exactLabel = isFilterActive ? "Exact (filtered)" : "Exact Dedupe";

  return (
    <>
      <OceanBg />
      <div className="mv-app">
        {/* Header */}
        <header className="mv-header">
          <div className="header-icon"><I.Mermaid /></div>
          <div>
            <h1 className="mv-title">✦ Magnet Vault ✦</h1>
            <p className="mv-subtitle">Supabase · Link Manager</p>
          </div>
        </header>

        {/* Tabs */}
        <div className="mv-tabs" role="tablist" aria-label="Vault type">
          <button role="tab" aria-selected={view === "magnet"} className={`mv-tab${view === "magnet" ? " active" : ""}`} onClick={() => setView("magnet")}>
            <I.Magnet />Magnet Links
          </button>
          <button role="tab" aria-selected={view === "http"} className={`mv-tab${view === "http" ? " active" : ""}`} onClick={() => setView("http")}>
            <I.Globe />HTTP Links
          </button>
        </div>

        {view === "magnet" && (<>
        {/* Filters */}
        <section className="filter-section mv-card" aria-label="Filters" style={{ padding: "0.9rem 1rem", gap: "0.55rem" }}>
          <div className="mv-card-title" style={{ marginBottom: "0.25rem" }}>
            <I.Funnel /> Filters
          </div>
          <div className="filter-row">
            <div className="input-wrap"><I.Search /><input type="text" value={fShow} onChange={(e) => setFShow(e.target.value)} placeholder="show name (e.g. the wire)" /></div>
            <div className="input-wrap"><I.Search /><input type="text" value={fTerm} onChange={(e) => setFTerm(e.target.value)} placeholder="all keywords (e.g. S03 1080p)" /></div>
          </div>
          <div className="filter-row">
            <div className="input-wrap"><I.Search /><input type="text" value={fOr} onChange={(e) => setFOr(e.target.value)} placeholder="exact keywords — match ANY (e.g. 2160p REPACK)" /></div>
            <div className="input-wrap"><I.Search /><input type="text" value={fOnly} onChange={(e) => setFOnly(e.target.value)} placeholder="only exact phrase (e.g. 1080p, 2160p)" /></div>
          </div>
          <div className="filter-row">
            <div className="input-wrap"><I.Search /><input type="text" value={fExcept} onChange={(e) => setFExcept(e.target.value)} placeholder="except exact phrase (e.g. cam, telesync)" /></div>
          </div>
          <div className="filter-row">
            <div className="input-wrap" style={{ flex: 2 }}><I.Eye /><input type="number" value={fHideCount} onChange={(e) => setFHideCount(e.target.value)} placeholder="Number of links to hide..." min={0} /></div>
            <div className="input-wrap" style={{ flex: 1 }}>
              <select value={fHidePos} onChange={(e) => setFHidePos(e.target.value as any)}>
                <option value="top">From Top</option>
                <option value="bottom">From Bottom (Last)</option>
              </select>
            </div>
          </div>
          <div className="filter-row">
            <div className="input-wrap" style={{ flex: 2 }}><I.Split /><input type="number" value={fSplit} onChange={(e) => setFSplit(e.target.value)} placeholder="Split filtered links into N groups..." min={2} max={100} /></div>
            <div className="input-wrap" style={{ flex: 1 }}>
              <input type="number" className="no-icon" value={fPerGroup} onChange={(e) => setFPerGroup(e.target.value)} placeholder="Links per group..." min={1} />
            </div>
          </div>
          {fSplit && fPerGroup && (
            <p className="hint" style={{ color: "var(--mv-amber, #f59e0b)", marginTop: "0.1rem" }}>
              ⚠ Both split fields set — "Links per group" takes priority; N groups is ignored.
            </p>
          )}
        </section>

        {/* Status bar */}
        <div className="status-bar">
          <span className={`status-dot ${connected ? "connected" : "disconnected"}`} />
          <span className={`status-label ${connected ? "connected" : "disconnected"}`}>{statusLabel}</span>
          <span className="status-count">{filteredLinks.length} / {allLinks.length} shown</span>
        </div>

        {/* Actions */}
        <div className="action-bar">
          <button className={`btn${copyAllPrimary ? " btn-primary" : ""}`} disabled={syncing} onClick={handleCopyAll}><I.Copy />{copyAllLabel}</button>
          <button className="btn" disabled={syncing} onClick={handleSort}><I.Sort />Sort by Episode</button>
          <button className="btn" disabled={syncing} onClick={handleDedupe}><I.Dedupe />{dedupeLabel}</button>
          <button className="btn" disabled={syncing} onClick={handleExactDedupe}><I.Exact />{exactLabel}</button>
          <button className="btn" disabled={syncing} onClick={fetchLinks}><I.Sync spin={syncing} />Sync</button>
          <button className="btn btn-danger" disabled={syncing} onClick={handlePurgeFiltered}><I.TrashSlash />Purge Filtered</button>
          <button className="btn btn-danger" disabled={syncing} onClick={handlePurge}><I.Fire />Purge Vault</button>
        </div>

        {/* Link container */}
        <div id="link-container">
          {groups ? (
            groups.every((g) => g.length === 0)
              ? <div className="empty-state">🐠 No magnet links match the current filters.</div>
              : groups.map((g, idx) => (
                <div className="group-block" key={idx}>
                  <div className="group-header">
                    <div className="group-title">
                      🐠 Group {idx + 1}<span style={{ fontWeight: 400, color: "var(--mv-muted)", fontSize: "0.65rem" }}>of {groups.length}</span>
                      <span className="group-badge">{g.length} link{g.length !== 1 ? "s" : ""}</span>
                    </div>
                    <button className="group-copy-btn" onClick={() => copyGroup(idx)}><I.Copy />Copy Group {idx + 1}</button>
                  </div>
                  {g.length === 0
                    ? <div className="empty-state" style={{ padding: "1.25rem 1rem", fontSize: "0.72rem" }}>No links in this group.</div>
                    : <ul className="link-list-wrap" role="list" style={{ border: "none", borderRadius: 0, background: "transparent" }}>
                        {g.map((l) => <LinkRow key={l.id} l={l} selected={selectedIds.has(l.id)} onToggle={toggleSelect} onCopy={copyText} onDelete={handleDelete} />)}
                      </ul>}
                </div>
              ))
          ) : !filteredLinks.length ? (
            <div className="empty-state">
              🐠 {allLinks.length === 0 ? "No magnet links found in the vault. Add some below!" : "No magnet links match the current filters."}
            </div>
          ) : (
            <ul className="link-list-wrap" role="list">
              {filteredLinks.map((l) => <LinkRow key={l.id} l={l} selected={selectedIds.has(l.id)} onToggle={toggleSelect} onCopy={copyText} onDelete={handleDelete} />)}
            </ul>
          )}
        </div>

        {/* Dedupe Priority */}
        <details className="mv-collapse">
          <summary><I.Chevron /><svg style={{ width: "0.85rem", height: "0.85rem", color: "var(--mv-violet)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m18 15-6-6-6 6" /></svg>Dedupe Priority Words</summary>
          <div className="collapsible-body">
            <p className="hint">Choose how the Dedupe button picks which copy of a duplicate episode to keep.</p>

            <div className="dedupe-mode-row">
              <div className="radio-group">
                <label className="radio-option">
                  <input type="radio" name="dedupeMode" checked={dedupeMode === "priority"} onChange={() => setDedupeMode("priority")} />
                  <span className="radio-dot" />
                  Priority words
                </label>
                <label className="radio-option">
                  <input type="radio" name="dedupeMode" checked={dedupeMode === "first"} onChange={() => setDedupeMode("first")} />
                  <span className="radio-dot" />
                  Keep first (as shown)
                </label>
                <label className="radio-option">
                  <input type="radio" name="dedupeMode" checked={dedupeMode === "last"} onChange={() => setDedupeMode("last")} />
                  <span className="radio-dot" />
                  Keep last (as shown)
                </label>
              </div>
              <button className="btn" onClick={handleUnhideAll}><I.EyeOff />Unhide all</button>
            </div>

            {dedupeMode === "priority" && (
              <>
                <p className="hint"><em>When in Priority words mode</em>, the copy whose link or title contains the highest-ranking word is kept. Use arrows to rank.</p>
                <div className="priority-list">
                  {priorityWords.length === 0
                    ? <div className="empty-state" style={{ padding: "1rem", fontSize: "0.7rem" }}>No priority words set.</div>
                    : priorityWords.map((word, index) => (
                      <div className="priority-item" key={word + index}>
                        <span className="priority-word">{word.toUpperCase()}</span>
                        <button className="prio-btn" onClick={() => movePriority(index, -1)} disabled={index === 0} aria-label="Move up"><I.ArrowUp /></button>
                        <button className="prio-btn" onClick={() => movePriority(index, 1)} disabled={index === priorityWords.length - 1} aria-label="Move down"><I.ArrowDown /></button>
                        <button className="prio-btn del" onClick={() => removePriority(index)} aria-label="Remove"><I.X /></button>
                      </div>
                    ))}
                </div>
                <div className="add-btn-row">
                  <div className="input-wrap" style={{ flex: 1 }}>
                    <input type="text" className="no-icon" value={newPrio} onChange={(e) => setNewPrio(e.target.value)} placeholder="Add priority keyword..." onKeyDown={(e) => { if (e.key === "Enter") addPriorityWord(); }} />
                  </div>
                  <button className="btn btn-primary" onClick={addPriorityWord}><I.Plus />Add</button>
                </div>
                <div className="input-wrap" style={{ marginTop: "0.5rem" }}>
                  <input type="text" className="no-icon" value={dedupeIgnore} onChange={(e) => setDedupeIgnore(e.target.value)} placeholder="Phrase to ignore when scoring (e.g. CAM)" />
                </div>
              </>
            )}

            <p className="hint" style={{ marginTop: "0.85rem" }}>Hide any link whose title or URL contains a specific phrase (case-insensitive). Only matching links are hidden — nothing else changes. Refresh to restore.</p>
            <div className="add-btn-row">
              <div className="input-wrap" style={{ flex: 1 }}>
                <input type="text" className="no-icon" value={hidePhrase} onChange={(e) => setHidePhrase(e.target.value)} placeholder="Phrase to hide (e.g. CAM)" onKeyDown={(e) => { if (e.key === "Enter") handleHidePhrase(); }} />
              </div>
              <button className="btn" onClick={handleHidePhrase}><I.EyeOff />Hide matches</button>
            </div>
          </div>
        </details>

        {/* Add Links */}
        <details className="mv-collapse">
          <summary><I.Chevron /><svg style={{ width: "0.85rem", height: "0.85rem", color: "var(--mv-violet)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5v14" /></svg>Add Links Manually</summary>
          <div className="collapsible-body">
            <div className="add-form">
              <div className="input-wrap"><input type="text" className="no-icon" value={addTitle} onChange={(e) => setAddTitle(e.target.value)} placeholder="Title (auto-filled from magnet if blank)" /></div>
              <textarea rows={3} value={addMagnet} onChange={(e) => autoFillTitle(e.target.value)} placeholder="magnet:?xt=urn:btih:..." />
              <div className="add-btn-row">
                <button className="btn btn-primary" disabled={syncing} onClick={handleAdd}><I.Plus />Add</button>
                <button className="btn" disabled={syncing} onClick={handlePasteAdd}><I.Dedupe />Add all pasted</button>
              </div>
            </div>
          </div>
        </details>
        </>)}

        {view === "http" && (<>
        {/* HTTP Filter */}
        <section className="filter-section mv-card" aria-label="HTTP Filters" style={{ padding: "0.9rem 1rem", gap: "0.55rem" }}>
          <div className="mv-card-title" style={{ marginBottom: "0.25rem" }}>
            <I.Funnel /> Filter
          </div>
          <div className="filter-row">
            <div className="input-wrap"><I.Search /><input type="text" value={hFilter} onChange={(e) => setHFilter(e.target.value)} placeholder="search title or url..." /></div>
          </div>
        </section>

        {/* Status bar */}
        <div className="status-bar">
          <span className={`status-dot ${httpConnected ? "connected" : "disconnected"}`} />
          <span className={`status-label ${httpConnected ? "connected" : "disconnected"}`}>{httpSyncing ? "Syncing…" : httpConnected ? "Vault Synced" : "Offline / Errors"}</span>
          <span className="status-count">{filteredHttpLinks.length} / {allHttpLinks.length} shown</span>
        </div>

        {/* Actions */}
        <div className="action-bar">
          <button className={`btn${selectedHttpIds.size > 0 ? " btn-primary" : ""}`} disabled={httpSyncing} onClick={handleHttpCopyAll}><I.Copy />{selectedHttpIds.size > 0 ? `Copy Selected (${selectedHttpIds.size})` : "Copy All"}</button>
          <button className="btn" disabled={httpSyncing} onClick={handleHttpSort}><I.Sort />Sort A–Z</button>
          <button className="btn" disabled={httpSyncing} onClick={handleHttpExactDedupe}><I.Exact />Dedupe</button>
          <button className="btn" disabled={httpSyncing} onClick={fetchHttpLinks}><I.Sync spin={httpSyncing} />Sync</button>
          <button className="btn btn-danger" disabled={httpSyncing} onClick={handleHttpPurge}><I.Fire />Purge Vault</button>
        </div>

        {/* Link container */}
        <div id="http-link-container">
          {!filteredHttpLinks.length ? (
            <div className="empty-state">
              🐚 {allHttpLinks.length === 0 ? "No http links found in the vault. Add some below!" : "No links match the current filter."}
            </div>
          ) : (
            <ul className="link-list-wrap" role="list">
              {filteredHttpLinks.map((l) => <HttpLinkRow key={l.id} l={l} selected={selectedHttpIds.has(l.id)} onToggle={toggleSelectHttp} onCopy={copyText} onDelete={handleHttpDelete} />)}
            </ul>
          )}
        </div>

        {/* Add HTTP Links */}
        <details className="mv-collapse" open>
          <summary><I.Chevron /><svg style={{ width: "0.85rem", height: "0.85rem", color: "var(--mv-violet)" }} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M5 12h14M12 5v14" /></svg>Add Links Manually</summary>
          <div className="collapsible-body">
            <p className="hint">Paste one or more http(s) links. Links pasted back-to-back with no space between them (e.g. "https://buffer.comhttps://outlook.com") are split automatically.</p>
            <div className="add-form">
              <div className="input-wrap"><input type="text" className="no-icon" value={addHttpTitle} onChange={(e) => setAddHttpTitle(e.target.value)} placeholder="Title (auto-filled from URL if blank)" /></div>
              <textarea rows={3} value={addHttpUrl} onChange={(e) => autoFillHttpTitle(e.target.value)} placeholder="https://..." />
              <div className="add-btn-row">
                <button className="btn btn-primary" disabled={httpSyncing} onClick={handleHttpAdd}><I.Plus />Add</button>
                <button className="btn" disabled={httpSyncing} onClick={handleHttpPasteAdd}><I.Dedupe />Add all pasted</button>
              </div>
            </div>
          </div>
        </details>
        </>)}
      </div>

      {/* Toasts */}
      <div className="mv-toast-stack" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`} role="status">
            {t.kind === "ok" ? <I.Check /> : <I.X />}
            <span>{t.msg}</span>
          </div>
        ))}
      </div>

      {/* Confirm modal */}
      {confirmation && (
        <div className="mv-overlay" onClick={(e) => { if (e.target === e.currentTarget) setConfirmation(null); }} role="dialog" aria-modal="true">
          <div className="mv-modal">
            <div className="mv-modal-title">{confirmation.title}</div>
            <div className="mv-modal-body">{confirmation.body}</div>
            <div className="mv-modal-actions">
              <button className="btn" onClick={() => setConfirmation(null)}>Cancel</button>
              <button
                className={confirmation.danger ? "btn btn-danger" : "btn btn-primary"}
                onClick={() => { const fn = confirmation.onConfirm; setConfirmation(null); fn(); }}
              >Confirm</button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
