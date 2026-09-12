#!/usr/bin/env node
/** 本地校验：模拟手表端 sha256 校验逻辑（与 download-store.js verify() 对齐） */
import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'

const [,, file, expected] = process.argv
if (!file) { console.error('用法: node verify-local.js <file> <expectedSha256>'); process.exit(1) }
const buf = readFileSync(file)
const got = createHash('sha256').update(buf).digest('hex')
console.log('size:', buf.byteLength)
console.log('sha256:', got)
console.log('match:', got === (expected || ''))
