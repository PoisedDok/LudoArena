<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'

defineProps<{ src: string; alt?: string }>()
const emit = defineEmits<{ close: [] }>()

function onKey(e: KeyboardEvent) {
  if (e.key === 'Escape') emit('close')
}
onMounted(() => document.addEventListener('keydown', onKey))
onBeforeUnmount(() => document.removeEventListener('keydown', onKey))
</script>

<template>
  <Teleport to="body">
    <div class="fixed inset-0 z-[60] flex items-center justify-center bg-black/90 p-4" role="dialog" aria-modal="true" aria-label="Image preview" @click="emit('close')">
      <img :src="src" :alt="alt ?? 'Screenshot'" class="max-w-full max-h-full object-contain rounded" />
      <button type="button" class="icon-btn absolute top-3 right-3 text-white hover:text-white bg-black/50" aria-label="Close preview" @click.stop="emit('close')">
        <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
    </div>
  </Teleport>
</template>
