// API shapes come from the generated OpenAPI types (npm run gen:api → @satisfy/api-types).
// Only the endpoints that return plain dicts (learning, status, profile) are typed by hand below.
import type { components } from '@satisfy/api-types';
import type { EntryValues } from './entryDraft';

type Schemas = components['schemas'];
export type PageTable = Schemas['PageTable'];
export type PageContent = Required<Schemas['PageContent']>;
export type TraceStep = Schemas['TraceStep'];
export type ZoneView = Schemas['ZoneView'];
export type SizeView = Schemas['SizeView'];
export type Recommendation = Schemas['RecommendResponse'];
// Fields with server defaults are optional when sending (the generated type is the output form).
type Defaulted = 'shape_reference' | 'density_kg_m3';
export type FitRequest = Omit<Schemas['FitRequest'], Defaulted> &
  Partial<Pick<Schemas['FitRequest'], Defaulted>>;

export interface Purchase {
  id: string;
  asin: string;
  title: string;
  size: string;
  snapshot: Record<string, { status: string; value_cm: number | null }>;
  feedback: { answers: Record<string, string> } | null;
}

export interface Learning {
  purchases: Purchase[];
  offsets_cm: Record<string, number>;
  learned: string[];
  items: { purchase_id: string; zone: string; text: string; delta_cm: number }[];
  kiosk_mode: boolean;
}

export interface ProviderState {
  name: string;
  paid: boolean;
  available: boolean;
  reason: string;
}

export interface AgentStatus {
  illustration?: 'male' | 'female' | 'neutral';
  kiosk_mode: boolean;
  profile_saved: boolean;
  resolution_order: string[];
  providers: ProviderState[];
  session_body: boolean;
}

export interface ApiError {
  error: string;
  status: number;
  detail?: unknown;
}

export interface Choices {
  preference: 'fitted' | 'regular' | 'relaxed';
  layer: 't-shirt' | 'hoodie';
}
export interface BodyEntry extends EntryValues {
  canonical: FitRequest;
}

export type Message =
  | { op: 'status' }
  | { op: 'recommend'; page: PageContent; chart_type_override?: 'garment' | 'body' }
  | { op: 'compare'; asins: string[] }
  | { op: 'learning' }
  | { op: 'purchase'; asin: string; size: string; title: string }
  | { op: 'feedback'; purchase_id: string; answers: Record<string, string> }
  | { op: 'undo'; purchase_id: string }
  | { op: 'resetLearning' }
  | { op: 'getProfile' }
  | {
      op: 'saveProfile';
      fit_request: FitRequest;
      choices: Choices;
      remember: boolean;
      entry?: BodyEntry;
    }
  | { op: 'deleteProfile' }
  | { op: 'open3d'; url: string }
  | { op: 'openProfile' };

export type Reply<T> = { ok: true; data: T } | { ok: false; error: ApiError };
