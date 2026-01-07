#!/usr/bin/env node

process.title = 'clos2me';

import { spawn, execSync } from 'child_process';
import net from 'net';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import yaml from 'yaml';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '../..');
const vizRoot = path.resolve(__dirname, '..');

function getPorts() {
  const localPath = path.join(projectRoot, '.ports.local.yaml');
  const configPath = path.join(projectRoot, '.ports.yaml');

  let config;
  if (fs.existsSync(localPath)) {
    config = yaml.parse(fs.readFileSync(localPath, 'utf8'));
  } else if (fs.existsSync(configPath)) {
    config = yaml.parse(fs.readFileSync(configPath, 'utf8'));
  } else {
    return { dev: 3560, api: 3561, fromConfig: false };
  }

  return {
    dev: config.ports?.dev?.port || config.ports?.dev || 3560,
    api: config.ports?.api?.port || config.ports?.api || 3561,
    fromConfig: true
  };
}

function killProcessOnPort(port) {
  try {
    execSync(`lsof -ti :${port} | xargs kill`, { stdio: 'pipe' });
    console.log(`Killed existing process on port ${port}`);
    return true;
  } catch {
    return false;
  }
}

function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.once('listening', () => {
      server.close();
      resolve(true);
    });
    server.listen(port);
  });
}

async function main() {
  const { dev: devPort, api: apiPort, fromConfig } = getPorts();

  console.log(`[debug] Ports: dev=${devPort}, api=${apiPort} (from config: ${fromConfig})`);

  // Kill existing processes if config exists
  if (fromConfig) {
    if (!(await isPortAvailable(devPort))) {
      killProcessOnPort(devPort);
    }
    if (!(await isPortAvailable(apiPort))) {
      killProcessOnPort(apiPort);
    }
    await new Promise(resolve => setTimeout(resolve, 500));
  }

  console.log(`Starting Vite on port ${devPort}`);
  console.log(`Starting API server on port ${apiPort}`);

  // Start API server with PORT env var
  const apiProc = spawn('node', ['server.js'], {
    cwd: vizRoot,
    env: { ...process.env, PORT: apiPort.toString() },
    stdio: 'inherit'
  });

  // Start Vite (pass API_PORT so vite.config.ts can configure proxy)
  const viteProc = spawn('npx', ['vite', '--port', devPort.toString(), '--host', '0.0.0.0'], {
    cwd: vizRoot,
    env: { ...process.env, API_PORT: apiPort.toString() },
    stdio: 'inherit'
  });

  // Handle cleanup
  const cleanup = () => {
    apiProc.kill();
    viteProc.kill();
    process.exit();
  };

  process.on('SIGINT', cleanup);
  process.on('SIGTERM', cleanup);

  apiProc.on('close', (code) => {
    console.log(`API server exited with code ${code}`);
    viteProc.kill();
    process.exit(code);
  });

  viteProc.on('close', (code) => {
    console.log(`Vite exited with code ${code}`);
    apiProc.kill();
    process.exit(code);
  });
}

main();
