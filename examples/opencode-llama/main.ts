// End-to-end demo: launch an isolated microVM whose only egress is a
// host-side slicer-proxy. Phase 1 opens a wildcard so we can install
// opencode via arkade. Phase 2 drops the wildcard and pins egress to the
// llama.cpp inference endpoint, keeping only the narrow DNS-over-HTTPS
// resolver rule the guest needs (the VM runs with --no-dns), then runs
// `opencode run` through it.
//
// Pre-reqs on the host (one-shot):
//   sudo ip link add slicer-proxy0 type dummy
//   sudo ip addr add 192.168.222.1/24 dev slicer-proxy0
//   sudo ip link set slicer-proxy0 up
//
//   slicer ca init --hostgroup lab
//   slicer new --net=isolated --no-dns \
//              --allow 192.168.222.1:3128 --allow 192.168.222.1:3129 \
//              --drop 0.0.0.0/0 \
//              --copy-to-vm $PWD/slicer-agent:/usr/local/bin/slicer-agent:0755:0:0 \
//              lab > lab.yaml
//   sudo -E slicer up lab.yaml &
//   slicer proxy up --bind 192.168.222.1 --san 192.168.222.1 &
//
// SLICER_URL / SLICER_TOKEN point the SDK at slicerd.

import { SlicerClient, type VM } from '@slicervm/sdk';

const HOSTGROUP = 'lab';
const PROXY_HOST = '192.168.222.1';
const HTTP_PORT = 3128;
const HTTPS_PORT = 3129;

// LLAMACPP_HOST and LLAMA_BEARER must be supplied via env. The bearer is
// a secret; never paste it into source.
//   export LLAMACPP_HOST=your-tunnel.example.com
//   export LLAMA_BEARER=<bearer token for the inference endpoint>
const LLAMACPP_HOST = mustEnv('LLAMACPP_HOST');
const BEARER = mustEnv('LLAMA_BEARER');
const MODEL = process.env.LLAMA_MODEL ?? 'unsloth/Qwen3.6-27B-GGUF:UD-Q6_K_XL';

function mustEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.length === 0) {
    throw new Error(`required env var ${name} is not set`);
  }
  return v;
}

const GUEST_UID = 1000;
const GUEST_HOME = '/home/ubuntu';

