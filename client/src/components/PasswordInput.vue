<script setup lang="ts">
import { ref, useId } from 'vue'

/** A password field with a show/hide toggle. The value is only ever held in the component's v-model. */
const props = withDefaults(defineProps<{
  modelValue: string
  autocomplete?: string
  placeholder?: string
  required?: boolean
  label?: string
}>(), { autocomplete: 'current-password', placeholder: '', required: false })

const emit = defineEmits<{ 'update:modelValue': [value: string] }>()

const id = useId()
const visible = ref(false)
</script>

<template>
  <div>
    <label v-if="props.label" :for="id" class="label">{{ props.label }}</label>
    <div class="relative">
      <input
        :id="id"
        :value="props.modelValue"
        class="input pr-12"
        :type="visible ? 'text' : 'password'"
        :autocomplete="props.autocomplete"
        :placeholder="props.placeholder"
        :required="props.required"
        autocapitalize="none"
        autocorrect="off"
        spellcheck="false"
        @input="emit('update:modelValue', ($event.target as HTMLInputElement).value)"
      />
      <button
        type="button"
        class="absolute inset-y-0 right-0 w-11 flex items-center justify-center text-text-muted hover:text-text-primary"
        :aria-label="visible ? 'Hide password' : 'Show password'"
        :aria-pressed="visible"
        @click="visible = !visible"
      >
        <svg v-if="!visible" class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/>
        </svg>
        <svg v-else class="w-5 h-5" fill="none" stroke="currentColor" stroke-width="1.8" viewBox="0 0 24 24" aria-hidden="true">
          <path stroke-linecap="round" stroke-linejoin="round" d="M3 3l18 18M10.6 10.6a3 3 0 004.2 4.2M9.9 5.2A9.9 9.9 0 0112 5c6.5 0 10 7 10 7a17 17 0 01-3.2 4.2M6.6 6.6C3.7 8.4 2 12 2 12s3.5 7 10 7a9.6 9.6 0 004.1-.9"/>
        </svg>
      </button>
    </div>
  </div>
</template>
