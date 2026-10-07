import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const digest = /^sha256:[a-f0-9]{64}$/;
const sha = /^[a-f0-9]{40}$/;
const indexType = "application/vnd.oci.image.index.v1+json";
const manifestType = "application/vnd.oci.image.manifest.v1+json";
const configType = "application/vnd.oci.image.config.v1+json";
const requiredServices = ["migrate", "deployment-record", "app", "cron", "generation-dispatch-worker"];
const maxObjectBytes = 1024 * 1024;
const hash = body => `sha256:${createHash("sha256").update(body).digest("hex")}`;
class GateError extends Error {}
const check = (condition, message) => { if (!condition) throw new GateError(message); };

function validate(request, policy) {
  check(policy.schema_version === "security-release-identity-v1", "unknown identity policy");
  check(policy.repository === "ghcr.io/dong-qiu/deep-insight-agent", "unapproved repository");
  check(policy.platform === "linux/amd64" && sha.test(policy.revision), "invalid policy platform/revision");
  check(/^[a-f0-9]{64}$/.test(policy.compose_sha256), "missing frozen compose hash");
  check(policy.deployment?.status === "blocked" && policy.deployment.safe_rollback === null,
    "this slice cannot grant deployment or rollback approval");
  check(/^sha-[a-f0-9]{40}$/.test(request.image_tag ?? ""), "image_tag required: sha-<40 lowercase hex>");
  check(request.image_tag === `sha-${policy.revision}`, "image_tag revision not approved");
  for (const kind of ["index", "manifest", "config"]) {
    const approved = request[`approved_${kind}_digest`];
    check(digest.test(approved ?? "") && !/^sha256:0+$/.test(approved), `${kind} digest required: sha256:<64 lowercase hex>`);
    check(approved === policy[`${kind}_digest`], `${kind} digest not approved by frozen identity policy`);
  }
}

function object(response, expected, descriptor, type) {
  const body = response.body;
  check(Buffer.isBuffer(body) && body.length <= maxObjectBytes && hash(body) === expected, "registry object bytes/digest mismatch");
  if (response.digestHeader) check(response.digestHeader === expected, "registry digest header mismatch");
  if (descriptor) check(descriptor.digest === expected && descriptor.size === body.length && descriptor.mediaType === type,
    "descriptor digest/size/mediaType mismatch");
  const result = JSON.parse(body.toString("utf8"));
  if (type !== configType) check(result.schemaVersion === 2 && result.mediaType === type, "unexpected OCI object type");
  return result;
}

function checkConfig(config, policy) {
  check(config.os === "linux" && config.architecture === "amd64" && !config.variant, "config platform mismatch");
  check(config.config?.Labels?.["org.opencontainers.image.revision"] === policy.revision, "config revision mismatch");
  const admission = config.config?.Labels?.["org.insight-agent.p1-dashboard-admission"];
  check(admission === undefined || admission === "isolated", "P1 dashboard admission rejected");
}

