<script lang="ts">
  /*
   * Port of the launcher's root-search row (components/list/LauncherListRow
   * plus the .result-item / .result-title / .selected-result rules that live
   * in the launcher's global style.css). Extensions run in an iframe and can
   * import neither, so the markup and CSS are reproduced here.
   *
   * Dropped from the original: built-in Icon/KeyboardHint/StatusDot rendering,
   * alias formatting, and multi-select, none of which apply to this extension.
   * Tailwind utilities are expanded to plain CSS since the iframe has no
   * Tailwind build.
   */
  import type { Snippet } from 'svelte';

  let {
    selected = false,
    onclick,
    icon,
    iconFallback,
    title,
    subtitle,
    chip,
    chipTitle,
    typeLabel,
    trailing,
    ...rest
  }: {
    selected?: boolean;
    onclick?: (e: MouseEvent) => void;
    /** data: URI rendered as the row's leading tile. */
    icon?: string;
    /** Glyph drawn inside the standard icon well when `icon` is absent. */
    iconFallback?: Snippet;
    title: string;
    subtitle?: string;
    /** Inline marker after the title, styled like the launcher's alias chip. */
    chip?: string;
    chipTitle?: string;
    typeLabel?: string;
    trailing?: Snippet;
    [key: string]: any;
  } = $props();
</script>

<button
  type="button"
  class="result-item"
  class:selected-result={selected}
  {onclick}
  {...rest}
>
  <div class="row-shell">
    {#if icon}
      <img src={icon} alt="" class="row-icon-img" />
    {:else if iconFallback}
      <div class="row-icon-fallback">
        {@render iconFallback()}
      </div>
    {/if}

    <div class="row-body">
      <span class="result-title truncate">{title}</span>
      {#if subtitle}
        <span class="row-subtitle truncate">{subtitle}</span>
      {/if}
      {#if chip}
        <span class="alias-chip" title={chipTitle}>{chip}</span>
      {/if}
    </div>

    {#if trailing}
      {@render trailing()}
    {:else if typeLabel}
      <span class="row-type-label">{typeLabel}</span>
    {/if}
  </div>
</button>

<style>
  .result-item {
    width: 100%;
    text-align: left;
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: var(--space-1);
    cursor: pointer;
    padding: 0 9px;
    min-height: 40px;
    border-radius: var(--radius-xl, 12px);
    border: none;
    /* The launcher gets these from Tailwind's button preflight. */
    background: transparent;
    color: inherit;
    font: inherit;
  }

  .result-item:active {
    background-color: var(--bg-selected);
  }

  .selected-result {
    background-color: var(--bg-selected);
    box-shadow: inset 0 0 2px 0.5px var(--kbd-rim);
  }

  .row-shell {
    display: flex;
    align-items: center;
    width: 100%;
    gap: var(--space-5-5);
  }

  .row-body {
    flex: 1;
    display: flex;
    align-items: center;
    min-width: 0;
    gap: var(--space-5-5);
  }

  .result-title {
    font-size: var(--font-size-md);
    font-weight: 500;
    color: var(--text-primary);
  }

  .row-subtitle {
    font-size: var(--font-size-md);
    font-weight: 500;
    color: var(--text-secondary);
    flex-shrink: 1;
  }

  .row-type-label {
    font-size: var(--font-size-md);
    font-weight: 500;
    color: var(--text-secondary);
    flex-shrink: 0;
    margin-left: auto;
  }

  .row-icon-img {
    width: var(--space-7-5);
    height: var(--space-7-5);
    object-fit: contain;
    border-radius: var(--radius-xs);
    flex-shrink: 0;
  }

  .row-icon-fallback {
    width: var(--space-7-5);
    height: var(--space-7-5);
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-secondary);
    font-size: var(--font-size-sm);
    flex-shrink: 0;
    border-radius: var(--radius-xs);
  }

  .alias-chip {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    height: var(--space-7);
    min-width: var(--space-7);
    padding: 0 var(--space-2);
    border-radius: var(--radius-xs);
    border: 1px solid var(--border-color);
    background-color: transparent;
    color: var(--text-secondary);
    font-size: var(--font-size-xs);
    font-weight: 500;
    line-height: 1;
    letter-spacing: 0.02em;
    user-select: none;
    flex-shrink: 0;
    box-sizing: border-box;
  }

  .truncate {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
