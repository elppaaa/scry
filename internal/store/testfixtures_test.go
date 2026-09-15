package store

import "strings"

// fixtureIssueTypeIDs are the two issue types the search fixtures use; the
// ids mirror examples in specs/000-product/data-model.md (Bug 10004, Task
// 10002). Literal-only rows elsewhere (write/pages/refs) keep their own type
// ids — often "1"/"2" — and stay literal on purpose.
var fixtureIssueTypeIDs = map[string]string{"Bug": "10004", "Task": "10002"}

// newBundle builds the IssueRecord shape every search fixture shares: a
// jira-source issue row whose ExternalID/ID are the lowercased key, whose
// project is the key's prefix before the first dash, with To Do / status 1 /
// new and ago(1) timestamps. body may be "". Rows that need comments,
// labels, or other timestamps set those fields on the returned record — the
// differences stay visible at the call site instead of hiding in options.
func newBundle(key, title, issueType, body string) IssueRecord {
	ext := strings.ToLower(key)
	return IssueRecord{
		Item: Item{
			ID: "jira:" + ext, SourceID: "jira", Kind: "issue", ExternalID: ext,
			Key: key, Title: title, BodyText: body,
			CreatedAt: ago(1), UpdatedAt: ago(1),
		},
		Issue: Issue{
			ProjectKey: key[:strings.IndexByte(key, '-')],
			IssueType:  issueType, IssueTypeID: fixtureIssueTypeIDs[issueType],
			Status: "To Do", StatusID: "1", StatusCategory: "new",
		},
	}
}
