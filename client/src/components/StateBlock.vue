<script setup lang="ts">
/**
 * Loading, error and empty states for a list or panel, in one place so they look the same everywhere
 * and never leave a spinner or a blank page. Content goes in the default slot and is shown only when
 * there is something to show.
 */
withDefaults(defineProps<{
  loading?: boolean
  error?: string
  empty?: boolean
  emptyText?: string
  rows?: number
}>(), { rows: 4, emptyText: 'Nothing here yet.' })

defineEmits<{ retry: [] }>()
</script>

<template>
  <div v-if="error" class="card text-center py-8 space-y-3" role="alert">
    <p class="text-sm text-danger">{{ error }}</p>
    <button type="button" class="btn-ghost btn-sm" @click="$emit('retry')">Try again</button>
  </div>
  <div v-else-if="loading" class="space-y-2" aria-busy="true" aria-live="polite">
    <span class="sr-only">Loading</span>
    <div v-for="i in rows" :key="i" class="skeleton h-14"></div>
  </div>
  <div v-else-if="empty" class="text-center py-12 text-text-muted text-sm">{{ emptyText }}</div>
  <slot v-else />
</template>
