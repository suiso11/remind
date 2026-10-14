/**
 * R13 M1 synthetic baseline fixture (versioned, synthetic-only).
 * Exact approved seeds/queries; no network, no models, no user data.
 */
export const BASELINE_FIXTURE_VERSION = "baseline-v1";
export const BASELINE_SCHEMA_VERSION = 1;
export const BASELINE_K = 3;
export const BASELINE_REPETITIONS = 3;
export const BASELINE_RUN_SEED = "baseline-v1-seed";
export const BASELINE_RUN_QUALITY = "baseline-v1-quality";
export const BASELINE_OBSERVED_AT = "2026-09-01T00:00:00.000Z";
export const BASELINE_SESSION = "b1-session";

export const SCOPE_P = "personal/default";
export const SCOPE_W = "work/default";

export interface BaselineSeed {
  alias: string;
  scope: string;
  eventId: string;
  turnId: string;
  utterance: string;
  body: string;
  kind: "user_fact";
  tags: string[];
  /** link aliases resolved to actual returned IDs at seed time */
  linkAliases: string[];
}

export const BASELINE_SEEDS: BaselineSeed[] = [
  {
    alias: "orchard",
    scope: SCOPE_P,
    eventId: "b1-orchard",
    turnId: "b1-t01",
    utterance: "I will collect persimmons from the orchard in November; bring two baskets.",
    body: "Orchard persimmon harvest is in November.",
    kind: "user_fact",
    tags: ["orchard"],
    linkAliases: [],
  },
  {
    alias: "tea",
    scope: SCOPE_P,
    eventId: "b1-tea",
    turnId: "b1-t02",
    utterance: "朝の飲み物は緑茶です。砂糖は入れません。",
    body: "朝は緑茶を選ぶ。",
    kind: "user_fact",
    tags: ["drink"],
    linkAliases: [],
  },
  {
    alias: "delivery",
    scope: SCOPE_P,
    eventId: "b1-delivery",
    turnId: "b1-t03",
    utterance: "The hallway delivery booking code is xylophone; the courier arrives at noon.",
    body: "Hallway delivery appointment.",
    kind: "user_fact",
    tags: [],
    linkAliases: [],
  },
  {
    alias: "beacon",
    scope: SCOPE_P,
    eventId: "b1-beacon",
    turnId: "b1-t04",
    utterance: "The lighthouse keeper checks the evening beacon before the harbor maintenance round.",
    body: "Lighthouse keeper evening inspection.",
    kind: "user_fact",
    tags: ["harbor"],
    linkAliases: [],
  },
  {
    alias: "chart",
    scope: SCOPE_P,
    eventId: "b1-chart",
    turnId: "b1-t05",
    utterance: "Consult the harbor tide chart during that maintenance round.",
    body: "Harbor tide chart inspection.",
    kind: "user_fact",
    tags: ["harbor"],
    linkAliases: ["beacon"],
  },
  {
    alias: "lens",
    scope: SCOPE_P,
    eventId: "b1-lens",
    turnId: "b1-t06",
    utterance: "Clean the lantern lens after checking the beacon and tide chart.",
    body: "Lantern lens cleaning procedure.",
    kind: "user_fact",
    tags: ["harbor"],
    linkAliases: ["beacon", "chart"],
  },
  {
    alias: "bicycle",
    scope: SCOPE_P,
    eventId: "b1-bicycle",
    turnId: "b1-t07",
    utterance: "I commute by bicycle on weekdays and leave it in the covered rack.",
    body: "Bicycle commuting on weekdays.",
    kind: "user_fact",
    tags: [],
    linkAliases: [],
  },
  {
    alias: "foreign",
    scope: SCOPE_W,
    eventId: "b1-foreign",
    turnId: "b1-t08",
    utterance: "隔離暗号は業務用の保管庫に限ります。",
    body: "隔離暗号",
    kind: "user_fact",
    tags: [],
    linkAliases: [],
  },
  {
    alias: "retired",
    scope: SCOPE_P,
    eventId: "b1-retired",
    turnId: "b1-t09",
    utterance: "封鎖標識は廃止対象です。",
    body: "封鎖標識",
    kind: "user_fact",
    tags: [],
    linkAliases: [],
  },
  {
    alias: "old",
    scope: SCOPE_P,
    eventId: "b1-old",
    turnId: "b1-t10",
    utterance: "撤去符号は旧版の案内です。",
    body: "撤去符号",
    kind: "user_fact",
    tags: [],
    linkAliases: [],
  },
];

