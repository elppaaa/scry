/*
 * The one "copy link to this view" action, shared by the toolbar button and
 * the palette (GDK-1343). Builds the three-line text (lib/view-link), puts it
 * on the clipboard, and says what it copied.
 */
import { t } from '../../lib/i18n'
import { copyText } from '../../lib/copy-text'
import { originTrackerName } from '../../lib/config'
import { buildViewLink } from '../../lib/view-link'
import { filters } from '../../stores/filters.svelte'
import { me } from '../../stores/me.svelte'
import { write } from '../../stores/write.svelte'

export async function copyViewLink(): Promise<void> {
  const link = await buildViewLink(filters.currentConfig(), me.email)
  if (!(await copyText(link.text))) {
    write.toast(t('clipboard.copyFailed'), 'error')
    return
  }
  // The partial toast talks about the origin's line, so it is only true when
  // there is one: a Jira-family workspace with no site address copies the app
  // links alone and has nothing for a clause to have failed to travel in.
  if (link.omitted.length && link.origin) {
    write.toast(t('filter.jqlCopiedPartial', { omitted: link.omitted.join(', ') }), 'info')
  } else {
    write.toast(
      link.origin ? t('detail.originLinkCopied', { tracker: originTrackerName() }) : t('detail.linkCopied'),
      'success',
    )
  }
}
