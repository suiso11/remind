/**
 * F-I01-05 privacy metadata: optional, strictly-validated, backward-compatible.
 *
 * Writes (event.append / record.remember / record.correct) may carry an
 * optional `privacy` object with EXACTLY the keys {sensitivity, origin}:
 * - sensitivity: "normal" | "sensitive"
 * - origin: "conversation" | "self_activity"
 * Anything else (wrong keys, extra keys, wrong enum values, non-object) is
 * invalid => BAD_REQUEST, no side effects. Absent privacy stores NULL/NULL
 * (legacy rows read back as `privacy: null`).
 *
 * P4a: privacy is stored and returned (record.get / record.search); it is NOT
 * part of record.recall filtering or output. Derived (cultivation/consolidate)
 * summaries always use origin "self_activity"; sensitivity follows the
 * propagation rule below.
 */

export const PRIVACY_SENSITIVITIES = ["normal", "sensitive"] as const;
export const PRIVACY_ORIGINS = ["conversation", "self_activity"] as const;

export interface PrivacyMetadata {
  sensitivity: (typeof PRIVACY_SENSITIVITIES)[number];
  origin: (typeof PRIVACY_ORIGINS)[number];
}

/**
 * Parse the optional `privacy` request param.
 * undefined (absent) => null (legacy-compatible). Explicit JSON null and any
 * other invalid shape => "invalid" (caller maps to BAD_REQUEST, no side
 * effects): only absence means "omitted".
 */
export function parsePrivacyParam(
  privacy: unknown,
): PrivacyMetadata | null | "invalid" {
  if (privacy === undefined) return null;
  if (privacy === null) return "invalid";
  if (typeof privacy !== "object" || Array.isArray(privacy)) return "invalid";
  const o = privacy as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length !== 2 || !keys.includes("sensitivity") || !keys.includes("origin")) {
    return "invalid";
  }
  const sensitivity = o["sensitivity"];
  const origin = o["origin"];
  if (
    typeof sensitivity !== "string" ||
    !(PRIVACY_SENSITIVITIES as readonly string[]).includes(sensitivity)
  ) {
    return "invalid";
  }
  if (
    typeof origin !== "string" ||
    !(PRIVACY_ORIGINS as readonly string[]).includes(origin)
  ) {
    return "invalid";
  }
  return { sensitivity, origin } as PrivacyMetadata;
}

/** Rebuild a privacy object from stored nullable columns (NULL/NULL => null). */
export function privacyFromColumns(
  sensitivity: string | null | undefined,
  origin: string | null | undefined,
): PrivacyMetadata | null {
  if (sensitivity === null || sensitivity === undefined) return null;
  if (origin === null || origin === undefined) return null;
  if (!(PRIVACY_SENSITIVITIES as readonly string[]).includes(sensitivity)) return null;
  if (!(PRIVACY_ORIGINS as readonly string[]).includes(origin)) return null;
  return { sensitivity, origin } as PrivacyMetadata;
}

/**
 * F-I01-05 cultivation propagation rule (the ONE helper for all derived
 * summary/consolidated writes): "sensitive" when ANY source record is
 * sensitive; otherwise "normal" only when ALL sources carry known privacy;
 * otherwise null (unknown/legacy privacy dominates over a guess).
 */
export function deriveConsolidationPrivacy(
  sensitivities: Array<string | null>,
): PrivacyMetadata | null {
  if (sensitivities.some((s) => s === "sensitive")) {
    return { sensitivity: "sensitive", origin: "self_activity" };
  }
  if (sensitivities.length > 0 && sensitivities.every((s) => s !== null)) {
    return { sensitivity: "normal", origin: "self_activity" };
  }
  return null;
}
