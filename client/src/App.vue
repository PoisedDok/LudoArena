<script setup lang="ts">
import { RouterView } from 'vue-router'
import SessionExpiredModal from './components/SessionExpiredModal.vue'
</script>

<template>
  <RouterView />
  <SessionExpiredModal />
</template>
