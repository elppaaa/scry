<script lang="ts"></script>

<!--
  The current value's mark, one owner for every pick sheet (GDK-1925). It
  is a shape, not a colour: the row's text stays primary so the mark reads
  as "this is what the issue has", never as "this is the actionable one"
  (the accent is the Cancel/link colour on this screen). A component
  rather than a {#snippet} because the snippet could not cross the
  component boundary the sheets took with them. The empty script is what
  makes svelte-check type it: a script-less .svelte ships no declaration,
  and every importer goes implicit-any.
-->
<svg class="tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
  <path d="M20 6 9 17l-5-5" />
</svg>

<style>
  /* The current row is marked by the tick alone. It used to be tinted with
     --color-accent-text, which is also Cancel's and every link's colour on
     this screen, so the row read as "tap me" rather than "this is current". */
  .tick {
    flex: none;
    margin-left: auto;
    width: 16px;
    height: 16px;
    color: var(--color-accent-text);
  }
</style>
