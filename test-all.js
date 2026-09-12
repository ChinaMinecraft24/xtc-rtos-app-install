#!/usr/bin/env node
/**
 * 统一测试入口：node test-all.js
 * 依次运行：单元测试 → 端到端测试 → 灰度引擎 → 真实闭环集成测试
 */
const { unitResult } = await import('./test.js')
const { e2eResult } = await import('./e2e-test.js')
const { gateResult } = await import('./test-gate.js')
const { integrationResult } = await import('./integration-test.js')

const totalPass = unitResult.pass + e2eResult.pass + gateResult.pass + (integrationResult ? integrationResult.pass : 0)
const totalFail = unitResult.fail + e2eResult.fail + gateResult.fail + (integrationResult ? integrationResult.fail : 0)
console.log(`\n★ 汇总：${totalPass} 通过, ${totalFail} 失败`)
process.exit(totalFail ? 1 : 0)
