#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const COMMANDS = ['prep-dist', 'push', 'clean'];
const command = process.argv[2];
const env = process.argv[3];
const publishDir = 'publish';

function usage() {
  console.error('Usage:');
  console.error('  npm run prep-dist <env>');
  console.error('  npm run push <env>');
  console.error('  npm run clean');
}

if (!command || !COMMANDS.includes(command)) {
  usage();
  process.exit(1);
}

if (command === 'clean') {
  fs.rmSync(publishDir, { recursive: true, force: true });
  console.log('Cleaned publish/');
  process.exit(0);
}

if (!env) {
  console.error('Error: Environment is required');
  usage();
  process.exit(1);
}

const envDir = path.join('envs', env);
const scriptIdPath = path.join(envDir, 'scriptId');
const configPath = path.join(envDir, 'Config.gs');
const testMarkerPath = path.join(envDir, 'TEST');

if (!fs.existsSync(envDir)) {
  const available = fs.readdirSync('envs').filter(name =>
    fs.statSync(path.join('envs', name)).isDirectory()
  );
  console.error(`Error: Environment '${env}' not found`);
  console.error(`Available: ${available.join(', ')}`);
  process.exit(1);
}

const scriptId = fs.readFileSync(scriptIdPath, 'utf8').trim();
if (!scriptId) {
  console.error(`Error: ${scriptIdPath} is missing or empty`);
  process.exit(1);
}

if (!fs.existsSync(configPath)) {
  console.error(`Error: ${configPath} not found`);
  process.exit(1);
}

const isTest = fs.existsSync(testMarkerPath);
const testConfigPath = path.join(envDir, 'TestConfig.gs');

if (isTest && !fs.existsSync(testConfigPath)) {
  console.error(`Error: ${testConfigPath} not found (required for test environment)`);
  process.exit(1);
}

function prepDist() {
  console.log(`Preparing ${env} environment...`);

  fs.rmSync(publishDir, { recursive: true, force: true });
  fs.mkdirSync(publishDir, { recursive: true });

  fs.readdirSync('src')
    .filter(f => f.endsWith('.gs') || f === 'appsscript.json')
    .forEach(f => fs.copyFileSync(path.join('src', f), path.join(publishDir, f)));

  fs.copyFileSync(configPath, path.join(publishDir, 'Config.gs'));

  if (isTest) {
    const publishTestDir = path.join(publishDir, 'test');
    fs.cpSync('test', publishTestDir, { recursive: true });
    fs.copyFileSync(testConfigPath, path.join(publishTestDir, 'TestConfig.gs'));
  }

  const claspConfig = {
    scriptId,
    rootDir: './publish',
    scriptExtensions: ['.js', '.gs'],
    htmlExtensions: ['.html'],
    jsonExtensions: ['.json'],
    filePushOrder: [],
    skipSubdirectories: false
  };
  fs.writeFileSync(
    path.join(publishDir, '.clasp.json'),
    JSON.stringify(claspConfig, null, 2) + '\n'
  );

  console.log(`✓ Staged to ${publishDir}/`);
}

function push() {
  prepDist();

  console.log('Pushing to Google Apps Script...');
  try {
    execSync('clasp push', { cwd: publishDir, stdio: 'inherit' });
    console.log('✓ Push complete');
  } catch (error) {
    console.error('✗ Push failed');
    process.exit(1);
  }
}

if (command === 'prep-dist') {
  prepDist();
} else if (command === 'push') {
  push();
}
