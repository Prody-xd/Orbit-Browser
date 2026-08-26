#!/usr/bin/env node
'use strict';

/**
 * Lanza la app en modo prueba de humo.
 *
 * Existe para no depender de `cross-env` solo por una variable de entorno, y
 * para que `npm run smoke` funcione igual en PowerShell, cmd y bash.
 */

const { spawn } = require('node:child_process');
const electron = require('electron');

const child = spawn(electron, ['.'], {
  stdio: 'inherit',
  env: { ...process.env, VITRAL_SMOKE: '1' },
});

child.on('exit', (code) => process.exit(code ?? 1));
