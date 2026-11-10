// Runs both offline test suites and fails if either one fails.
import { spawnSync } from 'node:child_process'
import path from 'node:path'

const root = import.meta.dirname
const suites = ['host.test.mjs', 'client.test.mjs']
let failed = 0

for (const suite of suites) {
  const result = spawnSync(process.execPath, [path.join(root, suite)], { stdio: 'inherit' })
  if (result.status !== 0) failed += 1
}

if (failed > 0) {
  console.error(`\n${failed} test suite(s) failed`)
  process.exit(1)
}
console.log('\nall test suites passed')