// Read only selected ordinary entries. Never unpack a Docker save archive.
// Seek over layer payloads so the image's size does not become a JS heap cost.
export function savedConfig(path, expectedDigest) {
  const file = openSync(path, "r");
  const entries = new Map();
  const size = statSync(path).size;
  try {
    check(size <= 4 * 1024 ** 3 && size >= 1024 && size % 512 === 0, "invalid archive size");
    let offset = 0, count = 0, ended = false;
    while (offset + 512 <= size) {
      const header = Buffer.alloc(512);
      check(readSync(file, header, 0, 512, offset) === 512, "truncated archive header");
      if (header.every(n => n === 0)) {
        const second = Buffer.alloc(512);
        check(readSync(file, second, 0, 512, offset + 512) === 512 && second.every(n => n === 0), "missing archive terminator");
        ended = true;
        break;
      }
      check(++count <= 100_000, "too many archive members");
      const field = (start, length) => header.subarray(start, start + length).toString("ascii").split("\0")[0];
      const octal = value => { check(/^ *[0-7]+ *$/.test(value), "unsupported tar number"); return parseInt(value.trim(), 8); };
      const checksum = octal(field(148, 8));
      check(checksum === header.reduce((sum, value, i) => sum + (i >= 148 && i < 156 ? 32 : value), 0), "invalid tar checksum");
      const name = [field(345, 155), field(0, 100)].filter(Boolean).join("/");
      check(name && !name.startsWith("/") && !name.split("/").some(part => part === ".." || part === "."), "unsafe archive path");
      const length = octal(field(124, 12));
      const type = field(156, 1);
      check(!["x", "g", "L", "K"].includes(type), "extended tar metadata unsupported");
      check(offset + 512 + length <= size, "truncated archive member");
      check(!entries.has(name), "duplicate archive member");
      entries.set(name, { offset: offset + 512, length, type });
      offset += 512 + Math.ceil(length / 512) * 512;
    }
    check(ended, "missing archive terminator");
    const read = name => {
      const entry = entries.get(name);
      check(entry && ["", "0"].includes(entry.type) && entry.length <= maxObjectBytes, "missing/nonregular/oversize archive object");
      const body = Buffer.alloc(entry.length);
      check(readSync(file, body, 0, body.length, entry.offset) === body.length, "truncated archive object");
      return body;
    };
    const manifests = JSON.parse(read("manifest.json").toString("utf8"));
    check(Array.isArray(manifests) && manifests.length === 1, "save must contain one platform image");
    const configPath = manifests[0].Config;
    const hex = expectedDigest.slice(7);
    check(configPath === `${hex}.json` || configPath === `blobs/sha256/${hex}`, "saved config descriptor mismatch");
    const body = read(configPath);
    check(hash(body) === expectedDigest, "pulled config bytes do not match approved config");
    return JSON.parse(body.toString("utf8"));
  } finally { closeSync(file); }
}

function run(command, args, options = {}) {
  try {
    return execFileSync(command, args, { encoding: "utf8", timeout: 180_000, maxBuffer: maxObjectBytes,
      stdio: ["ignore", "pipe", "pipe"], ...options });
  } catch {
    // No full inspect, environment or Docker stderr enters public release logs.
    throw new GateError(`release preflight command failed: ${command} ${args.filter(a => ["version", "pull", "image", "inspect", "save", "compose", "config"].includes(a)).join(" ")}`);
  }
}

async function fetchBytes(url, headers = {}) {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(30_000) });
  check(response.ok, "release evidence HTTP request failed");
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    check(size <= maxObjectBytes, "release evidence object too large");
    chunks.push(chunk);
  }
  return { body: Buffer.concat(chunks), digestHeader: response.headers.get("docker-content-digest") };
}

function registryReader(policy) {
  let token;
  const name = policy.repository.slice("ghcr.io/".length);
  return async (kind, ref) => {
    if (!token) {
      const result = await fetchBytes(`https://ghcr.io/token?service=ghcr.io&scope=repository:${name}:pull`);
      token = JSON.parse(result.body.toString("utf8")).token;
      check(typeof token === "string" && token.length > 0, "missing anonymous registry token");
    }
    return fetchBytes(`https://ghcr.io/v2/${name}/${kind === "config" ? "blobs" : "manifests"}/${ref}`, {
      Authorization: `Bearer ${token}`, Accept: [indexType, manifestType].join(", "),
    });
  };
}

