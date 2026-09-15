import type { ArtifactContext } from '../lib/artifact-context'
import type { DetailAttachment } from '../lib/types'

class MediaViewerStore {
  attachment = $state<DetailAttachment | null>(null)
  /** The artifact's host context (GDK-1897), stored beside the attachment
   *  so the expanded frame pushes the same host the card did. Images and
   *  videos open without one; `open` without a context clears it. */
  context = $state<ArtifactContext | null>(null)

  open(attachment: DetailAttachment, context?: ArtifactContext | null): void {
    this.attachment = attachment
    this.context = context ?? null
  }

  close(): void {
    this.attachment = null
    this.context = null
  }
}

export const mediaViewer = new MediaViewerStore()
