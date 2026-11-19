#!/usr/bin/env node
/**
 * Writes `active=true|false` to $GITHUB_OUTPUT: does a dated known exception
 * (security/protected-refs-exception.json) currently suppress the protected-ref ALERT
 * ISSUE? The check job itself stays red either way. Malformed or missing file means
 * inactive (fail closed), so the issue is filed.
 */
import { appendFileSync, readFileSync } from 'node:fs';
import { evaluateException } from './lib/protected-refs.mjs';

let exception;
try {
  exception = JSON.parse(
    readFileSync(new URL('../security/protected-refs-exception.json', import.meta.url), 'utf8'),
  );
} catch {
  exception = undefined;
}
const { active, why } = evaluateException(exception, Date.now());
console.log(`protected-refs exception ${active ? 'ACTIVE' : 'INACTIVE'}: ${why}`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `active=${active}\n`);