export const BASELINE_NEW_EVENT = {
  eventId: "b1-new",
  turnId: "b1-t11",
  scope: SCOPE_P,
  utterance: "The revised route uses the eastern entrance.",
  correctBody: "Replacement route uses the eastern entrance.",
} as const;

export const BASELINE_ORPHAN_EVENT = {
  eventId: "b1-orphan",
  turnId: "b1-t12",
  scope: SCOPE_P,
  utterance: "未参照印 is a raw-only reminder with no distilled note.",
} as const;

export type BaselineQueryKind =
  | "positive"
  | "negative";

export interface BaselineQueryDef {
  id: string;
  order: number;
  query: string;
  tags?: string[];
  /** alias whose actual ID is used as link param */
  linkAlias?: string;
  goldAliases: string[];
  kind: BaselineQueryKind;
  note: string;
}

export const BASELINE_QUERIES: BaselineQueryDef[] = [
  { id: "q01-en-normalized", order: 1, query: "  ＰＥＲＳＩＭＭＯＮ  ", goldAliases: ["orchard"], kind: "positive", note: "en-normalized" },
  { id: "q02-ja-lexical", order: 2, query: "緑茶", goldAliases: ["tea"], kind: "positive", note: "ja-lexical" },
  { id: "q03-raw-descent", order: 3, query: "xylophone", goldAliases: ["delivery"], kind: "positive", note: "raw-descent; query ONLY raw" },
  { id: "q04-graph-backlinks", order: 4, query: "lighthouse", goldAliases: ["beacon", "chart", "lens"], kind: "positive", note: "graph-backlinks" },
  { id: "q05-tag-seed", order: 5, query: "龘靐齉", tags: ["harbor"], goldAliases: ["beacon", "chart", "lens"], kind: "positive", note: "tag-seed rare CJK isolates" },
  { id: "q06-link-seed", order: 6, query: "龘靐齉", linkAlias: "lens", goldAliases: ["beacon", "chart", "lens"], kind: "positive", note: "link-seed rare CJK isolates" },
  { id: "q07-semantic-gap", order: 7, query: "二輪車通勤", goldAliases: ["bicycle"], kind: "positive", note: "semantic-gap descriptive lexical miss kept positive" },
  { id: "q08-scope-isolation", order: 8, query: "隔離暗号", goldAliases: [], kind: "negative", note: "scope-isolation forbidden foreign" },
  { id: "q09-archived-exclusion", order: 9, query: "封鎖標識", goldAliases: [], kind: "negative", note: "archived-exclusion forbidden retired" },
  { id: "q10-superseded-exclusion", order: 10, query: "撤去符号", goldAliases: [], kind: "negative", note: "superseded-exclusion forbidden old" },
  { id: "q11-orphan-raw", order: 11, query: "未参照印", goldAliases: [], kind: "negative", note: "orphan-raw no distilled note" },
  { id: "q12-no-hit", order: 12, query: "鑿鸞鬱", goldAliases: [], kind: "negative", note: "no-hit" },
];

export function rawBodyFor(utterance: string): string {
  return `User: ${utterance}\nAssistant: Noted.`;
}

export function provenanceFor(eventId: string): { source: string; observedAt: string } {
  return { source: `synthetic:b1:${eventId}`, observedAt: BASELINE_OBSERVED_AT };
}
