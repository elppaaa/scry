/*
 * The two decisions the create sheet makes once a photo is in it (GDK-1879).
 *
 * Pure on purpose, and the second one is the whole round's safety property.
 * Creating an issue and attaching a file to it are two writes, and the second
 * can be refused after the first has landed — a serve whose origin took the
 * issue and then rejected the upload, a file the mirror re-read could not
 * confirm, a network that died between them. The issue exists at that point.
 * A sequencer that throws would send the screen down its catch branch and the
 * person would never be told the key of an issue that is already filed, so
 * `attachAll` does not throw at all: it returns what failed, and the caller
 * opens the issue either way.
 *
 * composer-attach.ts is the same idea for the comment composer; the two are
 * deliberately separate because the comment's questions (may Send fire, what
 * does the POST carry) have nothing to do with these.
 */

/**
 * May the create button fire.
 *
 * The title is the server's only requirement (`internal/server/write.go`
 * refuses a create with an empty summary) and the phone never asks for an
 * issue type, so there is nothing else to check.
 *
 * `uploading` is here for symmetry with composer-attach.ts's `sendReady` and
 * because the caller reads it anyway: on this screen uploads can only be in
 * flight *after* a create has landed, at which point the sheet has already
 * cleared the title, so the second clause never decides anything on its own
 * today. It is the clause that keeps deciding correctly if a future round
 * lets a pick upload before the create — which is exactly the shape
 * `sendReady` has on the other screen.
 */
export function createReady(summary: string, uploading: number): boolean {
  return summary.trim() !== '' && uploading === 0
}

/** What `attachAll` saw. `failed` is in pick order, so the first is the first. */
export interface AttachOutcome {
  /** Files the upload accepted. */
  attached: number
  /** Files it did not, by the name the screen would say in a sentence. */
  failed: { name: string }[]
}

/**
 * Upload every picked file to a key that now exists, one at a time.
 *
 * **Never throws.** That is the contract, not an implementation detail: the
 * caller has already created the issue by the time this runs, and an
 * exception here is how the key would be lost.
 *
 * Sequential rather than parallel, which is where this differs from the
 * comment composer's `handleFiles`. There the issue is open on screen and the
 * files are independent; here they all land on a key that was created
 * milliseconds ago, and a burst of concurrent multipart POSTs to a serve that
 * is still finishing the create's mirror re-read buys nothing a person can
 * see. In order also means `failed[0]` is the first file the person picked,
 * which is the one the single error line should name.
 *
 * A 502 `write_applied_mirror_stale` counts as failed here, same as in the
 * composer: the file did land, but this screen has no way to prove it and a
 * retry would attach the picture twice. The person lands on the issue and can
 * see for themselves.
 *
 * Generic over the file type so a test can drive it with a plain `{name}` and
 * a fake uploader — the sequencer never touches the bytes.
 */
export async function attachAll<F extends { name: string }>(
  key: string,
  files: readonly F[],
  upload: (key: string, file: F) => Promise<unknown>,
): Promise<AttachOutcome> {
  let attached = 0
  const failed: { name: string }[] = []
  for (const file of files) {
    try {
      await upload(key, file)
      attached += 1
    } catch {
      failed.push({ name: file.name })
    }
  }
  return { attached, failed }
}
