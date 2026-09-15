package confluence

import (
	"encoding/json"
	"testing"
)

// GDK-1900: a real Cloud site answers the attachment listing with
// extensions.fileSize as a JSON number; older responses (and the fixtures)
// carry it as a string. Both must decode, and both must yield the same size.
// FAIL-first on the string-typed field: the number payload errored with
// "cannot unmarshal number into Go struct field .extensions.fileSize of type
// string" and took the whole Confluence pass down with it.
func TestAttachmentFileSizeDecodesNumberAndString(t *testing.T) {
	cases := map[string]string{
		"number": `{"id":"1","title":"a.png","extensions":{"mimeType":"image/png","fileSize":4242}}`,
		"string": `{"id":"1","title":"a.png","extensions":{"mimeType":"image/png","fileSize":"4242"}}`,
	}
	for name, body := range cases {
		var a Attachment
		if err := json.Unmarshal([]byte(body), &a); err != nil {
			t.Fatalf("%s: decode: %v", name, err)
		}
		if got := a.Size(); got != 4242 {
			t.Errorf("%s: Size() = %d, want 4242", name, got)
		}
	}
	var absent Attachment
	if err := json.Unmarshal([]byte(`{"id":"2","title":"b.txt","extensions":{}}`), &absent); err != nil {
		t.Fatalf("absent: decode: %v", err)
	}
	if got := absent.Size(); got != 0 {
		t.Errorf("absent fileSize: Size() = %d, want 0", got)
	}
}
