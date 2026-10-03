import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The port uses Replit artifact services, not Railway/Docker images. Pin actual
// production entrypoints, health probes and local Redis supervision.
const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const artifact = read('../.replit-artifact/artifact.toml');
const startup = read('../scripts/start-production.sh');
const frontend = read('../../autopips/.replit-artifact/artifact.toml');
const build = read('../build.mjs');
const services = artifact.split('[[services]]').slice(1);

describe('Replit production service configuration', () => {
  it('registers separate API and worker processes with distinct ports', () => {
    expect(services).toHaveLength(2);
    expect(services[0]).toContain('localPort = 8080');
    expect(services[1]).toContain('localPort = 3001');
  });
  it('starts supervised production entrypoints instead of dev servers', () => {
    expect(artifact).toContain('args = ["bash", "artifacts/api-server/scripts/start-production.sh", "api"]');
    expect(artifact).toContain('args = ["bash", "artifacts/api-server/scripts/start-production.sh", "worker"]');
    expect(startup).toContain('dist/$entry.mjs');
    expect(startup).toContain('entry="index"');
    expect(startup).toContain('entry="worker"');
    expect(build).toContain('src/index.ts');
    expect(build).toContain('src/imported/server/main.ts');
  });
  it('configures both startup health probes', () => {
    expect(services[0]).toContain('path = "/api/healthz"');
    expect(services[1]).toContain('path = "/worker-healthz"');
  });
  it('binds Redis to loopback and supervises both child processes', () => {
    expect(startup).toContain('--bind 127.0.0.1');
    expect(startup).toContain('--protected-mode yes');
    expect(startup).toContain('redis-cli -h 127.0.0.1 -p 6379 PING');
    expect(startup).toContain('wait -n "$redis_pid" "$app_pid"');
    expect(startup).toContain('trap cleanup EXIT');
  });
  it('serves the compiled frontend without an external hosting dependency', () => {
    expect(frontend).toContain('serve = "static"');
    expect(frontend).toContain('dist/public');
    expect(artifact + frontend).not.toMatch(/railway|vercel/i);
  });
});