async function main() {
  const c = SlicerClient.fromEnv();

  // 1. Mint a proxy client. The token is shown once; store it.
  const created = await c.proxy.clients.create('web-1');
  const tok = created.token!;
  console.log(`proxy client web-1 minted, token=${tok.slice(0, 12)}…`);

  // Env vars guest workloads (arkade, opencode) need to honour.
  const env = [
    `HTTP_PROXY=http://proxy:${tok}@${PROXY_HOST}:${HTTP_PORT}`,
    `HTTPS_PROXY=https://proxy:${tok}@${PROXY_HOST}:${HTTPS_PORT}`,
    'NO_PROXY=localhost,127.0.0.1',
    `HOME=${GUEST_HOME}`,
  ];

  // Everything from here on runs inside try/finally so a failed allow
  // rule or VM launch still tears down the proxy client and its rules.
  let vm: VM | undefined;
  let createdSecret = false;
  try {
    // 2. Phase 1 — broad allow so arkade can fetch opencode.
    //    The VM has no DNS (--no-dns), so the guest resolves names via
    //    DNS-over-HTTPS through the proxy. That rule stays for the whole
    //    run and is kept narrow: only POST /dns-query on cloudflare-dns.com.
    await c.proxy.allows.add({
      client: 'web-1',
      host: 'cloudflare-dns.com',
      methods: ['POST'],
      paths: ['/dns-query'],
    });
    await c.proxy.allows.add({ client: 'web-1', host: '*' });

    // 3. Launch an isolated VM. Userdata only does one thing: bring up
    //    the in-VM transparent helper pointed at our dummy-adapter proxy.
    //    The new positional shorthand composes the upstream URL for us.
    const userdata = `#!/bin/bash
set -eu
/usr/local/bin/slicer-agent proxy install ${PROXY_HOST} --token ${tok}
`;
    vm = await c.vms.create(
      HOSTGROUP,
      { userdata },
      { wait: 'userdata', waitTimeoutSec: 90 },
    );
    console.log(`VM up: ${vm.hostname}`);

    // 4. arkade is preinstalled in the slicer-systemd image; just fetch
    //    opencode through the proxy as the ubuntu user. Lands at
    //    $HOME/.arkade/bin/opencode by default — no sudo needed.
    console.log('installing opencode via arkade…');
    const install = await vm.execBuffered({
      command: 'arkade',
      args: ['get', 'opencode'],
      env,
      uid: GUEST_UID,
    });
    if (install.exitCode !== 0) {
      throw new Error(`arkade get opencode failed (exit ${install.exitCode}): ${install.stderr}`);
    }
    const okLine = install.stdout.split('\n').find((l) => l.includes('opencode')) ?? install.stdout;
    console.log(okLine.trim());

    // 5. Phase 2 — lock down.
    //
    // Secret-injection model: the real bearer never enters the VM.
    // Slicer-proxy holds it host-side as a Type=bearer secret. The
    // matching allow rule references the secret by name; on the inner
    // request the proxy strips the client's Authorization header and
    // substitutes the real bearer. The guest only ever sees the
    // placeholder we ship in opencode.json.
    console.log('locking down to llama.cpp host (plus the DoH resolver), secret stays host-side…');
    await c.proxy.secrets.create({
      name: 'llamacpp-bearer',
      host: LLAMACPP_HOST,
      type: 'bearer',
      value: BEARER,
    });
    createdSecret = true;
    await c.proxy.allows.remove('web-1', '*');
    await c.proxy.allows.add({
      client: 'web-1',
      host: LLAMACPP_HOST,
      secret: 'llamacpp-bearer',
    });

    // Egress is now exactly two hosts: the DoH resolver and the inference
    // endpoint. Fail loudly if anything else survived the wildcard removal.
    const expectedHosts = ['cloudflare-dns.com', LLAMACPP_HOST].sort().join(',');
    const remainingHosts = (await c.proxy.clients.rules('web-1')).map((r) => r.host).sort().join(',');
    if (remainingHosts !== expectedHosts) {
      throw new Error(`unexpected allow rules after lockdown: ${remainingHosts}`);
    }

    // 6. Write opencode config: a custom OpenAI-compatible provider
    //    pointing at the llama.cpp endpoint. The Authorization header
    //    is a placeholder — slicer-proxy will strip it and inject the
    //    real bearer from the host-side secret on the wire.
    const opencodeConfig = JSON.stringify(
      {
        $schema: 'https://opencode.ai/config.json',
        provider: {
          llama: {
            npm: '@ai-sdk/openai-compatible',
            name: 'Llama via slicer-proxy',
            options: {
              baseURL: `https://${LLAMACPP_HOST}/v1`,
              headers: {
                Authorization: 'Bearer placeholder-injected-by-slicer-proxy',
              },
            },
            models: {
              [MODEL]: { name: 'Qwen3.6 27B (unsloth)' },
            },
          },
        },
      },
      null,
      2,
    );

    // writeFile doesn't auto-create parents; mkdir as ubuntu first.
    await vm.execBuffered({
      command: 'mkdir',
      args: ['-p', `${GUEST_HOME}/.config/opencode`],
      uid: GUEST_UID,
    });
    await vm.fs.writeFile(`${GUEST_HOME}/.config/opencode/opencode.json`, opencodeConfig, {
      uid: GUEST_UID,
      gid: GUEST_UID,
      permissions: '0600',
    });

    // 7. Run opencode against the locked-down endpoint. opencode tries
    //    nice-to-haves like models.dev and registry.npmjs.org — those
    //    will deny in the proxy log (no allow rule), but the actual
    //    completion goes through.
    console.log('running opencode…');
    const run = await vm.execBuffered({
      command: `${GUEST_HOME}/.arkade/bin/opencode`,
      args: [
        'run',
        '--model',
        `llama/${MODEL}`,
        'In one short sentence, say hi from a sandboxed VM.',
      ],
      env,
      uid: GUEST_UID,
      cwd: GUEST_HOME,
    });
    console.log('--- opencode output ---');
    console.log(run.stdout.trimEnd());
    if (run.exitCode !== 0) {
      console.error('--- stderr ---');
      console.error(run.stderr.trimEnd());
      throw new Error(`opencode exited ${run.exitCode}`);
    }
  } finally {
    // 8. Cleanup. Always run, even on failure. The VM is absent if
    //    launch failed; the secret and proxy client go regardless.
    if (vm) {
      console.log(`deleting VM ${vm.hostname}…`);
      await vm.delete().catch((err) => console.warn('vm delete:', err));
    }
    // Only remove the secret this run created; a create that failed
    // because the name already exists must not delete the user's own.
    if (createdSecret) {
      await c.proxy.secrets
        .delete('llamacpp-bearer')
        .catch((err) => console.warn('proxy secret delete:', err));
    }
    await c.proxy.clients.delete('web-1').catch((err) => console.warn('proxy client delete:', err));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
