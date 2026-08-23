package main

import (
	"sync"
	"testing"
)

// ⌘W is one accelerator over two outcomes: close the visible browse tab, or —
// when there is none — hide the app (docs/decisions/0011). The menu handler in
// main.go picks between them on this return value alone, so the false branch
// is the load-bearing half: before GDK-351's successor it was the case where
// the keystroke did nothing at all.
func TestCloseActiveReportsWhetherATabWasClosed(t *testing.T) {
	emb := &fakeEmbedder{}
	b := newBrowseTabs()
	b.bind(emb)

	if b.CloseActive() {
		t.Fatal("CloseActive() = true with no tab open; the menu handler would skip the hide")
	}

	id, err := b.Open("https://example.atlassian.net/browse/GDK-1")
	if err != nil {
		t.Fatal(err)
	}
	if !b.CloseActive() {
		t.Fatal("CloseActive() = false with a tab visible; the app would hide instead of closing the tab")
	}
	if !emb.closed(id) {
		t.Fatalf("tab %s survived CloseActive", id)
	}
	if b.CloseActive() {
		t.Fatal("CloseActive() = true after the last tab closed; active must clear")
	}
}

// A tab that is open but hidden (the SPA raised its own overlay, so it called
// Activate("")) is not what ⌘W is aimed at: the frontmost thing is the SPA.
func TestCloseActiveIgnoresAnOpenButHiddenTab(t *testing.T) {
	emb := &fakeEmbedder{}
	b := newBrowseTabs()
	b.bind(emb)

	id, err := b.Open("https://example.atlassian.net/browse/GDK-1")
	if err != nil {
		t.Fatal(err)
	}
	if err := b.Activate(""); err != nil {
		t.Fatal(err)
	}
	if b.CloseActive() {
		t.Fatal("CloseActive() = true while every tab is hidden")
	}
	if emb.closed(id) {
		t.Fatalf("tab %s was closed while hidden", id)
	}
}

// An unbound registry has no pane at all, so ⌘W must fall through to the hide
// rather than report a close it could not perform.
func TestCloseActiveIsFalseBeforeBind(t *testing.T) {
	if newBrowseTabs().CloseActive() {
		t.Fatal("CloseActive() = true on an unbound registry")
	}
}

// The menu runs on the main thread; the /desktop/browse routes run on the
// server's. CloseActive decides which tab is visible and closes it, so both
// halves have to sit under one lock — otherwise an interleaved Activate has it
// closing a tab nobody is looking at and still reporting the tab case, which
// leaves the app on screen. Meaningful under -race.
func TestCloseActiveRacesActivate(t *testing.T) {
	emb := &fakeEmbedder{}
	b := newBrowseTabs()
	b.bind(emb)
	for i := 0; i < 32; i++ {
		if _, err := b.Open("https://example.atlassian.net/browse/GDK-1"); err != nil {
			t.Fatal(err)
		}
	}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			_ = b.Activate("")
			b.SetFrame(frameRect{})
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 200; i++ {
			b.CloseActive()
		}
	}()
	wg.Wait()
}
