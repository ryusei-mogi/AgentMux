#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const textExtensions = new Set([
  '.cjs',
  '.css',
  '.html',
  '.js',
  '.json',
  '.jsx',
  '.lock',
  '.md',
  '.mjs',
  '.rb',
  '.toml',
  '.ts',
  '.tsx',
  '.txt',
  '.yaml',
  '.yml'
]);

const forbiddenFileNames = new Set(['.env', 'accounts.env']);
const forbiddenPackagePatterns = [
  /^package\/\.env(?:\.|$)/,
  /^package\/accounts\.env(?:\.|$)/,
  /^package\/node_modules\//,
  /^package\/\.sisyphus\//,
  /^package\/.*\.sqlite(?:-|$|\.)/,
  /^package\/.*\.log$/
];

const secretPatterns = [
  { name: 'OpenAI-style API key', regex: /\bsk-[A-Za-z0-9_-]{12,}\b/g },
  { name: 'GitHub token', regex: /\bgh[pousr]_[A-Za-z0-9_]{20,}\b/g },
  { name: 'Google API key', regex: /\bAIza[0-9A-Za-z_-]{20,}\b/g },
  { name: 'AWS access key id', regex: /\bAKIA[0-9A-Z]{16}\b/g },
  {
    name: 'private key block',
    regex: /-----BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY-----/g
  },
  { name: 'known unsafe local bearer key', regex: new RegExp(`\\blocal-${'router'}-key\\b`, 'g') }
];

const files = gitFiles();
const findings = [];

for (const file of files) {
  const name = basename(file);
  if (forbiddenFileNames.has(name)) {
    findings.push(`${file}: forbidden local secret file`);
    continue;
  }
  if (!isTextFile(file)) continue;
  const content = readFileSync(file, 'utf8');
  for (const pattern of secretPatterns) {
    pattern.regex.lastIndex = 0;
    if (pattern.regex.test(content)) {
      findings.push(`${file}: possible ${pattern.name}`);
    }
  }
}

const packOutput = execFileSync('npm', ['pack', '--dry-run', '--json'], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'pipe']
});
const pack = JSON.parse(packOutput)[0];
for (const entry of pack.files ?? []) {
  const path = entry.path.startsWith('package/') ? entry.path : `package/${entry.path}`;
  if (forbiddenPackagePatterns.some((pattern) => pattern.test(path))) {
    findings.push(`${entry.path}: forbidden file would be published in npm package`);
  }
}

if (findings.length > 0) {
  console.error('OSS safety check failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log(`OSS safety check passed: ${files.length} repository files scanned.`);

function gitFiles() {
  const output = execFileSync(
    'git',
    ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
    { encoding: 'utf8' }
  );
  return output.split('\0').filter(Boolean);
}

function isTextFile(file) {
  if (file.startsWith('.github/')) return true;
  if (file === '.gitignore' || file === '.prettierignore') return true;
  const dot = file.lastIndexOf('.');
  return dot >= 0 && textExtensions.has(file.slice(dot));
}
