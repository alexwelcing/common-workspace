/** Same-origin browser SDK. No room credentials or global app objects are exposed. */
export type CommonMode = 'inline' | 'overlay' | 'floating';
export type CommonExperience = 'classic' | 'space';
export type CommonCapability = 'inspect' | 'canvas-write' | 'media-capture' | 'recording';
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
export type CommonNewEntity = Partial<CommonEntityFields> & { type: CommonEditableEntityType; id?: string };
export type CommonWalkthroughStep = { title: string; text?: string } & (
  | { targetId: string; bounds?: never }
  | { bounds: CommonBounds; targetId?: never }
  | { bounds?: never; targetId?: never }
);
interface CommandId { requestId?: string; }
/** Plain JSON only. Runtime authorization and bounded-value validation still apply. */
export type CommonCommand = CommandId & (
  | { action: 'canvas.inspect'; includeImageData?: boolean }
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
}
export interface CommonAgentState {
  version: string; enabled: boolean; sandbox: boolean; connected: boolean; ready: boolean; readOnly: boolean;
  grants: CommonGrantState;
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
  onReady?: (controller: CommonController) => void;
  onError?: (error: Error & { code?: string }) => void;
  onOpenChange?: (open: boolean) => void;
}
export function mountCommon(options: MountCommonOptions): CommonController;
export default mountCommon;
