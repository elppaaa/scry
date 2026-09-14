/*
 * The one "copy link to this issue" action, shared by the detail header
 * button and the palette (GDK-732).
 *
 * It was a closure inside DetailHeader.svelte, which is why the palette had
 * no way to offer it: an action reachable only by pointing at a 24px icon is
 * exactly the promise UX_PRINCIPLES §3 makes and this one broke. Same move
 * copy-view-link made for the toolbar (GDK-1343) — the component keeps the
 * button, this file keeps the action.
 */
import { t } from '../../lib/i18n'
import { copyText } from '../../lib/copy-text'
import { appMountPath, config, isDesktop, originTrackerName, profileName } from '../../lib/config'
import { issueOriginUrl } from '../../lib/issue-origin'
import { write } from '../../stores/write.svelte'

// Same hash the CLI's deepLinkURL / composeServeURL pass through:
// "issue=KEY" with no leading ? or #. /w/<profile> only for a named
// non-default profile (config().profile is the server's document).
function gadakIssueLink(key: string): string {
  const p = profileName(config().profile)
  const prefix = p !== 'default' ? `/w/${p}` : ''
  return `gadak://view${prefix}?issue=${key}`
}

function httpIssueLink(key: string): string {
  return `${location.origin}${appMountPath()}#/?issue=${key}`
}

/** The clipboard text for a key — the origin's page when there is one,
 *  the app links only where there is not. */
export function issueLinkText(key: string): string {
  // The origin's page for this key — the address that survives a paste into
  // chat. Same resolution as the detail key anchor (issueOriginUrl: the row's
  // stored url, else the site's /browse/KEY); null on the built-in tracker,
  // where the app links are the only shareable address.
  //
  // GDK-1858: when there is one, it is the whole clipboard. GDK-1290 put it
  // on line one and kept the app links below it, so a paste into Slack still
  // carried a gadak:// line nobody there can open — and the toast that says
  // "{tracker} link copied" was describing only the first line of what it
  // wrote. The phone already drew this boundary (mobile/src/lib/share.ts
  // refuses a non-http url outright); the desk now draws the same one.
  const originUrl = issueOriginUrl(key)
  if (originUrl) return originUrl
  // No origin page — the built-in tracker, and a Linear row the mirror has
  // no url for. Desktop has no shareable http origin (in-process webview);
  // serve/hosted copy both lines so a paste still works without the app.
  return isDesktop() ? gadakIssueLink(key) : `${gadakIssueLink(key)}\n${httpIssueLink(key)}`
}

export async function copyIssueLink(key: string): Promise<void> {
  if (await copyText(issueLinkText(key))) {
    write.toast(
      issueOriginUrl(key)
        ? t('detail.originLinkCopied', { tracker: originTrackerName() })
        : t('detail.linkCopied'),
      'success',
    )
  } else {
    write.toast(t('clipboard.copyFailed'), 'error')
  }
}
