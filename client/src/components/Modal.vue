<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId } from 'vue'

/**
 * The one dialog. A bottom sheet on a phone (never taller than the visible viewport, body scrolls, the
 * action bar stays in view above the safe area) and a centred card from `sm` up. Escape and the
 * backdrop close it, focus moves in and is restored, and the page behind does not scroll.
 */
const props = withDefaults(defineProps<{
  title: string
  subtitle?: string
  size?: 'sm' | 'md' | 'lg'
  dismissible?: boolean
}>(), { size: 'md', dismissible: true })

const emit = defineEmits<{ close: [] }>()

const titleId = useId()
const root = ref<HTMLElement | null>(null)
let previouslyFocused: Element | null = null

const widths = { sm: 'sm:max-w-sm', md: 'sm:max-w-md', lg: 'sm:max-w-lg' }

function close() {
  if (props.dismissible) emit('close')
}

function onKey(event: KeyboardEvent) {
  if (event.key === 'Escape') close()
  if (event.key !== 'Tab' || !root.value) return
  const focusable = root.value.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')
  if (focusable.length === 0) return
  const first = focusable[0]!
  const last = focusable[focusable.length - 1]!
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

onMounted(() => {
  previouslyFocused = document.activeElement
  document.body.style.overflow = 'hidden'
  document.addEventListener('keydown', onKey)
  const target = root.value?.querySelector<HTMLElement>('[data-autofocus], input:not([type=hidden]), select, textarea') ?? root.value
  target?.focus({ preventScroll: true })
})

onBeforeUnmount(() => {
  document.body.style.overflow = ''
  document.removeEventListener('keydown', onKey)
  if (previouslyFocused instanceof HTMLElement) previouslyFocused.focus({ preventScroll: true })
})
</script>

<template>
  <Teleport to="body">
    <div class="sheet-backdrop" @mousedown.self="close">
      <div ref="root" class="sheet" :class="widths[size]" role="dialog" aria-modal="true" :aria-labelledby="titleId" tabindex="-1">
        <div class="sm:hidden flex justify-center pt-2.5 pb-1 flex-shrink-0" aria-hidden="true">
          <div class="w-10 h-1 rounded-full bg-border"></div>
        </div>
        <header class="flex items-start justify-between gap-3 px-5 pt-3 pb-3 sm:pt-4 border-b border-border flex-shrink-0">
          <div class="min-w-0">
            <h2 :id="titleId" class="font-semibold text-sm leading-tight truncate">{{ title }}</h2>
            <p v-if="subtitle" class="text-xs text-text-muted mt-0.5 truncate">{{ subtitle }}</p>
          </div>
          <button v-if="dismissible" type="button" class="icon-btn -mr-2 -mt-1 flex-shrink-0" aria-label="Close" @click="emit('close')">
            <svg class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" aria-hidden="true"><path stroke-linecap="round" stroke-linejoin="round" d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </header>
        <div class="flex-1 overflow-y-auto overscroll-contain px-5 py-4 min-h-0">
          <slot />
        </div>
        <footer v-if="$slots.footer" class="px-5 pt-3 safe-bottom border-t border-border flex-shrink-0 bg-surface">
          <slot name="footer" />
        </footer>
      </div>
    </div>
  </Teleport>
</template>
