import { describe, expect, test } from 'vitest'
import { issueContext, pageContext } from './artifact-context'
import type { DetailResponse, IssueLite, PageDetail } from './types'

/*
 * GDK-1897: artifact-context is the single owner of what an artifact frame
 * learns about its host. The contract under test is not "the fields map" —
 * it is that the payload stays small, flat and inert: it survives
 * structuredClone (so postMessage can carry it), it contains no functions
 * and no ADF/comment bodies (the two big things a detail response holds
 * that a drawing has no business seeing), and a missing pool row degrades
 * to nulls instead of invented values.
 */

// Markers planted in the fields the context must NOT carry. If one of these
// strings shows up in the serialized context, a body leaked into the frame.
const ADF_MARKER = 'ADF-BODY-MUST-NOT-LEAK'
const COMMENT_MARKER = 'COMMENT-BODY-MUST-NOT-LEAK'
const HISTORY_MARKER = 'HISTORY-BODY-MUST-NOT-LEAK'

function liteFixture(over: Partial<IssueLite> = {}): IssueLite {
  return {
    issue_key: 'STD-7',
    summary: 'Triage board renders',
    project_key: 'STD',
    status: 'In Progress',
    status_id: 'st-3',
    status_category: 'inprogress',
    issue_type: 'Bug',
    issue_type_id: 'it-1',
    priority: 'High',
    priority_id: 'pr-2',
    priority_rank: 2,
    severity: 'major',
    assignee: 'Dana',
    assignee_id: 'acc-1',
    assignee_email: 'dana@example.com',
    reporter: 'Milo',
    reporter_email: 'milo@example.com',
    labels: ['performance', 'api'],
    fix_versions: ['v1.2'],
    components: ['backend'],
    team_group: null,
    epic_key: null,
    parent_key: null,
    source_project: null,
    url: 'https://tracker.example.com/browse/STD-7',
    created_at: '2026-09-01T10:00:00.000Z',
    updated_at: '2026-09-10T09:30:00.000Z',
    resolved_at: null,
    status_changed_at: '2026-09-05T08:00:00.000Z',
    reopen_count: 0,
    reopened_at: null,
    reopen_reason: null,
    comment_count: 4,
    dev_project_number: null,
    related_project_number: null,
    environment: null,
    browser: null,
    found_version: null,
    occurrence: null,
    solution: null,
    critical_phenomenon: null,
    development_area: null,
    cs: null,
    development_test_assignee: null,
    development_test_assignee_email: null,
    development_test_result: null,
    qa_impact_state: '',
    qa_impact_label: '',
    qa_runs: [],
    qa_suites: [],
    ...over,
  }
}

function detailFixture(over: Partial<DetailResponse> = {}): DetailResponse {
  return {
    issue_key: 'STD-7',
    development_opinion: '',
    description_adf: { type: 'doc', content: [{ type: 'paragraph', text: ADF_MARKER }] },
    attachments: [],
    comments: [
      {
        comment_id: 'c1',
        author: 'Dana',
        author_email: 'dana@example.com',
        body: COMMENT_MARKER,
        raw_body: null,
        created_at: '2026-09-10T09:00:00.000Z',
      },
    ],
    history: [
      {
        at: '2026-09-05T08:00:00.000Z',
        field: 'status',
        from: HISTORY_MARKER,
        to: 'In Progress',
        by: 'Dana',
      },
    ],
    linked_issues: [],
    linked_prs: [],
    qa_context: null,
    ...over,
  }
}

function pageFixture(over: Partial<PageDetail> = {}): PageDetail {
  return {
    key: 'STD~42',
    title: 'Runbook: artifact frames',
    space_key: 'STD',
    space_name: 'Standard',
    parent_id: null,
    author: 'Milo',
    updated_at: '2026-09-12T12:00:00.000Z',
    version: 3,
    url: 'https://tracker.example.com/wiki/STD~42',
    body_adf: { type: 'doc', content: [{ type: 'paragraph', text: ADF_MARKER }] },
    body_text: ADF_MARKER,
    comments: [],
    attachments: [],
    labels: ['runbook'],
    ...over,
  }
}

describe('issueContext', () => {
  test('maps a fixture detail to the expected keys and nothing else', () => {
    const ctx = issueContext(liteFixture(), detailFixture())
    expect(ctx).toEqual({
      kind: 'issue',
      key: 'STD-7',
      title: 'Triage board renders',
      status: 'In Progress',
      status_category: 'inprogress',
      priority: 'High',
      assignee: 'Dana',
      reporter: 'Milo',
      labels: ['performance', 'api'],
      issue_type: 'Bug',
      space_key: null,
      version: null,
      created_at: '2026-09-01T10:00:00.000Z',
      updated_at: '2026-09-10T09:30:00.000Z',
      resolved_at: null,
      url: 'https://tracker.example.com/browse/STD-7',
    })
  })

  test('carries no description ADF, comment body, or history text', () => {
    const serialized = JSON.stringify(issueContext(liteFixture(), detailFixture()))
    expect(serialized).not.toContain(ADF_MARKER)
    expect(serialized).not.toContain(COMMENT_MARKER)
    expect(serialized).not.toContain(HISTORY_MARKER)
  })

  test('degrades to nulls when the pool row is missing (linked issue outside the pool)', () => {
    const ctx = issueContext(undefined, detailFixture())
    expect(ctx.key).toBe('STD-7')
    expect(ctx.title).toBe('')
    expect(ctx.status).toBeNull()
    expect(ctx.status_category).toBeNull()
    expect(ctx.labels).toEqual([])
    expect(ctx.updated_at).toBeNull()
  })
})

describe('pageContext', () => {
  test('maps the page axes and leaves the issue-only axes null', () => {
    const ctx = pageContext(pageFixture())
    expect(ctx).toEqual({
      kind: 'page',
      key: 'STD~42',
      title: 'Runbook: artifact frames',
      status: null,
      status_category: null,
      priority: null,
      assignee: null,
      reporter: 'Milo',
      labels: ['runbook'],
      issue_type: null,
      space_key: 'STD',
      version: 3,
      created_at: null,
      updated_at: '2026-09-12T12:00:00.000Z',
      resolved_at: null,
      url: 'https://tracker.example.com/wiki/STD~42',
    })
  })

  test('treats an absent labels array as empty, not undefined', () => {
    const ctx = pageContext(pageFixture({ labels: undefined }))
    expect(ctx.labels).toEqual([])
  })

  test('carries no page body', () => {
    expect(JSON.stringify(pageContext(pageFixture()))).not.toContain(ADF_MARKER)
  })
})

describe('serialisability (the postMessage contract)', () => {
  const contexts = [
    issueContext(liteFixture(), detailFixture()),
    issueContext(undefined, detailFixture()),
    pageContext(pageFixture()),
  ]

  test('round-trips through structuredClone unchanged', () => {
    for (const ctx of contexts) {
      expect(structuredClone(ctx)).toEqual(ctx)
    }
  })

  test('contains no function anywhere in the tree', () => {
    const walk = (value: unknown): void => {
      expect(typeof value === 'function').toBe(false)
      if (Array.isArray(value)) value.forEach(walk)
      else if (typeof value === 'object' && value !== null)
        Object.values(value).forEach(walk)
    }
    for (const ctx of contexts) walk(ctx)
  })
})
