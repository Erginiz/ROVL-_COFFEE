import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// Frontend tests run in jsdom against the real components — the bugs worth catching here
// (a slider that starts at zero, a card that hides the one button the operator needs) only
// exist once the component is rendered.
export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    include: ['tests/ui/**/*.test.jsx'],
    globals: true,
    restoreMocks: true
  }
})
