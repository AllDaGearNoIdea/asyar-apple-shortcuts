<script lang="ts">
  /*
   * Port of the launcher's components/feedback/EmptyState. The .text-title and
   * .text-caption typography classes it relies on are global in the launcher's
   * style.css, so they are inlined here.
   */
  import type { Snippet } from 'svelte';

  let {
    message = 'No items found',
    description,
    children,
  }: {
    message?: string;
    description?: string;
    children?: Snippet;
  } = $props();
</script>

<div class="empty-state">
  <div class="empty-state-message">{message}</div>
  {#if description}
    <div class="empty-state-description">{description}</div>
  {/if}
  {#if children}
    <div class="empty-state-actions">
      {@render children()}
    </div>
  {/if}
</div>

<style>
  .empty-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    text-align: center;
    gap: var(--space-2);
    padding: var(--space-6);
    width: 100%;
    min-height: 100%;
  }

  .empty-state-message {
    font-size: var(--font-size-base);
    font-weight: 600;
    color: var(--text-primary);
  }

  .empty-state-description {
    max-width: 240px;
    font-size: var(--font-size-xs);
    font-weight: 400;
    color: var(--text-secondary);
  }
</style>
