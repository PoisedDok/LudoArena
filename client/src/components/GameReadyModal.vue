<script setup lang="ts">
import { useRouter } from 'vue-router'
import { usePingsStore } from '../stores/pings'
import Modal from './Modal.vue'

const pings = usePingsStore()
const router = useRouter()

function go() {
  const game = pings.pendingGame
  pings.clearPendingGame()
  if (game) void router.push(`/game/${game.id}`)
}
</script>

<template>
  <Modal title="Game is ready" size="sm" @close="pings.clearPendingGame()">
    <div class="text-center py-2 space-y-2">
      <div class="text-4xl" aria-hidden="true">🎲</div>
      <p class="text-sm text-text-muted">All players have joined. Open the game to get the Ludo room code.</p>
    </div>
    <template #footer>
      <div class="flex gap-3">
        <button type="button" class="btn-ghost flex-1" @click="pings.clearPendingGame()">Later</button>
        <button type="button" class="btn-primary flex-1" @click="go">Open game</button>
      </div>
    </template>
  </Modal>
</template>
