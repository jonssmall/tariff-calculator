/**
 * Which Chapter 99 headings are applied, and which exclusion lists are open.
 *
 * These are separate on purpose. The output panel is re-rendered wholesale on
 * every change, so disclosure state cannot live in the DOM or it resets — and
 * deriving it from whether an exemption was claimed meant unchecking the last
 * one collapsed the list the user was working in, mid-decision.
 *
 * Kept as pure transitions so the rule can be tested without a browser.
 */

export interface PanelState {
  /** Headings and exemptions the user has switched on. */
  applied: Set<string>;
  /** Headings whose exclusion list is expanded. */
  expanded: Set<string>;
}

export const emptyPanel = (): PanelState => ({ applied: new Set(), expanded: new Set() });

/**
 * Default the applied set from confidence: confirmed matches are on, anything
 * needing verification is off. Expansion is cleared, because the previous
 * line's disclosures say nothing about this one.
 */
export function defaultsFor(matches: { remedy: { heading: string }; confidence: string }[]): PanelState {
  return {
    applied: new Set(matches.filter((m) => m.confidence === "confirmed").map((m) => m.remedy.heading)),
    expanded: new Set(),
  };
}

/**
 * Toggle a checkbox.
 *
 * `owner` is the heading whose exclusion list the box sits in, when it is an
 * exemption rather than a duty. Toggling one keeps its list open in either
 * direction: a user unchecking an exclusion is still deciding about it, and
 * closing the panel underneath them loses their place.
 */
export function toggleChecked(
  state: PanelState,
  heading: string,
  checked: boolean,
  owner?: string | undefined,
): PanelState {
  const applied = new Set(state.applied);
  const expanded = new Set(state.expanded);
  if (checked) applied.add(heading);
  else applied.delete(heading);
  if (owner) expanded.add(owner);
  return { applied, expanded };
}

/** Record a disclosure being opened or closed by the user. */
export function toggleDisclosure(state: PanelState, heading: string, open: boolean): PanelState {
  const expanded = new Set(state.expanded);
  if (open) expanded.add(heading);
  else expanded.delete(heading);
  return { applied: new Set(state.applied), expanded };
}