/** Production workflow's preflight path. Dependencies are seams for isolated counterexamples, never CLI flags. */
export async function preflight({ request, policy, readObject = registryReader(policy),
  readCompose = async () => (await fetchBytes(`https://raw.githubusercontent.com/${policy.repository.slice("ghcr.io/".length)}/${policy.revision}/docker-compose.yml`)).body,
  run: command = run }) {
  validate(request, policy);
  const index = object(await readObject("index", request.image_tag), policy.index_digest, undefined, indexType);
  check(Array.isArray(index.manifests), "missing index descriptors");
  const platforms = index.manifests.filter(d => d.platform?.os === "linux" && d.platform?.architecture === "amd64");
  check(platforms.length === 1 && !platforms[0].platform.variant, "index must have exactly one linux/amd64 manifest");
  const manifest = object(await readObject("manifest", policy.manifest_digest), policy.manifest_digest, platforms[0], manifestType);
  check(manifest.config && typeof manifest.config === "object", "missing manifest config descriptor");
  const config = object(await readObject("config", policy.config_digest), policy.config_digest, manifest.config, configType);
  checkConfig(config, policy);
  const composeBytes = await readCompose();
  check(Buffer.isBuffer(composeBytes) && hash(composeBytes) === `sha256:${policy.compose_sha256}`, "candidate compose bytes/hash mismatch");

  const directory = mkdtempSync(join(tmpdir(), "insight-release-gate-"));
  try {
    // Supply no application secrets. Ignore all ambient Compose settings.
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("COMPOSE_") && !["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_API_VERSION"].includes(key)));
    env.DOCKER_HOST = "unix:///var/run/docker.sock";
    const image = `${policy.repository}@${policy.manifest_digest}`;
    env.INSIGHT_IMAGE = image;
    env.GIT_SHA = policy.revision;
    env.INSIGHT_IMAGE_DIGEST = policy.manifest_digest;
    const options = { cwd: directory, env };
    const docker = args => command("docker", ["--host", "unix:///var/run/docker.sock", ...args], options);
    const server = JSON.parse(docker(["version", "--format", "{{json .Server}}"]));
    check(/^1\.\d+$/.test(server.ApiVersion) && Number(server.ApiVersion.slice(2)) >= 48, "Docker API >=1.48 required for platform save");
    const composeVersion = docker(["compose", "version", "--short"]).trim();
    check(/^v?2\.\d+\.\d+(?:[-+].*)?$/.test(composeVersion), "Compose v2 required");
    docker(["pull", "--platform", policy.platform, image]);
    const inspected = JSON.parse(docker(["image", "inspect", image]));
    check(Array.isArray(inspected) && inspected.length === 1, "inspect must identify one pulled image");
    const local = inspected[0];
    check(local.Os === "linux" && local.Architecture === "amd64", "pulled platform mismatch");
    check(local.Config?.Labels?.["org.opencontainers.image.revision"] === policy.revision, "pulled revision mismatch");
    check(local.RepoDigests?.includes(image), "pulled manifest RepoDigest mismatch");
    const archive = join(directory, "image.tar");
    docker(["image", "save", "--platform", policy.platform, "--output", archive, image]);
    checkConfig(savedConfig(archive, policy.config_digest), policy);
    const composePath = join(directory, "docker-compose.yml");
    const envPath = join(directory, ".env.local");
    writeFileSync(composePath, composeBytes);
    writeFileSync(envPath, "", { mode: 0o600 });
    const composed = JSON.parse(docker(["compose", "--env-file", envPath, "-f", composePath, "config", "--format", "json"]));
    const bindings = {};
    for (const service of requiredServices) {
      check(composed.services?.[service]?.image === image, `compose service ${service} must bind approved manifest, never tag`);
      check(!composed.services[service].platform || composed.services[service].platform === policy.platform, `compose service ${service} platform mismatch`);
      bindings[service] = image;
    }
    return { schema_version: "security-release-preflight-v1", deployment_permitted: false,
      location: "isolated-runner", repository: policy.repository, revision: policy.revision, platform: policy.platform,
      index_digest: policy.index_digest, manifest_digest: policy.manifest_digest, config_digest: policy.config_digest,
      immutable_image: image, compose_sha256: policy.compose_sha256, services: bindings,
      tools: { docker: server.Version, docker_api: server.ApiVersion, compose: composeVersion } };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function main(args = process.argv.slice(2), env = process.env, dependencies = {}) {
  const output = args[0];
  if (output) rmSync(output, { force: true }); // Never reuse an earlier identity receipt after failure.
  const request = { image_tag: env.REQUESTED_IMAGE_TAG, approved_index_digest: env.APPROVED_INDEX_DIGEST,
    approved_manifest_digest: env.APPROVED_MANIFEST_DIGEST, approved_config_digest: env.APPROVED_CONFIG_DIGEST };
  const policy = dependencies.policy ?? JSON.parse(readFileSync(new URL("./security-release-policy.json", import.meta.url), "utf8"));
  const evidence = await preflight({ ...dependencies, policy, request });
  if (output) writeFileSync(output, JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  console.log(JSON.stringify(evidence));
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(`Security release identity preflight failed: ${error instanceof GateError ? error.message : "object or command response could not be verified"}; deployment blocked.`); process.exitCode = 1; });
}
