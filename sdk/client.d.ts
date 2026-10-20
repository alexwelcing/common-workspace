/** Same-origin browser SDK. No room credentials or global app objects are exposed. */
export type CommonMode = 'inline' | 'overlay' | 'floating';
export type CommonExperience = 'classic' | 'space';
export type CommonCapability = 'inspect' | 'canvas-write' | 'media-capture' | 'recording' | 'page-context';
export type CommonEditableEntityType = 'text' | 'sticky' | 'rectangle' | 'ellipse' | 'arrow' | 'draw' | 'image' | 'diagram';
export interface CommonPoint { x: number; y: number; }
export interface CommonBounds extends CommonPoint { width: number; height: number; }
export interface CommonView extends CommonPoint { zoom: number; }
export interface CommonEntityFields extends CommonBounds {
  text?: string; color?: string; fill?: string; fontSize?: number; points?: CommonPoint[];
  title?: string; language?: 'mermaid' | 'plantuml'; source?: string; url?: string; locked?: boolean;
}
export interface CommonEntity extends CommonEntityFields {
  id: string; type: CommonEditableEntityType | 'screen'; orderKey?: string; z?: number;
  participantId?: string; externalConsent?: boolean; hasImageData?: boolean; imageDataLength?: number;
}
/** Compact discovery result. Image payloads, drawing points, and stream identifiers are omitted. */
export interface CommonEntitySummary {
  id: string; type: CommonEditableEntityType | 'screen'; bounds: CommonBounds;
  title?: string; snippet?: string; locked?: boolean; selected?: boolean;
}
/** Live results from the active board, rather than a frozen snapshot. */
export interface CommonCanvasSearchResult {
  items: CommonEntitySummary[]; total: number; offset: number;
  /** Follow this offset with the same filters. Null means the current results are exhausted. */
  nextOffset: number | null;
}
export type CommonCanvasReadField = 'text' | 'source' | 'title';
export interface CommonCanvasReadResult {
  id: string; type: CommonEditableEntityType | 'screen'; field: CommonCanvasReadField;
  /** Exact field substring. Offsets and total count JavaScript UTF-16 code units. */
  text: string; total: number; offset: number;
  nextOffset: number | null;
}
export interface CommonPageViewport { width: number; height: number; offsetLeft: number; offsetTop: number; }
export interface CommonPageIdentity { sourceId: string; documentId: string; revision: number; }
export interface CommonPageCompanionState extends CommonPageIdentity {
  available: boolean; origin: string; captureHandle: string | null;
}
/** Explicit semantic target. No form values or DOM text are collected. */
export interface CommonPageTarget {
  id: string; label: string; element: Element; role?: string;
}
export interface CommonPageTargetSummary {
  id: string; label: string; role: string; disabled: boolean;
  /** CSS viewport coordinates; omitted when a target cannot be located. */
  bounds?: CommonBounds;
}
export interface CommonPageDescription extends CommonPageIdentity {
  origin: string; title: string; summary: string; route: string;
  viewport: CommonPageViewport; targetCount: number; truncated?: boolean;
}
export interface CommonPageSearchResult extends CommonPageIdentity {
  items: CommonPageTargetSummary[]; total: number; offset: number; nextOffset: number | null;
}
export interface CommonPageLocateResult extends CommonPageIdentity {
  target: CommonPageTargetSummary & { bounds: CommonBounds };
  viewport: CommonPageViewport;
  /** Visible intersection in fractions of the source viewport, from 0 to 1. */
  normalizedBounds: CommonBounds;
}
export interface CommonPageSearchOptions { query?: string; offset?: number; limit?: number; }
export interface CommonPageCompanionOptions {
  /** Restricts the registered targets and DOM observation to this product region. */
  root: Element;
  /** Synchronous, explicit page description. Route is reduced to its pathname. */
  describe(): { title?: string; summary?: string; route?: string };
  /** At most 200 targets with distinct IDs and short, explicit labels. */
  targets(): ReadonlyArray<CommonPageTarget>;
  /** Opt in to same-origin browser-tab capture identity when supported. Default: false. */
  captureHandle?: boolean;
}
/** Host-owned provider. Mounted canvases detach from it without destroying it. */
export interface CommonPageCompanion {
  readonly ownerDocument: Document;
  getState(): CommonPageCompanionState;
  /** Provider results stay within 5,000 JSON characters. Summary shortening is marked by truncated. */
  inspect(): CommonPageDescription;
  /** Visible targets only; follow nextOffset because the requested page can shrink to fit. */
  search(options?: CommonPageSearchOptions): CommonPageSearchResult;
  locate(options: { id: string }): CommonPageLocateResult;
  subscribe(listener: (event: { reason: 'updated' | 'navigation' | 'destroyed' }) => void): () => void;
  /** Notify Common after host state changes that do not alter the observed product DOM. */
  update(): CommonPageCompanionState;
  /** Disconnects observers/listeners and releases its owned capture handle. */
  destroy(): void;
}
export interface CommonSourceBinding {
  status: 'not-sharing' | 'unverified' | 'verified'; screenId?: string;
}
export interface CommonSourceInspectResult extends CommonPageDescription { binding: CommonSourceBinding; }
export interface CommonSourceSearchResult extends CommonPageSearchResult { binding: CommonSourceBinding; }
export interface CommonSourceLocateResult extends CommonPageLocateResult {
  binding: CommonSourceBinding; canvasBounds?: CommonBounds;
}
export interface CommonSourceHighlightResult extends CommonPageIdentity { screenId: string; targetId: string; durationMs: number; }
export type CommonNewEntity = Partial<CommonEntityFields> & { type: CommonEditableEntityType; id?: string };
export type CommonWalkthroughStep = { title: string; text?: string } & (
  | { targetId: string; bounds?: never }
  | { bounds: CommonBounds; targetId?: never }
  | { bounds?: never; targetId?: never }
);
interface CommandId { requestId?: string; }
/** Plain JSON only. Runtime authorization and bounded-value validation still apply. */
export type CommonCommand = CommandId & (
  | { action: 'source.inspect' }
  | ({ action: 'source.search' } & CommonPageSearchOptions)
  | { action: 'source.locate'; id: string }
  | { action: 'source.highlight'; id: string; revision: number; durationMs?: number }
  | { action: 'canvas.inspect'; includeImageData?: boolean }
  | {
    action: 'canvas.search';
    /** Up to 200 characters. Case-insensitive literal tokens match title, text, and diagram source. */
    query?: string;
    types?: Array<CommonEditableEntityType | 'screen'>;
    selectedOnly?: boolean;
    /** Integer from 0 to 100,000. */
    offset?: number;
    /** 1–12 items; default 6. A 6,000-character envelope budget may reduce the page; follow nextOffset. */
    limit?: number;
  }
  | {
    action: 'canvas.read'; id: string;
    /** Defaults to source for diagrams and text for other objects. */
    field?: CommonCanvasReadField;
    /** Integer from 0 to 100,000. */
    offset?: number;
    /** 1–2,000 characters; default 1,000. The envelope budget may reduce the page; follow nextOffset. */
    limit?: number;
  }
  | { action: 'canvas.add'; entity: CommonNewEntity }
  | { action: 'canvas.update'; id: string; patch: Partial<CommonEntityFields> }
  | { action: 'canvas.remove'; id: string }
  | { action: 'canvas.layer'; id: string; position: 'front' | 'back' | 'forward' | 'backward' }
  | { action: 'canvas.lock'; id: string; locked: boolean }
  | ({ action: 'view.focus' } & ({ id: string; bounds?: never } | { bounds: CommonBounds; id?: never }))
  | { action: 'view.fit' }
  | { action: 'image.add'; dataUrl: string; title?: string; x?: number; y?: number; width?: number; height?: number }
  | { action: 'walkthrough.load'; steps: CommonWalkthroughStep[] }
  | { action: 'walkthrough.next' | 'walkthrough.previous' | 'walkthrough.stop' }
  | { action: 'capture.snapshot'; download?: boolean }
  | { action: 'recording.start'; source: 'canvas' | 'window' }
  | { action: 'recording.stop' | 'recording.list' }
  | { action: 'recording.download'; id: string }
  | { action: 'canvas.export'; format?: 'svg' | 'json'; download?: boolean }
);
export interface CommonAgentFailure {
  ok: false;
  error: { code: string; message: string; action?: string; category?: string };
}
export interface CommonAgentSuccess<T = unknown> { ok: true; result: T; }
export type CommonAgentEnvelope<T = unknown> = CommonAgentSuccess<T> | CommonAgentFailure;
export interface CommonGrantState {
  active: boolean; capabilities: CommonCapability[]; expiresAt: number | null; remainingMs: number;
  revision: number; reason: string;
  scope: { sandbox: boolean; roomId: string | null; participantId: string | null } | null;
}
export interface CommonAgentDescription {
  version: string; enabled: boolean;
  actions: Record<string, string[]>;
  capabilities: Record<CommonCapability, { title: string; description: string }>;
  actionCapabilities: Record<string, CommonCapability[]>;
  grants: CommonGrantState;
  limits: Record<string, number>;
  command: string; examples: unknown[]; notes: string[];
  tools: unknown;
  source?: { available: boolean };
}
export interface CommonAgentState {
  version: string; enabled: boolean; sandbox: boolean; connected: boolean; ready: boolean; readOnly: boolean;
  grants: CommonGrantState;
  /** Availability only until page context is permitted. No source page content is included here. */
  source?: { available: boolean; binding?: CommonSourceBinding };
  /** Content fields are absent until the user grants inspection in this mount. */
  room?: { id: string; name: string } | null;
  participantId?: string | null;
  participants?: Array<{ id?: string; name?: string; color?: string; isHost?: boolean; sharing?: boolean }>;
  view?: CommonView | null;
  entities?: CommonEntity[];
  walkthrough?: { active: boolean; index: number; total: number; current: CommonWalkthroughStep | null } | null;
  recording?: Record<string, unknown> | null;
}
export interface CommonAgentCallOptions {
  /** Cancels startup waiting or a pending call with SDK_CANCELLED. Applied changes remain. */
  signal?: AbortSignal;
}
export interface CommonAgent {
  describe(): Promise<CommonAgentDescription>;
  state(options?: { includeImageData?: boolean }): Promise<CommonAgentState | CommonAgentFailure>;
  /** Does not grant permissions or open the browser's screen picker. */
  execute<T = unknown>(command: CommonCommand, options?: CommonAgentCallOptions): Promise<CommonAgentEnvelope<T>>;
  /** Runs sequentially; failures do not roll back earlier successful commands. */
  batch<T = unknown>(commands: CommonCommand[], options?: CommonAgentCallOptions): Promise<CommonAgentEnvelope<CommonAgentEnvelope<T>[]>>;
}
export interface CommonController {
  open(): void;
  /** Hides the panel. An active share or recording continues with a visible indicator. */
  close(): void;
  toggle(): void;
  /** Readiness can change after an iframe reload. SDK transport failures reject. */
  ready(): Promise<CommonController>;
  readonly agent: CommonAgent;
  /** Stops this mount's session/media and removes its DOM. Safe to call again. */
  destroy(): Promise<void>;
}
export interface MountCommonOptions {
  target: Element;
  /** Absolute same-origin mount path. Default: /__common/. Must match createCommon. */
  basePath?: string;
  /** floating is an alias for overlay. Default: overlay. */
  mode?: CommonMode;
  /** Default: true for inline, false for overlay/floating. */
  open?: boolean;
  /** Personal workspace experience. Default: classic. Existing roomId metadata takes precedence. */
  experience?: CommonExperience;
  roomId?: string;
  /** Optional same-document host provider. Reading it requires the user's separate page-context grant. */
  pageContext?: CommonPageCompanion;
  onReady?: (controller: CommonController) => void;
  onError?: (error: Error & { code?: string }) => void;
  onOpenChange?: (open: boolean) => void;
}
export function mountCommon(options: MountCommonOptions): CommonController;
export function createPageCompanion(options: CommonPageCompanionOptions): CommonPageCompanion;
export default mountCommon;
