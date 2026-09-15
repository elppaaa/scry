/*
 * What an artifact may learn about its host (GDK-1897).
 *
 * An HTML attachment renders in a sandboxed frame on the issue/page detail,
 * and the host pushes itself in as that frame's first datasource. This
 * module is the single owner of that payload: a flat, serialisable object
 * assembled from what the detail already holds — never the description
 * ADF, never comments, never history, never anything from localStorage
 * (which holds tokens on this origin). If a field is not listed in
 * ArtifactContext, the frame has no business knowing it; widening this
 * interface is a security decision, not a feature.
 *
 * Status/priority/issue_type travel as display names because an artifact
 * draws them; status_category rides along so the same artifact can bucket
 * without keying logic on a localized name (the repo-wide display-name
 * trap). The frame is opaque-origin either way — it cannot ask for more.
 */
import type { DetailResponse, IssueLite } from './types'

/** The one message an artifact frame receives about its host. */
export interface ArtifactContext {
  kind: 'issue' | 'page'
  key: string
  /** The issue's summary / the page's title. */
  title: string
  /** Display names, for drawing. Null when the host does not have one. */
  status: string | null
  /** new|inprogress|done — the stable bucket behind `status`. */
  status_category: string | null
  priority: string | null
  assignee: string | null
  reporter: string | null
  labels: string[]
  /** Issue type name (issues only). */
  issue_type: string | null
  /** Page's space (pages only). */
  space_key: string | null
  /** Page version (pages only). */
  version: number | null
  created_at: string | null
  updated_at: string | null
  resolved_at: string | null
  /** The origin's own page for the row, when the mirror carries one. */
  url: string | null
}

/**
 * The issue an artifact is attached to. `issue` is the pool row the panel
 * header renders from — it holds the fields a drawing wants and may be
 * missing for a linked issue outside the pool, in which case those fields
 * go out null rather than being invented. `detail` supplies the key (the
 * response is keyed to the request, so it is the truth for what is open).
 */
export function issueContext(
  issue: IssueLite | null | undefined,
  detail: DetailResponse,
): ArtifactContext {
  return {
    kind: 'issue',
    key: detail.issue_key,
    title: issue?.summary ?? '',
    status: issue?.status ?? null,
    status_category: issue?.status_category ?? null,
    priority: issue?.priority ?? null,
    assignee: issue?.assignee ?? null,
    reporter: issue?.reporter ?? null,
    labels: issue?.labels ?? [],
    issue_type: issue?.issue_type ?? null,
    space_key: null,
    version: null,
    created_at: issue?.created_at ?? null,
    updated_at: issue?.updated_at ?? null,
    resolved_at: issue?.resolved_at ?? null,
    url: issue?.url ?? null,
  }
}

/*
 * There is no page producer yet: the page detail mounts no attachment
 * gallery, so nothing on a page can open an artifact. The `page` kind and
 * the page-only fields above are the frame's contract shape, reserved for
 * the round that adds that gallery — a producer with no consumer would be
 * a second copy of PageDetail's fields nobody measures.
 */
